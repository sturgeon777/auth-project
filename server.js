const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const scrypt = promisify(crypto.scrypt);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 같은 서버에서 도는 리버스 프록시(Caddy, Nginx, Cloudflare Tunnel)가 넘겨주는 실제 접속 IP를 사용
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'database.json');
const SECRET_PATH = path.join(__dirname, '.jwt-secret');
const TOKEN_EXPIRES_IN = '7d';
const LAUNCH_COOLDOWN_MS = 500;
const MAX_POINTS_PER_LAUNCH = 30;
const USERNAME_RE = /^[A-Za-z0-9가-힣_-]{2,16}$/;
// users 객체의 키로 쓰면 일반 계정처럼 저장되지 않는 이름들
const RESERVED_USERNAMES = new Set(['__proto__', 'constructor', 'prototype']);

function defaultData() {
  return { users: {}, stats: { totalGames: 0, totalPlaySeconds: 0 } };
}

function loadData() {
  if (!fs.existsSync(DB_PATH)) {
    const data = defaultData();
    saveData(data);
    return data;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch (e) {
    // 깨진 파일을 빈 데이터로 덮어쓰면 모든 계정이 사라지므로 백업부터 남긴다
    const backupPath = `${DB_PATH}.corrupt-${Date.now()}`;
    fs.copyFileSync(DB_PATH, backupPath);
    console.error(`database.json을 읽지 못해 ${backupPath}에 백업했습니다:`, e.message);
    const data = defaultData();
    saveData(data);
    return data;
  }
}

function saveData(data) {
  // 임시 파일에 쓴 뒤 교체해서, 저장 도중 서버가 꺼져도 파일이 깨지지 않게 한다
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

function getUser(db, username) {
  return typeof username === 'string' && Object.hasOwn(db.users, username) ? db.users[username] : null;
}

// ---------- 비밀번호 / 토큰 ----------

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, 'utf-8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

const JWT_SECRET = loadJwtSecret();

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// 예전 버전이 평문으로 저장한 비밀번호를 서버 시작 시 해시로 바꾼다
function migratePlaintextPasswords() {
  const db = loadData();
  let migrated = 0;
  for (const user of Object.values(db.users)) {
    if (typeof user.password === 'string') {
      const salt = crypto.randomBytes(16);
      const hash = crypto.scryptSync(user.password, salt, 64);
      user.passwordHash = `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
      delete user.password;
      migrated++;
    }
  }
  if (migrated > 0) {
    saveData(db);
    console.log(`평문 비밀번호 ${migrated}개를 해시로 변환했습니다.`);
  }
}

function issueToken(username) {
  return jwt.sign({ sub: username }, JWT_SECRET, { algorithm: 'HS256', expiresIn: TOKEN_EXPIRES_IN });
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  try {
    const { sub } = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return typeof sub === 'string' ? sub : null;
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const username = header.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null;
  if (!username || !getUser(loadData(), username)) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }
  req.username = username;
  next();
}

// ---------- 로그인 시도 제한 ----------

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map(); // `${ip}|${username}` -> { count, resetAt }

function isLoginBlocked(key) {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || now > entry.resetAt) {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count++;
  }
}

// ---------- 싱글플레이 게임 세션 ----------

const MAX_SESSION_AGE_MS = 6 * 60 * 60 * 1000;
const singleGames = new Map(); // gameId -> { username, startedAt }

// 클라이언트가 보낸 점수는 조작될 수 있어서, 서버가 잰 플레이 시간으로 불가능한 점수를 걸러낸다.
// 행성은 발사 간격(public/planet-game.js의 LAUNCH_COOLDOWN)마다 하나씩만 쏠 수 있고,
// 행성 하나로 태양까지 합치기를 끝까지 이어가도 약 28점이 최대라서 발사 수 × 30점으로 제한한다
function maxPlausibleScore(elapsedMs) {
  return (Math.floor(elapsedMs / LAUNCH_COOLDOWN_MS) + 2) * MAX_POINTS_PER_LAUNCH;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginFailures) {
    if (now > entry.resetAt) loginFailures.delete(key);
  }
  for (const [id, game] of singleGames) {
    if (now - game.startedAt > MAX_SESSION_AGE_MS) singleGames.delete(id);
  }
}, LOGIN_WINDOW_MS).unref();

// ---------- REST API ----------

app.get('/api/stats', (req, res) => {
  const db = loadData();
  res.json({
    totalPlayers: Object.keys(db.users).length,
    gamesPlayed: db.stats.totalGames || 0,
    hoursPlayed: ((db.stats.totalPlaySeconds || 0) / 3600).toFixed(1)
  });
});

app.get('/api/leaderboard', (req, res) => {
  const db = loadData();
  const sorted = Object.values(db.users)
    .sort((a, b) => b.highScore - a.highScore)
    .slice(0, 10)
    .map(u => ({ username: u.username, highScore: u.highScore }));
  res.json(sorted);
});

app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username) || RESERVED_USERNAMES.has(username)) {
    return res.status(400).json({ message: '아이디는 2~16자의 한글, 영문, 숫자, _, - 만 사용할 수 있습니다.' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
    return res.status(400).json({ message: '비밀번호는 6~100자로 입력하세요.' });
  }
  if (getUser(loadData(), username)) {
    return res.status(409).json({ message: '이미 존재하는 아이디입니다.' });
  }

  const passwordHash = await hashPassword(password);

  // 해시를 계산하는 동안 다른 요청이 파일을 바꿨을 수 있어 다시 읽는다
  const db = loadData();
  if (getUser(db, username)) {
    return res.status(409).json({ message: '이미 존재하는 아이디입니다.' });
  }
  db.users[username] = { username, passwordHash, highScore: 0 };
  saveData(db);
  res.json({ token: issueToken(username), username, highScore: 0 });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ message: '아이디와 비밀번호를 입력하세요.' });
  }

  const limitKey = `${req.ip}|${username}`;
  if (isLoginBlocked(limitKey)) {
    return res.status(429).json({ message: '로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도하세요.' });
  }

  const user = getUser(loadData(), username);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordLoginFailure(limitKey);
    return res.status(401).json({ message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  loginFailures.delete(limitKey);
  res.json({ token: issueToken(user.username), username: user.username, highScore: user.highScore });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = getUser(loadData(), req.username);
  res.json({ username: user.username, highScore: user.highScore });
});

app.post('/api/game/start', requireAuth, (req, res) => {
  // 한 사람당 진행 중인 싱글 게임은 하나만 유지
  for (const [id, game] of singleGames) {
    if (game.username === req.username) singleGames.delete(id);
  }
  const gameId = crypto.randomUUID();
  singleGames.set(gameId, { username: req.username, startedAt: Date.now() });
  res.json({ gameId });
});

app.post('/api/score', requireAuth, (req, res) => {
  const { gameId, score } = req.body || {};
  const game = singleGames.get(gameId);
  if (!game || game.username !== req.username) {
    return res.status(400).json({ message: '유효하지 않은 게임입니다.' });
  }
  singleGames.delete(gameId);

  const elapsedMs = Date.now() - game.startedAt;
  if (!Number.isInteger(score) || score < 0 || score > maxPlausibleScore(elapsedMs)) {
    return res.status(400).json({ message: '점수가 올바르지 않습니다.' });
  }

  const db = loadData();
  const user = getUser(db, req.username);
  if (score > user.highScore) user.highScore = score;
  db.stats.totalGames = (db.stats.totalGames || 0) + 1;
  db.stats.totalPlaySeconds = (db.stats.totalPlaySeconds || 0) + Math.round(elapsedMs / 1000);
  saveData(db);
  res.json({ highScore: user.highScore });
});

// ---------- 1대1 점수 대결 (Socket.io) ----------
// 각자 자기 판을 브라우저에서 플레이하고, 서버는 판 정보를 상대에게 전달하면서 점수와 시간을 관리한다.
// 승리 조건: 먼저 태양을 만든 사람. 아무도 못 만들면 점수가 높은 사람.

// 완벽하게 플레이해도 태양까지 1분 30초 가까이 걸려서 여유 있게 잡는다
const MATCH_DURATION_MS = 5 * 60 * 1000;
const MAX_BOARD_BODIES = 200;
const PLANET_TIERS = 10;
const SUN_TIER = PLANET_TIERS - 1;
// 발사할 수 있는 가장 큰 행성은 지구(4단계)라서, 태양을 만들려면 최소한 해왕성(5단계)부터 태양까지는
// 직접 합쳐야 한다. 그때 얻는 점수의 합(849점)보다 낮은 점수로 태양을 만들었다고 하면 조작으로 본다
const MIN_SUN_SCORE = [5, 6, 7, 8, 9].reduce((sum, tier) => sum + 2 ** (SUN_TIER - tier) * (tier + 1) * (tier + 2) / 2, 0);

let waitingQueue = [];
const matches = new Map(); // roomId -> match

// 소켓 연결 시 토큰을 검증하고, 이후에는 클라이언트가 보낸 이름 대신 검증된 아이디만 사용
io.use((socket, next) => {
  const username = verifyToken(socket.handshake.auth?.token);
  if (!username || !getUser(loadData(), username)) return next(new Error('unauthorized'));
  socket.data.username = username;
  next();
});

io.on('connection', (socket) => {
  socket.on('joinQueue', () => {
    if (socket.data.roomId) return;
    const username = socket.data.username;

    // 같은 계정의 다른 탭이 대기 중이면 빼서 자기 자신과 매칭되지 않게 한다
    waitingQueue = waitingQueue.filter(item => item.socket.id !== socket.id && item.username !== username);
    waitingQueue.push({ socket, username });
    socket.emit('waiting', { message: '상대를 찾는 중입니다...' });

    if (waitingQueue.length >= 2) {
      startMatch(waitingQueue.shift(), waitingQueue.shift());
    }
  });

  socket.on('cancelQueue', () => {
    removeFromQueue(socket.id);
  });

  socket.on('boardUpdate', (data) => {
    handleBoardUpdate(socket, data);
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    const match = matches.get(socket.data.roomId);
    if (match) {
      const opponent = match.players.find(p => p.socket.id !== socket.id);
      finishMatch(match, 'opponent_left', opponent.username);
    }
  });
});

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter(item => item.socket.id !== socketId);
}

function startMatch(p1, p2) {
  const roomId = `room_${p1.socket.id}_${p2.socket.id}`;
  const match = {
    roomId,
    players: [p1, p2].map(p => ({ socket: p.socket, username: p.username, score: 0, over: false })),
    startedAt: null,
    finished: false,
    timers: []
  };
  matches.set(roomId, match);

  match.players.forEach((p, i) => {
    p.socket.join(roomId);
    p.socket.data.roomId = roomId;
    p.socket.emit('matchFound', { opponent: match.players[1 - i].username, durationMs: MATCH_DURATION_MS });
  });

  // 3-2-1 카운트다운 후 시작
  let count = 3;
  io.to(roomId).emit('countdownTick', { count });
  const countdown = setInterval(() => {
    count -= 1;
    if (count > 0) {
      io.to(roomId).emit('countdownTick', { count });
      return;
    }
    clearInterval(countdown);
    match.startedAt = Date.now();
    io.to(roomId).emit('countdownTick', { count: 'START', remainingMs: MATCH_DURATION_MS });
    match.timers.push(setTimeout(() => finishMatch(match, 'time_up'), MATCH_DURATION_MS));
  }, 1000);
  match.timers.push(countdown);
}

function sanitizeBoard(data) {
  if (!data || !Array.isArray(data.b) || data.b.length > MAX_BOARD_BODIES) return null;

  const bodies = [];
  for (const item of data.b) {
    if (!Array.isArray(item) || item.length !== 3) return null;
    const [x, y, tier] = item;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(tier) || tier < 0 || tier >= PLANET_TIERS) {
      return null;
    }
    // 게임 공간은 1000x1000 (public/planet-game.js의 SIZE)
    bodies.push([Math.round(Math.min(Math.max(x, -300), 1300)), Math.round(Math.min(Math.max(y, -300), 1300)), tier]);
  }

  return {
    b: bodies,
    a: Number.isFinite(data.a) ? Math.round(data.a * 100) / 100 : 0,
    c: Number.isInteger(data.c) && data.c >= 0 && data.c < PLANET_TIERS ? data.c : 0,
    s: Number.isInteger(data.s) ? data.s : 0,
    o: data.o === true,
    u: data.u === true
  };
}

function handleBoardUpdate(socket, data) {
  const match = matches.get(socket.data.roomId);
  if (!match || !match.startedAt || match.finished) return;

  const player = match.players.find(p => p.socket.id === socket.id);
  if (!player || player.over) return;

  const board = sanitizeBoard(data);
  if (!board) return;

  // 점수는 줄어들 수 없고, 경과 시간으로 가능한 점수를 넘으면 인정하지 않는다
  if (board.s < player.score || board.s > maxPlausibleScore(Date.now() - match.startedAt)) {
    board.s = player.score;
  }
  player.score = board.s;
  if (board.o) player.over = true;
  if (board.u && player.score < MIN_SUN_SCORE) board.u = false;

  socket.to(match.roomId).emit('opponentBoard', board);

  // 먼저 태양을 만든 사람이 바로 이긴다
  if (board.u) {
    finishMatch(match, 'sun', player.username);
    return;
  }
  checkMatchEnd(match);
}

function checkMatchEnd(match) {
  const [p1, p2] = match.players;
  if (p1.over && p2.over) {
    finishMatch(match, 'both_over');
  } else if ((p1.over && p2.score > p1.score) || (p2.over && p1.score > p2.score)) {
    // 먼저 끝난 사람의 점수를 남은 사람이 이미 넘었으면 더 기다릴 필요가 없다
    finishMatch(match, 'overtaken');
  }
}

function finishMatch(match, reason, forcedWinner) {
  if (match.finished) return;
  match.finished = true;
  match.timers.forEach(clearTimeout);

  const [p1, p2] = match.players;
  const winner = forcedWinner || (p1.score === p2.score ? 'DRAW' : (p1.score > p2.score ? p1 : p2).username);

  io.to(match.roomId).emit('matchOver', {
    winner,
    reason,
    scores: match.players.map(p => ({ username: p.username, score: p.score }))
  });

  match.players.forEach(p => {
    p.socket.leave(match.roomId);
    delete p.socket.data.roomId;
  });
  matches.delete(match.roomId);

  recordMatch(match);
}

function recordMatch(match) {
  if (!match.startedAt) return;

  const db = loadData();
  const elapsedSeconds = Math.round((Date.now() - match.startedAt) / 1000);
  db.stats.totalGames = (db.stats.totalGames || 0) + 1;
  db.stats.totalPlaySeconds = (db.stats.totalPlaySeconds || 0) + elapsedSeconds * match.players.length;

  match.players.forEach(p => {
    const user = getUser(db, p.username);
    if (user && p.score > user.highScore) user.highScore = p.score;
  });

  saveData(db);
}

migratePlaintextPasswords();

const PORT = process.env.PORT || 3000;
// 외부에서는 Nginx(HTTPS)를 거쳐서만 들어오게, 같은 서버 안에서 오는 접속만 받는다
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
