const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

/* 정적 파일 제공 경로를 public 디렉터리로 수정 */
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

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});