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
const TICK_MS = 90;
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
// 먹이는 최소 3틱에 하나 먹는다고 넉넉하게 잡는다 (실제 평균은 훨씬 느림)
function maxPlausibleScore(elapsedMs) {
  return Math.floor(elapsedMs / TICK_MS / 3) * 10 + 10;
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
  if (!Number.isInteger(score) || score < 0 || score % 10 !== 0 || score > maxPlausibleScore(elapsedMs)) {
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

// ---------- 1대1 대전 (Socket.io) ----------

// 대기열 (모드별 분리: 'shared' | 'individual')
const queues = {
  shared: [],
  individual: []
};
const activeMatches = {};

const VALID_DIRS = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 }
];

function generateFood(tileCount = 40) {
  return {
    x: Math.floor(Math.random() * tileCount),
    y: Math.floor(Math.random() * tileCount)
  };
}

// 소켓 연결 시 토큰을 검증하고, 이후에는 클라이언트가 보낸 이름 대신 검증된 아이디만 사용
io.use((socket, next) => {
  const username = verifyToken(socket.handshake.auth?.token);
  if (!username || !getUser(loadData(), username)) return next(new Error('unauthorized'));
  socket.data.username = username;
  next();
});

io.on('connection', (socket) => {
  socket.on('joinQueue', (data) => {
    const mode = data?.mode === 'individual' ? 'individual' : 'shared';
    const username = socket.data.username;

    // 기존 중복 참가 제거 (같은 계정의 다른 탭 포함 — 자기 자신과 매칭되는 것 방지)
    removeFromQueues(socket.id);
    ['shared', 'individual'].forEach(m => {
      queues[m] = queues[m].filter(item => item.username !== username);
    });

    queues[mode].push({
      socket,
      username,
      mode
    });

    socket.emit('waiting', { message: '상대를 찾는 중입니다...', mode });

    // 2명 매칭 조건
    if (queues[mode].length >= 2) {
      const p1 = queues[mode].shift();
      const p2 = queues[mode].shift();
      const roomId = `room_${p1.socket.id}_${p2.socket.id}`;

      p1.socket.join(roomId);
      p2.socket.join(roomId);

      const gameState = createInitialGameState(roomId, mode, p1, p2);

      // 각 소켓에 playerIndex(0, 1) 포함하여 이벤트 전송
      p1.socket.emit('matchFound', { opponent: p2.username, mode, playerIndex: 0 });
      p2.socket.emit('matchFound', { opponent: p1.username, mode, playerIndex: 1 });

      activeMatches[roomId] = {
        gameState,
        mode,
        interval: null,
        countdownInterval: null
      };

      // 3-2-1 카운트다운 시작
      startCountdown(roomId);
    }
  });

  socket.on('cancelQueue', () => {
    removeFromQueues(socket.id);
  });

  socket.on('playerInput', (dir) => {
    // 한 칸짜리 상하좌우 이동만 허용 (순간이동, 정지 방지)
    if (!dir || !VALID_DIRS.some(d => d.dx === dir.dx && d.dy === dir.dy)) return;

    for (const roomId in activeMatches) {
      const match = activeMatches[roomId];
      const player = match.gameState.players.find(p => p.id === socket.id);
      if (player) {
        if (dir.dx !== -player.dir.dx || dir.dy !== -player.dir.dy) {
          player.nextDir = { dx: dir.dx, dy: dir.dy };
        }
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    removeFromQueues(socket.id);

    for (const roomId in activeMatches) {
      const match = activeMatches[roomId];
      const playerIndex = match.gameState.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const winner = match.gameState.players[1 - playerIndex];
        const winnerName = winner ? winner.username : 'Unknown';

        io.to(roomId).emit('matchOver', { winner: winnerName, reason: 'opponent_disconnected' });
        cleanUpMatch(roomId);
        recordStats(winnerName);
        break;
      }
    }
  });
});

function removeFromQueues(socketId) {
  ['shared', 'individual'].forEach(m => {
    const idx = queues[m].findIndex(item => item.socket.id === socketId);
    if (idx !== -1) queues[m].splice(idx, 1);
  });
}

function createInitialGameState(roomId, mode, p1, p2) {
  const tileCount = 40;

  const player1Obj = {
    id: p1.socket.id,
    username: p1.username,
    playerIndex: 0,
    color: '#3b82f6', // Player 1 고정 색상: 파란색
    snake: [{x: 10, y: 20}, {x: 9, y: 20}, {x: 8, y: 20}],
    dir: {dx: 1, dy: 0},
    nextDir: {dx: 1, dy: 0},
    score: 0,
    isDead: false
  };

  const player2Obj = {
    id: p2.socket.id,
    username: p2.username,
    playerIndex: 1,
    color: '#ef4444', // Player 2 고정 색상: 빨간색
    snake: [{x: 30, y: 20}, {x: 31, y: 20}, {x: 32, y: 20}],
    dir: {dx: -1, dy: 0},
    nextDir: {dx: -1, dy: 0},
    score: 0,
    isDead: false
  };

  if (mode === 'shared') {
    return {
      roomId,
      mode,
      tileCount,
      food: generateFood(tileCount),
      players: [player1Obj, player2Obj]
    };
  } else {
    player1Obj.food = generateFood(tileCount);
    player2Obj.food = generateFood(tileCount);

    player2Obj.snake = [{x: 10, y: 20}, {x: 9, y: 20}, {x: 8, y: 20}];
    player2Obj.dir = {dx: 1, dy: 0};
    player2Obj.nextDir = {dx: 1, dy: 0};

    return {
      roomId,
      mode,
      tileCount,
      players: [player1Obj, player2Obj]
    };
  }
}

function startCountdown(roomId) {
  const match = activeMatches[roomId];
  let count = 3;

  io.to(roomId).emit('countdownTick', { count });

  match.countdownInterval = setInterval(() => {
    count -= 1;
    if (count > 0) {
      io.to(roomId).emit('countdownTick', { count });
    } else {
      clearInterval(match.countdownInterval);
      io.to(roomId).emit('countdownTick', { count: 'START' });

      match.interval = setInterval(() => {
        updateMatchState(roomId);
      }, TICK_MS);
    }
  }, 1000);
}

function updateMatchState(roomId) {
  const match = activeMatches[roomId];
  if (!match) return;

  const state = match.gameState;
  if (state.mode === 'shared') {
    updateSharedMatch(roomId, match);
  } else {
    updateIndividualMatch(roomId, match);
  }
}

// 1. 공용 맵 모드 (먼저 죽는 사람이 패배)
function updateSharedMatch(roomId, match) {
  const state = match.gameState;
  let gameOver = false;
  let winner = null;

  state.players.forEach(p => {
    if (p.isDead) return;
    p.dir = p.nextDir;
    const head = { x: p.snake[0].x + p.dir.dx, y: p.snake[0].y + p.dir.dy };

    if (head.x < 0 || head.x >= state.tileCount || head.y < 0 || head.y >= state.tileCount) {
      p.isDead = true;
    }

    p.snake.unshift(head);

    if (head.x === state.food.x && head.y === state.food.y) {
      p.score += 10;
      state.food = generateFood(state.tileCount);
    } else {
      p.snake.pop();
    }
  });

  const [p1, p2] = state.players;
  const checkCollision = (head, snake, isSelf) => {
    const body = isSelf ? snake.slice(1) : snake;
    return body.some(part => part.x === head.x && part.y === head.y);
  };

  if (!p1.isDead) {
    if (checkCollision(p1.snake[0], p1.snake, true) || checkCollision(p1.snake[0], p2.snake, false)) {
      p1.isDead = true;
    }
  }
  if (!p2.isDead) {
    if (checkCollision(p2.snake[0], p2.snake, true) || checkCollision(p2.snake[0], p1.snake, false)) {
      p2.isDead = true;
    }
  }

  if (p1.isDead || p2.isDead) {
    gameOver = true;
    if (p1.isDead && p2.isDead) winner = 'DRAW';
    else if (p1.isDead) winner = p2.username;
    else winner = p1.username;
  }

  if (gameOver) {
    endMatch(roomId, winner);
  } else {
    io.to(roomId).emit('gameState', state);
  }
}

// 2. 독립 맵 모드 (점수 무관, 먼저 죽는 사람이 패배)
function updateIndividualMatch(roomId, match) {
  const state = match.gameState;
  let gameOver = false;
  let winner = null;

  state.players.forEach(p => {
    if (p.isDead) return;
    p.dir = p.nextDir;
    const head = { x: p.snake[0].x + p.dir.dx, y: p.snake[0].y + p.dir.dy };

    // 벽 충돌
    if (head.x < 0 || head.x >= state.tileCount || head.y < 0 || head.y >= state.tileCount) {
      p.isDead = true;
    }

    // 자기 자신 몸통 충돌
    if (p.snake.slice(1).some(part => part.x === head.x && part.y === head.y)) {
      p.isDead = true;
    }

    p.snake.unshift(head);

    // 각자 개별 먹이 처리
    if (head.x === p.food.x && head.y === p.food.y) {
      p.score += 10;
      p.food = generateFood(state.tileCount);
    } else {
      p.snake.pop();
    }
  });

  const [p1, p2] = state.players;

  // 한 명이라도 탈락 시 먼저 죽은 사람 패배 (점수 상관 없음)
  if (p1.isDead || p2.isDead) {
    gameOver = true;
    if (p1.isDead && p2.isDead) {
      winner = 'DRAW';
    } else if (p1.isDead) {
      winner = p2.username;
    } else {
      winner = p1.username;
    }
  }

  if (gameOver) {
    endMatch(roomId, winner);
  } else {
    io.to(roomId).emit('gameState', state);
  }
}

function endMatch(roomId, winner) {
  const match = activeMatches[roomId];
  if (!match) return;

  const [p1, p2] = match.gameState.players;
  recordStats(winner, p1, p2);

  io.to(roomId).emit('matchOver', { winner });
  cleanUpMatch(roomId);
}

function cleanUpMatch(roomId) {
  const match = activeMatches[roomId];
  if (match) {
    if (match.interval) clearInterval(match.interval);
    if (match.countdownInterval) clearInterval(match.countdownInterval);
    delete activeMatches[roomId];
  }
}

function recordStats(winner, p1, p2) {
  const db = loadData();
  db.stats.totalGames = (db.stats.totalGames || 0) + 1;

  [p1, p2].forEach(p => {
    const user = p && getUser(db, p.username);
    if (user && p.score > user.highScore) user.highScore = p.score;
  });

  saveData(db);
}

migratePlaintextPasswords();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
