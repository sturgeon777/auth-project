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

app.post('/api/signup', (req, res) => {
  const { username, password } = req.body;
  const db = loadData();
  if (db.users[username]) return res.status(400).json({ message: 'User already exists' });

  db.users[username] = { username, password, highScore: 0 };
  saveData(db);
  res.json({ message: 'Success' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const db = loadData();
  const user = db.users[username];
  if (!user || user.password !== password) return res.status(401).json({ message: 'Invalid credentials' });

  res.json({ token: username, username, highScore: user.highScore });
});

app.post('/api/score', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const { score, playSeconds } = req.body;
  const db = loadData();

  if (token && db.users[token]) {
    if (score > db.users[token].highScore) db.users[token].highScore = score;
  }
  db.stats.totalGames = (db.stats.totalGames || 0) + 1;
  db.stats.totalPlaySeconds = (db.stats.totalPlaySeconds || 0) + (playSeconds || 10);
  saveData(db);
  res.json({ message: 'Score updated' });
});

// 대기열 (모드별 분리: 'shared' | 'individual')
const queues = {
  shared: [],
  individual: []
};
const activeMatches = {};

function generateFood(tileCount = 40) {
  return {
    x: Math.floor(Math.random() * tileCount),
    y: Math.floor(Math.random() * tileCount)
  };
}

io.on('connection', (socket) => {
  socket.on('joinQueue', (data) => {
    const mode = data.mode === 'individual' ? 'individual' : 'shared';
    
    // 기존 중복 참가 제거
    removeFromQueues(socket.id);

    queues[mode].push({
      socket,
      username: data.username || 'Player',
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
      }, 90);
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