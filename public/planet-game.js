// 행성 합치기 게임 엔진 (물리 계산 + 그리기)
// 좌표는 모두 게임 공간(SIZE x SIZE) 기준이고, 캔버스 크기에 맞춰 줄여서 그린다.
(function (global) {
  'use strict';

  // 게임 공간 크기. 캔버스(800px)보다 넓게 잡고 줄여서 그려야 큰 행성을 발사대에 올려도 잘리지 않는다
  const SIZE = 1000;
  const C = SIZE / 2;
  const TAU = Math.PI * 2;

  const BUBBLE_R = 290;          // 행성이 머물러야 하는 원의 반지름
  const LAUNCH_R = 385;          // 발사대 궤도 반지름 (가장 큰 발사 행성이 원 밖에서 출발하고 화면 안에 들어오게)
  const GRAVITY = 1500;          // 중심으로 끌어당기는 가속도 (px/s²)
  const LAUNCH_SPEED = 700;
  const LAUNCH_COOLDOWN = 0.5;   // 초. 서버 점수 검증도 이 값을 기준으로 한다
  const OUT_LIMIT = 1.5;         // 원 밖에 이만큼 머물면 게임 오버 (초)
  const FLYING_LIMIT = 2.5;      // 발사된 행성이 원 안에 들어오기까지 봐주는 시간 (초)
  const RESTITUTION = 0.15;      // 부딪혔을 때 튕기는 정도
  const AIM_SPEED = 2.6;         // 키보드 조준 회전 속도 (rad/s)
  const STEP = 1 / 60;
  const SUBSTEPS = 8;

  // 단계마다 약 1.19배씩 커진다. 이보다 가파르면 목성~달을 한 줄로 쌓았을 때 원 안에 다 들어가지 않아
  // 태양을 만들 수 없게 된다 (1.21배 63%, 1.25배 0% / 1.19배 97%, 시뮬레이션 기준)
  const PLANETS = [
    { name: '달', r: 32, colors: ['#f2f2f2', '#9a9a9a'], craters: true },
    { name: '수성', r: 38, colors: ['#e0cdb3', '#8c7355'], craters: true },
    { name: '화성', r: 45, colors: ['#ff9b6e', '#b5381b'] },
    { name: '금성', r: 54, colors: ['#ffe8a8', '#d99a2b'] },
    { name: '지구', r: 64, colors: ['#7fd0ff', '#1e5fbf'], land: true },
    { name: '해왕성', r: 76, colors: ['#8db0ff', '#2b3fa8'] },
    { name: '천왕성', r: 91, colors: ['#c6f6f3', '#4fb3b0'] },
    { name: '토성', r: 108, colors: ['#f7e3b5', '#b8914a'], ring: true },
    { name: '목성', r: 129, colors: ['#f3d2a8', '#a0643a'], bands: true },
    { name: '태양', r: 153, colors: ['#fff8b8', '#ff9d00'], glow: true }
  ];
  const SPAWN_WEIGHTS = [40, 30, 17, 9, 4]; // 발사할 수 있는 행성은 달~지구, 작은 행성일수록 자주 나온다
  const SUN_BONUS = 100;                     // 태양 두 개가 합쳐져 사라질 때 점수

  // 새 행성(tier)을 만들었을 때 얻는 점수: 3, 6, 10, 15, ...
  function mergePoints(tier) {
    return (tier + 1) * (tier + 2) / 2;
  }

  function randomSpawnTier() {
    const total = SPAWN_WEIGHTS.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < SPAWN_WEIGHTS.length; i++) {
      roll -= SPAWN_WEIGHTS[i];
      if (roll < 0) return i;
    }
    return 0;
  }

  // 새로고침해도 같은 자리에 보이도록 고정된 시드로 별을 만든다
  const STARS = (() => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: 90 }, () => ({ x: rand() * SIZE, y: rand() * SIZE, r: 0.5 + rand() * 1.3, a: 0.3 + rand() * 0.7 }));
  })();

  class PlanetGame {
    constructor({ onScoreChange, onGameOver, onSun } = {}) {
      this.onScoreChange = onScoreChange || (() => {});
      this.onGameOver = onGameOver || (() => {});
      this.onSun = onSun || (() => {});
      this.aimDir = 0;
      this.reset();
    }

    reset() {
      this.bodies = [];
      this.effects = [];
      this.score = 0;
      this.time = 0;
      this.acc = 0;
      this.lastLaunch = -Infinity;
      this.angle = -Math.PI / 2;
      this.currentTier = randomSpawnTier();
      this.nextTier = randomSpawnTier();
      this.danger = 0;
      this.over = false;
      this.running = false;
      this.sunReached = false;
    }

    get playing() {
      return this.running && !this.over;
    }

    aimAt(x, y) {
      this.angle = Math.atan2(y - C, x - C);
    }

    canLaunch() {
      return this.playing && this.time - this.lastLaunch >= LAUNCH_COOLDOWN;
    }

    launch() {
      if (!this.canLaunch()) return false;
      const cos = Math.cos(this.angle);
      const sin = Math.sin(this.angle);
      this.bodies.push({
        tier: this.currentTier,
        x: C + cos * LAUNCH_R,
        y: C + sin * LAUNCH_R,
        vx: -cos * LAUNCH_SPEED,
        vy: -sin * LAUNCH_SPEED,
        flying: true,
        flyTime: 0,
        outTime: 0
      });
      this.lastLaunch = this.time;
      this.currentTier = this.nextTier;
      this.nextTier = randomSpawnTier();
      return true;
    }

    // 화면 프레임마다 호출. 실제 계산은 고정 간격(STEP)으로 나눠서 한다
    frame(dt) {
      this.acc = Math.min(this.acc + dt, 0.25);
      while (this.acc >= STEP) {
        this.step(STEP);
        this.acc -= STEP;
      }
    }

    step(dt) {
      this.effects.forEach(e => { e.t += dt; });
      this.effects = this.effects.filter(e => e.t < 0.45);
      if (!this.playing) return;

      this.time += dt;
      this.angle += this.aimDir * AIM_SPEED * dt;

      const h = dt / SUBSTEPS;
      for (let s = 0; s < SUBSTEPS; s++) {
        this.integrate(h);
        this.solveCollisions();
      }
      this.checkBounds(dt);
    }

    integrate(h) {
      const damping = Math.exp(-1.2 * h);
      for (const b of this.bodies) {
        const dx = C - b.x;
        const dy = C - b.y;
        const d = Math.hypot(dx, dy) || 1;
        // 중심 근처에서는 힘을 줄여서 한가운데서 떨리지 않게 한다
        const g = GRAVITY * Math.min(1, d / 60);
        b.vx = (b.vx + (dx / d) * g * h) * damping;
        b.vy = (b.vy + (dy / d) * g * h) * damping;
        b.x += b.vx * h;
        b.y += b.vy * h;
      }
    }

    solveCollisions() {
      const bodies = this.bodies;
      let removed = false;

      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        if (a.dead) continue;
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j];
          if (b.dead) continue;

          const ra = PLANETS[a.tier].r;
          const rb = PLANETS[b.tier].r;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const minDist = ra + rb;
          const dist2 = dx * dx + dy * dy;
          if (dist2 >= minDist * minDist) continue;

          if (a.tier === b.tier) {
            this.merge(a, b);
            removed = true;
            if (a.dead) break;
            continue;
          }

          const dist = Math.sqrt(dist2) || 0.01;
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = minDist - dist;
          const ma = ra * ra;
          const mb = rb * rb;
          const total = ma + mb;

          // 겹친 만큼 무게(면적)에 반비례해서 밀어낸다
          a.x -= nx * overlap * (mb / total);
          a.y -= ny * overlap * (mb / total);
          b.x += nx * overlap * (ma / total);
          b.y += ny * overlap * (ma / total);

          const relVel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (relVel < 0) {
            const impulse = (-(1 + RESTITUTION) * relVel) / (1 / ma + 1 / mb);
            a.vx -= (impulse * nx) / ma;
            a.vy -= (impulse * ny) / ma;
            b.vx += (impulse * nx) / mb;
            b.vy += (impulse * ny) / mb;
          }
        }
      }

      if (removed) this.bodies = bodies.filter(b => !b.dead);
    }

    merge(a, b) {
      const x = (a.x + b.x) / 2;
      const y = (a.y + b.y) / 2;

      if (a.tier === PLANETS.length - 1) {
        a.dead = true;
        b.dead = true;
        this.effects.push({ x, y, r: PLANETS[a.tier].r, t: 0, color: '255, 214, 90' });
        this.addScore(SUN_BONUS);
        return;
      }

      a.x = x;
      a.y = y;
      a.vx = (a.vx + b.vx) / 2;
      a.vy = (a.vy + b.vy) / 2;
      a.tier += 1;
      a.flying = false;
      a.outTime = 0;
      b.dead = true;
      this.effects.push({ x, y, r: PLANETS[a.tier].r, t: 0, color: '255, 255, 255' });
      this.addScore(mergePoints(a.tier));

      if (a.tier === PLANETS.length - 1 && !this.sunReached) {
        this.sunReached = true;
        this.onSun(this.time);
      }
    }

    checkBounds(dt) {
      let danger = 0;
      for (const b of this.bodies) {
        const r = PLANETS[b.tier].r;
        const d = Math.hypot(b.x - C, b.y - C);

        if (b.flying) {
          b.flyTime += dt;
          if (d + r < BUBBLE_R || b.flyTime > FLYING_LIMIT) b.flying = false;
          continue;
        }

        if (d > BUBBLE_R) {
          b.outTime += dt;
          danger = Math.max(danger, b.outTime / OUT_LIMIT);
          if (b.outTime >= OUT_LIMIT) {
            this.danger = 1;
            this.over = true;
            this.onGameOver(this.score);
            return;
          }
        } else {
          b.outTime = 0;
        }
      }
      this.danger = danger;
    }

    addScore(points) {
      this.score += points;
      this.onScoreChange(this.score);
    }

    // 상대에게 보내는 판 정보 (작게 줄인 형태)
    snapshot() {
      return {
        b: this.bodies.map(b => [Math.round(b.x), Math.round(b.y), b.tier]),
        a: Math.round(this.angle * 100) / 100,
        c: this.currentTier,
        s: this.score,
        o: this.over,
        u: this.sunReached
      };
    }

    view() {
      return {
        bodies: this.bodies.map(b => [b.x, b.y, b.tier]),
        angle: this.angle,
        currentTier: this.currentTier,
        nextTier: this.nextTier,
        score: this.score,
        danger: this.danger,
        effects: this.effects,
        showLauncher: this.playing,
        ready: this.canLaunch()
      };
    }
  }

  function drawPlanet(ctx, x, y, tier, radius) {
    const p = PLANETS[tier];
    const r = radius || p.r;
    // 고리가 너무 넓으면 토성이 다음 단계인 목성보다 커 보이므로 행성 폭을 조금만 넘게 그린다
    const ringRx = r * 1.22;
    const ringRy = r * 0.3;
    const ringTilt = -0.35;

    ctx.save();

    if (p.ring) {
      // 고리의 뒤쪽 절반은 행성보다 먼저 그린다
      ctx.beginPath();
      ctx.ellipse(x, y, ringRx, ringRy, ringTilt, Math.PI, TAU);
      ctx.strokeStyle = 'rgba(214, 180, 120, 0.9)';
      ctx.lineWidth = Math.max(2, r * 0.14);
      ctx.stroke();
    }

    if (p.glow) {
      ctx.shadowColor = 'rgba(255, 170, 0, 0.9)';
      ctx.shadowBlur = r * 0.6;
    }

    const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    grad.addColorStop(0, p.colors[0]);
    grad.addColorStop(1, p.colors[1]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    if (p.craters) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.13)';
      [[-0.45, 0.35, 0.22], [0.5, -0.4, 0.16], [0.35, 0.55, 0.12]].forEach(([ox, oy, cr]) => {
        ctx.beginPath();
        ctx.arc(x + ox * r, y + oy * r, cr * r, 0, TAU);
        ctx.fill();
      });
    }
    if (p.land) {
      ctx.fillStyle = 'rgba(76, 175, 80, 0.85)';
      [[-0.45, -0.3, 0.38], [0.45, 0.4, 0.32], [0.55, -0.55, 0.2]].forEach(([ox, oy, cr]) => {
        ctx.beginPath();
        ctx.arc(x + ox * r, y + oy * r, cr * r, 0, TAU);
        ctx.fill();
      });
    }
    if (p.bands) {
      ctx.fillStyle = 'rgba(130, 70, 35, 0.3)';
      [-0.55, -0.15, 0.3, 0.62].forEach(k => ctx.fillRect(x - r, y + k * r, r * 2, r * 0.13));
    }
    ctx.restore();

    if (p.ring) {
      ctx.beginPath();
      ctx.ellipse(x, y, ringRx, ringRy, ringTilt, 0, Math.PI);
      ctx.strokeStyle = 'rgba(214, 180, 120, 0.95)';
      ctx.lineWidth = Math.max(2, r * 0.14);
      ctx.stroke();
    }

    // 귀여운 얼굴
    const eyeR = Math.max(1.3, r * 0.08);
    ctx.fillStyle = 'rgba(25, 25, 45, 0.85)';
    ctx.beginPath();
    ctx.arc(x - r * 0.28, y - r * 0.05, eyeR, 0, TAU);
    ctx.arc(x + r * 0.28, y - r * 0.05, eyeR, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y + r * 0.1, r * 0.17, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.strokeStyle = 'rgba(25, 25, 45, 0.85)';
    ctx.lineWidth = Math.max(1.1, r * 0.05);
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.restore();
  }

  function drawBoard(ctx, view, { isLight = false, hud = true, message = '', subMessage = '' } = {}) {
    const scale = ctx.canvas.width / SIZE;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    const bg = ctx.createRadialGradient(C, C, 40, C, C, SIZE * 0.75);
    if (isLight) {
      bg.addColorStop(0, '#f6f3ff');
      bg.addColorStop(1, '#d6daf0');
    } else {
      bg.addColorStop(0, '#161d42');
      bg.addColorStop(1, '#03040c');
    }
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.fillStyle = isLight ? '#6a6aa0' : '#ffffff';
    for (const s of STARS) {
      ctx.globalAlpha = s.a * (isLight ? 0.35 : 1);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 버블
    const danger = view.danger || 0;
    ctx.beginPath();
    ctx.arc(C, C, BUBBLE_R, 0, TAU);
    ctx.fillStyle = isLight ? 'rgba(255, 255, 255, 0.55)' : 'rgba(120, 150, 255, 0.07)';
    ctx.fill();
    ctx.lineWidth = 4;
    if (danger > 0) {
      const pulse = 0.5 + 0.5 * Math.abs(Math.sin(Date.now() / 110));
      ctx.strokeStyle = `rgba(255, 60, 90, ${0.4 + 0.6 * pulse})`;
    } else {
      ctx.strokeStyle = isLight ? 'rgba(80, 90, 160, 0.5)' : 'rgba(140, 170, 255, 0.55)';
    }
    ctx.stroke();

    // 발사대 궤도
    ctx.beginPath();
    ctx.arc(C, C, LAUNCH_R, 0, TAU);
    ctx.setLineDash([6, 10]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = isLight ? 'rgba(80, 90, 160, 0.25)' : 'rgba(255, 255, 255, 0.15)';
    ctx.stroke();
    ctx.setLineDash([]);

    for (const [x, y, tier] of view.bodies) drawPlanet(ctx, x, y, tier);

    for (const e of view.effects || []) {
      const p = e.t / 0.45;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * (1 + p * 0.9), 0, TAU);
      ctx.strokeStyle = `rgba(${e.color}, ${1 - p})`;
      ctx.lineWidth = 6 * (1 - p) + 1;
      ctx.stroke();
    }

    if (view.showLauncher) {
      const lx = C + Math.cos(view.angle) * LAUNCH_R;
      const ly = C + Math.sin(view.angle) * LAUNCH_R;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(C, C);
      ctx.setLineDash([4, 8]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = isLight ? 'rgba(60, 60, 120, 0.35)' : 'rgba(255, 255, 255, 0.3)';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = view.ready ? 1 : 0.45;
      drawPlanet(ctx, lx, ly, view.currentTier);
      ctx.globalAlpha = 1;
    }

    if (hud) {
      ctx.fillStyle = isLight ? '#1a1a3a' : '#ffffff';
      ctx.font = '900 38px "Arial Black", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`SCORE ${view.score}`, 30, 28);

      if (view.nextTier !== undefined && view.showLauncher) {
        ctx.textAlign = 'right';
        ctx.font = '800 22px sans-serif';
        ctx.fillText('NEXT', SIZE - 30, 33);
        drawPlanet(ctx, SIZE - 125, 45, view.nextTier, 28);
      }
    }

    if (message) {
      ctx.fillStyle = isLight ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(0, C - 112, SIZE, subMessage ? 225 : 162);
      ctx.fillStyle = isLight ? '#1a1a3a' : '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 70px "Arial Black", sans-serif';
      ctx.fillText(message, C, C - 35);
      if (subMessage) {
        ctx.font = '700 30px sans-serif';
        ctx.fillText(subMessage, C, C + 50);
      }
    }

    ctx.restore();
  }

  // 오른쪽 패널에 행성 성장 순서를 그린다
  function drawPlanetChain(ctx, isLight) {
    const { width, height } = ctx.canvas;
    ctx.clearRect(0, 0, width, height);
    const perRow = 5;
    const cellW = width / perRow;
    PLANETS.forEach((p, i) => {
      const row = Math.floor(i / perRow);
      const cx = cellW * (i % perRow) + cellW / 2;
      const cy = 26 + row * 62;
      drawPlanet(ctx, cx, cy, i, 7 + i * 1.5);
      ctx.fillStyle = isLight ? '#333333' : '#222222';
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.name, cx, cy + 34);
    });
  }

  global.PlanetGame = PlanetGame;
  global.PlanetGame.drawBoard = drawBoard;
  global.PlanetGame.drawPlanetChain = drawPlanetChain;
  global.PlanetGame.PLANETS = PLANETS;
  global.PlanetGame.SIZE = SIZE;
})(window);
