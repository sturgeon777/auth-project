const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static('public')); // public 폴더 안의 웹 static 파일 제공

const JWT_SECRET = 'your-secret-key-change-this';
const usersDB = new Map();

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 100000, 64, 'sha512', (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '인증 토큰이 누락되었습니다.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '유효하지 않은 토큰입니다.' });
    req.user = user;
    next();
  });
}

// REST API
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
  if (usersDB.has(username)) return res.status(409).json({ error: '이미 존재하는 계정입니다.' });

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  usersDB.set(username, { username, salt, hash, highScore: 0 });

  return res.status(201).json({ message: '회원가입 완료' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = usersDB.get(username);
  if (!user) return res.status(400).json({ error: '존재하지 않는 계정입니다.' });

  const hash = await hashPassword(password, user.salt);
  if (hash !== user.hash) return res.status(400).json({ error: '비밀번호가 일치하지 않습니다.' });

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '2h' });
  return res.json({ message: '로그인 성공', token, username: user.username, highScore: user.highScore });
});

app.post('/api/score', authenticateToken, (req, res) => {
  const { score } = req.body;
  const user = usersDB.get(req.user.username);
  if (user && score > user.highScore) {
    user.highScore = score;
  }
  return res.json({ message: '점수 업데이트 완료', highScore: user ? user.highScore : 0 });
});

app.get('/api/leaderboard', (req, res) => {
  const leaderboard = Array.from(usersDB.values())
    .map(u => ({ username: u.username, highScore: u.highScore }))
    .sort((a, b) => b.highScore - a.highScore)
    .slice(0, 10);
  return res.json(leaderboard);
});

// Socket.io 1v1 매치메이킹
const matchQueue = [];

io.on('connection', (socket) => {
  socket.on('join_queue', (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.username = decoded.username;
      
      if (!matchQueue.some(s => s.id === socket.id)) {
        matchQueue.push(socket);
      }

      if (matchQueue.length >= 2) {
        const player1 = matchQueue.shift();
        const player2 = matchQueue.shift();
        const roomId = `room_${player1.id}_${player2.id}`;

        player1.join(roomId);
        player2.join(roomId);

        io.to(roomId).emit('match_found', {
          roomId,
          players: [player1.username, player2.username]
        });
      }
    } catch (err) {
      socket.emit('error_msg', '인증 실패');
    }
  });

  socket.on('player_move', ({ roomId, direction }) => {
    socket.to(roomId).emit('opponent_move', { username: socket.username, direction });
  });

  socket.on('disconnect', () => {
    const idx = matchQueue.indexOf(socket);
    if (idx !== -1) matchQueue.splice(idx, 1);
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));