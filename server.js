const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'database.json');

function loadData() {
  if (!fs.existsSync(DB_PATH)) {
    const defaultData = { users: {}, stats: { totalGames: 0, totalPlaySeconds: 0 } };
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch (e) {
    return { users: {}, stats: { totalGames: 0, totalPlaySeconds: 0 } };
  }
}

function saveData(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// REST API
app.get('/api/stats', (req, res) => {
  const db = loadData();
  const totalPlayers = Object.keys(db.users).length;
  const gamesPlayed = db.stats.totalGames || 0;
  const hoursPlayed = ((db.stats.totalPlaySeconds || 0) / 3600).toFixed(1);

  res.json({ totalPlayers, gamesPlayed, hoursPlayed });
});

app.get('/api/leaderboard', (req, res) => {
  const db = loadData();
  const sorted = Object.values(db.users)
    .sort((a, b) => b.highScore - a.highScore)
    .slice(0, 10)
    .map(u => ({ username: u.username, highScore: u.highScore }));
  res.json(sorted);
});

app.post('/api/signup', (req, res) => {
  const { username, password } = req.body;
  const db = loadData();

  if (db.users[username]) {
    return res.status(400).json({ message: 'User already exists' });
  }

  db.users[username] = { username, password, highScore: 0 };
  saveData(db);
  res.json({ message: 'Success' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const db = loadData();
  const user = db.users[username];

  if (!user || user.password !== password) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  res.json({ token: username, username, highScore: user.highScore });
});

app.post('/api/score', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const { score, playSeconds } = req.body;
  const db = loadData();

  if (token && db.users[token]) {
    if (score > db.users[token].highScore) {
      db.users[token].highScore = score;
    }
  }

  db.stats.totalGames = (db.stats.totalGames || 0) + 1;
  db.stats.totalPlaySeconds = (db.stats.totalPlaySeconds || 0) + (playSeconds || 10);
  saveData(db);

  res.json({ message: 'Score updated' });
});

// 1대1 매칭 및 Socket.io 실시간 게임 로직
const matchmakingQueue = [];
const activeMatches = {};

function generateFood(tileCount = 40) {
  return {
    x: Math.floor(Math.random() * tileCount),
    y: Math.floor(Math.random() * tileCount)
  };
}

io.on('connection', (socket) => {
  socket.on('joinQueue', (data) => {
    // 중복 등록 방지
    const existingIndex = matchmakingQueue.findIndex(item => item.socket.id === socket.id);
    if (existingIndex !== -1) return;

    matchmakingQueue.push({
      socket,
      username: data.username || 'Player',
      skin: data.skin || 'neon'
    });

    socket.emit('waiting', { message: '상대를 찾는 중입니다...' });

    // 2명이 대기열에 모이면 매칭 실행
    if (matchmakingQueue.length >= 2) {
      const player1 = matchmakingQueue.shift();
      const player2 = matchmakingQueue.shift();
      const roomId = `room_${player1.socket.id}_${player2.socket.id}`;

      player1.socket.join(roomId);
      player2.socket.join(roomId);

      const gameState = {
        roomId,
        tileCount: 40,
        food: generateFood(40),
        players: [
          {
            id: player1.socket.id,
            username: player1.username,
            snake: [{x: 10, y: 20}, {x: 9, y: 20}, {x: 8, y: 20}],
            dir: {dx: 1, dy: 0},
            nextDir: {dx: 1, dy: 0},
            score: 0
          },
          {
            id: player2.socket.id,
            username: player2.username,
            snake: [{x: 30, y: 20}, {x: 31, y: 20}, {x: 32, y: 20}],
            dir: {dx: -1, dy: 0},
            nextDir: {dx: -1, dy: 0},
            score: 0
          }
        ]
      };

      player1.socket.emit('matchFound', { opponent: player2.username });
      player2.socket.emit('matchFound', { opponent: player1.username });

      // 매칭 게임 루프 생성 (90ms 프레임)
      const interval = setInterval(() => {
        updateMatchState(roomId);
      }, 90);

      activeMatches[roomId] = {
        gameState,
        interval,
        p1Socket: player1.socket,
        p2Socket: player2.socket
      };
    }
  });

  socket.on('cancelQueue', () => {
    const index = matchmakingQueue.findIndex(item => item.socket.id === socket.id);
    if (index !== -1) {
      matchmakingQueue.splice(index, 1);
    }
  });

  socket.on('playerInput', (dir) => {
    for (const roomId in activeMatches) {
      const match = activeMatches[roomId];
      const player = match.gameState.players.find(p => p.id === socket.id);
      if (player) {
        if (dir.dx !== -player.dir.dx || dir.dy !== -player.dir.dy) {
          player.nextDir = dir;
        }
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    const qIndex = matchmakingQueue.findIndex(item => item.socket.id === socket.id);
    if (qIndex !== -1) matchmakingQueue.splice(qIndex, 1);

    for (const roomId in activeMatches) {
      const match = activeMatches[roomId];
      const playerIndex = match.gameState.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const winner = match.gameState.players[1 - playerIndex];
        const winnerName = winner ? winner.username : 'Unknown';
        
        io.to(roomId).emit('matchOver', { winner: winnerName });
        clearInterval(match.interval);
        
        // 통계 업데이트
        recordMatchStats(winnerName);
        delete activeMatches[roomId];
        break;
      }
    }
  });
});

function updateMatchState(roomId) {
  const match = activeMatches[roomId];
  if (!match) return;

  const state = match.gameState;
  let gameOver = false;
  let winner = null;

  // 플레이어 이동 처리
  state.players.forEach(p => {
    p.dir = p.nextDir;
    const head = { x: p.snake[0].x + p.dir.dx, y: p.snake[0].y + p.dir.dy };

    // 벽 충돌 체크
    if (head.x < 0 || head.x >= state.tileCount || head.y < 0 || head.y >= state.tileCount) {
      gameOver = true;
    }

    p.snake.unshift(head);

    // 먹이 충돌 체크
    if (head.x === state.food.x && head.y === state.food.y) {
      p.score += 10;
      state.food = generateFood(state.tileCount);
    } else {
      p.snake.pop();
    }
  });

  // 몸통 충돌 및 상호 충돌 체크
  const [p1, p2] = state.players;
  if (!gameOver) {
    const p1Head = p1.snake[0];
    const p2Head = p2.snake[0];

    const checkCollision = (head, snake, isSelf) => {
      const body = isSelf ? snake.slice(1) : snake;
      return body.some(part => part.x === head.x && part.y === head.y);
    };

    const p1Dead = checkCollision(p1Head, p1.snake, true) || checkCollision(p1Head, p2.snake, false);
    const p2Dead = checkCollision(p2Head, p2.snake, true) || checkCollision(p2Head, p1.snake, false);

    if (p1Dead && p2Dead) {
      gameOver = true;
      winner = 'DRAW';
    } else if (p1Dead) {
      gameOver = true;
      winner = p2.username;
    } else if (p2Dead) {
      gameOver = true;
      winner = p1.username;
    }
  }

  if (gameOver) {
    if (!winner) {
      if (p1.score > p2.score) winner = p1.username;
      else if (p2.score > p1.score) winner = p2.username;
      else winner = 'DRAW';
    }

    // 파일 DB 통계 업데이트 및 저장
    recordMatchStats(winner, p1, p2);

    io.to(roomId).emit('matchOver', { winner });
    clearInterval(match.interval);
    delete activeMatches[roomId];
  } else {
    io.to(roomId).emit('gameState', state);
  }
}

function recordMatchStats(winner, p1, p2) {
  const db = loadData();
  db.stats.totalGames = (db.stats.totalGames || 0) + 1;
  
  if (p1 && db.users[p1.username] && p1.score > db.users[p1.username].highScore) {
    db.users[p1.username].highScore = p1.score;
  }
  if (p2 && db.users[p2.username] && p2.score > db.users[p2.username].highScore) {
    db.users[p2.username].highScore = p2.score;
  }
  
  saveData(db);
}

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});