'use strict';

/* =====================================================================
   CRIMSON — a very easy top-down survival shooter
   Move: WASD / arrows · Aim: mouse · Fire: hold left mouse button
   P — pause · M — mute · R — restart (after death)
   ===================================================================== */

/* ---------------- canvas ---------------- */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, vignette = null;

function makeVignette() {
  const c = document.createElement('canvas');
  c.width = Math.max(1, W);
  c.height = Math.max(1, H);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42,
                                       W / 2, H / 2, Math.max(W, H) * 0.72);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  return c;
}

function resize() {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
  vignette = makeVignette();
}
window.addEventListener('resize', resize);
resize();

/* ---------------- helpers ---------------- */
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const dist2 = (ax, ay, bx, by) => {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
};
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fmtTime(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/* ---------------- audio (tiny synth, no assets) ---------------- */
let audioCtx = null, master = null, muted = false;

function initAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  master = audioCtx.createGain();
  master.gain.value = 0.5;
  master.connect(audioCtx.destination);
}

function sfx(freq, endFreq, dur, type, vol) {
  if (!audioCtx || muted) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain);
  gain.connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const snd = {
  shoot: () => sfx(620, 210, 0.07, 'square', 0.035),
  hit:   () => sfx(300, 140, 0.05, 'triangle', 0.05),
  kill:  () => sfx(170, 40, 0.18, 'sawtooth', 0.07),
  hurt:  () => sfx(130, 55, 0.25, 'square', 0.12),
  over:  () => sfx(220, 30, 1.1, 'sawtooth', 0.15),
};

/* ---------------- input ---------------- */
const keys = Object.create(null);
const mouse = { x: W / 2, y: H / 2, down: false };

window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyP' && state === 'playing') paused = !paused;
  if (e.code === 'KeyM') muted = !muted;
  if (e.code === 'KeyR' && state === 'over') startGame();
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  initAudio();
  if (state === 'menu') { startGame(); return; }
  if (state === 'over') { if (overTimer > 0.6) startGame(); return; }
  mouse.down = true;
});
window.addEventListener('mouseup', () => { mouse.down = false; });
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  mouse.down = false;
  if (state === 'playing') paused = true;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------------- world (decorative props, no collisions) ---------------- */
const WORLD = 3200;    // world is WORLD x WORLD pixels, camera follows the player
const GRID = 130;

const props = [];
(function generateProps() {
  const rng = mulberry32(20261024);
  for (let i = 0; i < 70; i++) {
    props.push({ kind: 'rock', x: rng() * WORLD, y: rng() * WORLD,
                 r: 6 + rng() * 22, a: rng() * Math.PI * 2 });
  }
  for (let i = 0; i < 170; i++) {
    props.push({ kind: 'grass', x: rng() * WORLD, y: rng() * WORLD,
                 a: rng() * Math.PI * 2 });
  }
})();

/* ---------------- game state ---------------- */
let state = 'menu';    // 'menu' | 'playing' | 'over'
let paused = false;
let gameTime = 0, score = 0, kills = 0;
let spawnTimer = 0, overTimer = 0, hurtFlash = 0, shake = 0;
const cam = { x: 0, y: 0 };

const bullets = [], monsters = [], particles = [], floaters = [], decals = [];
const DECAL_CAP = 300;
const MONSTER_CAP = 120;

const player = {
  x: WORLD / 2, y: WORLD / 2, r: 14,
  hp: 150, maxHp: 150, speed: 240,
  aim: 0, fireTimer: 0, regenDelay: 0, muzzle: 0,
};
const FIRE_RATE = 10;      // shots per second
const BULLET_DMG = 2;
const REGEN_RATE = 4;      // hp per second...
const REGEN_DELAY = 2.5;   // ...after this long without taking damage

/* ---------------- monsters ---------------- */
const TYPES = {
  zombie: { name: 'zombie', r: 13, hp: 3,  speed: 52,  dmg: 6,  score: 10, color: '#c04b3e' },
  spider: { name: 'spider', r: 9,  hp: 2,  speed: 100, dmg: 4,  score: 15, color: '#a44fc0' },
  brute:  { name: 'brute',  r: 22, hp: 18, speed: 33,  dmg: 15, score: 50, color: '#8e2434' },
};

function pickType() {
  const t = gameTime;
  const w = [['zombie', 10]];
  if (t > 25) w.push(['spider', Math.min(6, (t - 25) / 12)]);
  if (t > 70) w.push(['brute', Math.min(2.2, (t - 70) / 40)]);
  let total = 0;
  for (const [, v] of w) total += v;
  let roll = Math.random() * total;
  for (const [name, v] of w) {
    roll -= v;
    if (roll <= 0) return TYPES[name];
  }
  return TYPES.zombie;
}

function spawnMonster() {
  const type = pickType();
  const a = Math.random() * Math.PI * 2;
  const d = Math.hypot(W, H) / 2 + 80;    // just outside the visible area
  monsters.push({
    type,
    x: player.x + Math.cos(a) * d,
    y: player.y + Math.sin(a) * d,
    r: type.r,
    hp: type.hp,
    speed: type.speed * rand(0.85, 1.15),
    kx: 0, ky: 0,               // knockback velocity
    flash: 0, touchCd: 0,
    wobble: Math.random() * Math.PI * 2,
  });
}

function startGame() {
  state = 'playing';
  paused = false;
  gameTime = 0; score = 0; kills = 0;
  spawnTimer = 0; overTimer = 0; hurtFlash = 0; shake = 0;
  bullets.length = 0; monsters.length = 0; particles.length = 0;
  floaters.length = 0; decals.length = 0;
  player.x = WORLD / 2;
  player.y = WORLD / 2;
  player.hp = player.maxHp;
  player.fireTimer = 0;
  player.regenDelay = 0;
  player.muzzle = 0;
  mouse.down = false;
  centerCamera();
  for (let i = 0; i < 8; i++) spawnMonster();   // small opening crowd
}

function centerCamera() {
  cam.x = clamp(player.x - W / 2, 0, Math.max(0, WORLD - W));
  cam.y = clamp(player.y - H / 2, 0, Math.max(0, WORLD - H));
}

/* ---------------- updates ---------------- */
function update(dt) {
  gameTime += dt;
  updatePlayer(dt);
  updateBullets(dt);
  updateMonsters(dt);
  updateSpawning(dt);
  updateParticles(dt);
  updateCamera(dt);
}

function updatePlayer(dt) {
  let dx = 0, dy = 0;
  if (keys.KeyW || keys.ArrowUp) dy -= 1;
  if (keys.KeyS || keys.ArrowDown) dy += 1;
  if (keys.KeyA || keys.ArrowLeft) dx -= 1;
  if (keys.KeyD || keys.ArrowRight) dx += 1;
  if (dx || dy) {
    const inv = 1 / Math.hypot(dx, dy);
    player.x = clamp(player.x + dx * inv * player.speed * dt, player.r, WORLD - player.r);
    player.y = clamp(player.y + dy * inv * player.speed * dt, player.r, WORLD - player.r);
  }

  player.aim = Math.atan2(mouse.y + cam.y - player.y, mouse.x + cam.x - player.x);

  player.muzzle = Math.max(0, player.muzzle - dt);
  player.fireTimer -= dt;
  if (mouse.down && player.fireTimer <= 0) {
    player.fireTimer = 1 / FIRE_RATE;
    player.muzzle = 0.05;
    const a = player.aim + rand(-0.05, 0.05);
    const bx = player.x + Math.cos(a) * 20;
    const by = player.y + Math.sin(a) * 20;
    bullets.push({ x: bx, y: by, px: bx, py: by,
                   vx: Math.cos(a) * 780, vy: Math.sin(a) * 780, life: 0.9 });
    snd.shoot();
  }

  player.regenDelay -= dt;
  if (player.regenDelay <= 0 && player.hp < player.maxHp) {
    player.hp = Math.min(player.maxHp, player.hp + REGEN_RATE * dt);
  }
}

function damagePlayer(amount) {
  player.hp -= amount;
  player.regenDelay = REGEN_DELAY;
  hurtFlash = 0.35;
  shake = Math.max(shake, 0.5);
  snd.hurt();
  if (player.hp <= 0) {
    player.hp = 0;
    state = 'over';
    overTimer = 0;
    shake = 1.2;
    snd.over();
    splat(player.x, player.y, 26, true);
  }
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.px = b.x;
    b.py = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    let dead = b.life <= 0;
    if (!dead) {
      for (let j = monsters.length - 1; j >= 0; j--) {
        const m = monsters[j];
        const rr = m.r + 3;
        if (dist2(b.x, b.y, m.x, m.y) < rr * rr) {
          hitMonster(m, b, j);
          dead = true;
          break;
        }
      }
    }
    if (dead) bullets.splice(i, 1);
  }
}

function hitMonster(m, b, index) {
  m.hp -= BULLET_DMG;
  m.flash = 0.08;
  const ang = Math.atan2(b.vy, b.vx);
  const kb = 150 * (13 / m.r);          // small monsters fly back harder
  m.kx += Math.cos(ang) * kb;
  m.ky += Math.sin(ang) * kb;
  spawnBlood(m.x, m.y, ang, 5);
  if (m.hp <= 0) {
    killMonster(m, ang, index);
  } else {
    snd.hit();
  }
}

function killMonster(m, ang, index) {
  monsters.splice(index, 1);
  kills++;
  score += m.type.score;
  spawnBlood(m.x, m.y, ang, 14);
  splat(m.x, m.y, m.r, false);
  floaters.push({ x: m.x, y: m.y - m.r, text: '+' + m.type.score, life: 0.8 });
  snd.kill();
}

function updateMonsters(dt) {
  for (let i = monsters.length - 1; i >= 0; i--) {
    const m = monsters[i];
    const dx = player.x - m.x, dy = player.y - m.y;
    const d = Math.hypot(dx, dy) || 1;
    m.x += (dx / d * m.speed + m.kx) * dt;
    m.y += (dy / d * m.speed + m.ky) * dt;
    m.kx *= Math.exp(-9 * dt);
    m.ky *= Math.exp(-9 * dt);
    m.flash = Math.max(0, m.flash - dt);
    m.touchCd -= dt;
    m.wobble += dt * (m.type === TYPES.spider ? 14 : 7);

    if (d < m.r + player.r && m.touchCd <= 0) {
      m.touchCd = 0.8;
      damagePlayer(m.type.dmg);
      m.kx -= dx / d * 260;             // bounce the monster back a little
      m.ky -= dy / d * 260;
    }
  }

  // keep the horde from collapsing into a single blob
  for (let i = 0; i < monsters.length; i++) {
    const a = monsters[i];
    for (let j = i + 1; j < monsters.length; j++) {
      const b = monsters[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const min = a.r + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0 && d2 < min * min) {
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.5;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
  }
}

function updateSpawning(dt) {
  // despawn stragglers left far behind the player
  const far = (Math.hypot(W, H) / 2 + 80) * 2.2;
  const far2 = far * far;
  for (let i = monsters.length - 1; i >= 0; i--) {
    if (dist2(monsters[i].x, monsters[i].y, player.x, player.y) > far2) monsters.splice(i, 1);
  }

  if (monsters.length >= MONSTER_CAP) return;
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    const interval = clamp(1.15 - gameTime * 0.006, 0.24, 1.15);
    spawnTimer = interval * rand(0.7, 1.3);
    const count = 1 + Math.floor(gameTime / 55);
    for (let i = 0; i < count && monsters.length < MONSTER_CAP; i++) spawnMonster();
  }
}

function spawnBlood(x, y, ang, n) {
  for (let i = 0; i < n; i++) {
    const a = ang + rand(-1.1, 1.1) + (Math.random() < 0.15 ? Math.PI : 0);
    const sp = rand(40, 260);
    particles.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rand(0.25, 0.6), size: rand(1.5, 4),
    });
  }
}

function splat(x, y, r, big) {
  const spots = [];
  const n = big ? 10 : 5 + ((r / 4) | 0);
  for (let i = 0; i < n; i++) {
    spots.push({ ox: rand(-r, r) * 1.2, oy: rand(-r, r) * 1.2, r: rand(2, r * 0.6 + 3) });
  }
  decals.push({ x, y, r, spots });
  if (decals.length > DECAL_CAP) decals.shift();
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    const f = Math.exp(-6 * dt);
    p.vx *= f;
    p.vy *= f;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt;
    f.y -= 34 * dt;
    if (f.life <= 0) floaters.splice(i, 1);
  }
}

function updateCamera(dt) {
  const k = 1 - Math.exp(-8 * dt);
  const tx = clamp(player.x - W / 2, 0, Math.max(0, WORLD - W));
  const ty = clamp(player.y - H / 2, 0, Math.max(0, WORLD - H));
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
  shake = Math.max(0, shake - dt * 2.2);
  hurtFlash = Math.max(0, hurtFlash - dt);
}

/* ---------------- drawing ---------------- */
function offView(x, y, pad) {
  return x < cam.x - pad || x > cam.x + W + pad ||
         y < cam.y - pad || y > cam.y + H + pad;
}

function draw() {
  ctx.fillStyle = '#0e0c12';
  ctx.fillRect(0, 0, W, H);

  const sx = (Math.random() - 0.5) * shake * 14;
  const sy = (Math.random() - 0.5) * shake * 14;
  ctx.save();
  ctx.translate(-cam.x + sx, -cam.y + sy);

  drawGround();
  drawDecals();
  drawMonsters();
  drawPlayer();
  drawBullets();
  drawParticles();
  drawFloaters();

  ctx.restore();

  ctx.drawImage(vignette, 0, 0);
  if (hurtFlash > 0) {
    ctx.fillStyle = 'rgba(200,0,0,' + (hurtFlash * 0.5).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
  }
  drawHUD();

  if (state === 'menu') drawMenu();
  else if (state === 'over') drawGameOver();
  else if (paused) drawPaused();
}

function drawGround() {
  const x0 = Math.max(0, cam.x - 40), y0 = Math.max(0, cam.y - 40);
  const x1 = Math.min(WORLD, cam.x + W + 40), y1 = Math.min(WORLD, cam.y + H + 40);

  ctx.fillStyle = '#221e29';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

  ctx.strokeStyle = '#2a2534';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.max(0, Math.floor(x0 / GRID) * GRID); x <= x1; x += GRID) {
    ctx.moveTo(x + 0.5, y0);
    ctx.lineTo(x + 0.5, y1);
  }
  for (let y = Math.max(0, Math.floor(y0 / GRID) * GRID); y <= y1; y += GRID) {
    ctx.moveTo(x0, y + 0.5);
    ctx.lineTo(x1, y + 0.5);
  }
  ctx.stroke();

  ctx.strokeStyle = '#5b4a63';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, WORLD, WORLD);

  for (const p of props) {
    if (p.x < x0 - 30 || p.x > x1 + 30 || p.y < y0 - 30 || p.y > y1 + 30) continue;
    if (p.kind === 'rock') {
      ctx.fillStyle = '#332d3d';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r, p.r * 0.75, p.a, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3d3648';
      ctx.beginPath();
      ctx.ellipse(p.x - p.r * 0.2, p.y - p.r * 0.2, p.r * 0.55, p.r * 0.4, p.a, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = '#37402f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = -1; k <= 1; k++) {
        const a = p.a + k * 0.45;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + Math.cos(a) * 10, p.y + Math.sin(a) * 10);
      }
      ctx.stroke();
    }
  }
}

function drawDecals() {
  ctx.fillStyle = 'rgba(96, 12, 16, 0.55)';
  for (const d of decals) {
    if (offView(d.x, d.y, 80)) continue;
    for (const s of d.spots) {
      ctx.beginPath();
      ctx.arc(d.x + s.ox, d.y + s.oy, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawMonsters() {
  for (const m of monsters) {
    if (offView(m.x, m.y, 40)) continue;
    const T = m.type;
    const a = Math.atan2(player.y - m.y, player.x - m.x);

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(m.x + 2, m.y + 4, m.r * 1.05, m.r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    if (T === TYPES.spider) {          // wiggly legs
      ctx.strokeStyle = '#6d3a80';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const la = (k / 4) * Math.PI * 2 + Math.sin(m.wobble + k) * 0.35;
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(m.x + Math.cos(la) * (m.r + 7), m.y + Math.sin(la) * (m.r + 7));
      }
      ctx.stroke();
    }

    ctx.fillStyle = m.flash > 0 ? '#ffffff' : T.color;
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();

    if (T === TYPES.brute) {           // tusks
      const px = Math.cos(a + Math.PI / 2), py = Math.sin(a + Math.PI / 2);
      ctx.strokeStyle = '#e8e0d0';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (const s of [-1, 1]) {
        const tx = m.x + Math.cos(a) * m.r * 0.8 + px * s * m.r * 0.45;
        const ty = m.y + Math.sin(a) * m.r * 0.8 + py * s * m.r * 0.45;
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx + Math.cos(a) * 6, ty + Math.sin(a) * 6);
      }
      ctx.stroke();
    }

    // eyes fixed on the player
    const px = Math.cos(a + Math.PI / 2), py = Math.sin(a + Math.PI / 2);
    const fx = Math.cos(a) * m.r * 0.45, fy = Math.sin(a) * m.r * 0.45;
    const er = Math.max(1.6, m.r * 0.16);
    ctx.fillStyle = '#ffd75e';
    ctx.beginPath();
    ctx.arc(m.x + fx + px * m.r * 0.35, m.y + fy + py * m.r * 0.35, er, 0, Math.PI * 2);
    ctx.arc(m.x + fx - px * m.r * 0.35, m.y + fy - py * m.r * 0.35, er, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPlayer() {
  const { x, y, r, aim } = player;

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(x + 2, y + 4, r * 1.05, r * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aim);
  ctx.fillStyle = '#23232b';
  ctx.fillRect(4, -5, 8, 10);           // grip
  ctx.fillStyle = '#3b3b46';
  ctx.fillRect(6, -3, 20, 6);           // barrel
  ctx.restore();

  ctx.fillStyle = '#e8e2d4';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#26232c';
  ctx.stroke();

  ctx.fillStyle = '#26232c';
  ctx.beginPath();
  ctx.arc(x + Math.cos(aim) * r * 0.55, y + Math.sin(aim) * r * 0.55, r * 0.32, 0, Math.PI * 2);
  ctx.fill();

  if (player.muzzle > 0) {
    ctx.fillStyle = 'rgba(255, 214, 90, 0.9)';
    ctx.beginPath();
    ctx.arc(x + Math.cos(aim) * 28, y + Math.sin(aim) * 28, 5.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBullets() {
  ctx.lineCap = 'round';
  for (const b of bullets) {
    if (offView(b.x, b.y, 60)) continue;
    ctx.strokeStyle = 'rgba(255, 215, 110, 0.25)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(b.px, b.py);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.strokeStyle = '#ffe9a8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.px, b.py);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.fillStyle = 'rgba(190, 30, 40, ' + clamp(p.life / 0.6, 0, 1).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFloaters() {
  ctx.font = 'bold 15px "Courier New", monospace';
  ctx.textAlign = 'center';
  for (const f of floaters) {
    ctx.fillStyle = 'rgba(255, 230, 150, ' + clamp(f.life / 0.8, 0, 1).toFixed(3) + ')';
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.textAlign = 'left';
}

function drawHUD() {
  if (state === 'menu') return;

  const bw = 230, bh = 18, bx = 18, by = 18;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(bx - 3, by - 3, bw + 6, bh + 6);
  ctx.fillStyle = '#3a1216';
  ctx.fillRect(bx, by, bw, bh);
  const pct = player.hp / player.maxHp;
  ctx.fillStyle = pct > 0.5 ? '#4fae52' : pct > 0.25 ? '#d8a63c' : '#cf4536';
  ctx.fillRect(bx, by, bw * pct, bh);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px "Courier New", monospace';
  ctx.fillText('HP ' + Math.ceil(player.hp) + '/' + player.maxHp, bx + 8, by + 13);

  ctx.textAlign = 'right';
  ctx.font = 'bold 22px "Courier New", monospace';
  ctx.fillStyle = '#ffd75e';
  ctx.fillText(String(score).padStart(6, '0'), W - 18, 34);
  ctx.font = '13px "Courier New", monospace';
  ctx.fillStyle = '#b9b3c6';
  ctx.fillText('kills ' + kills + '   time ' + fmtTime(gameTime), W - 18, 56);
  ctx.textAlign = 'left';

  if (state === 'playing' && gameTime < 8) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '14px "Courier New", monospace';
    ctx.fillText('WASD to move · aim with mouse · hold left button to shoot', W / 2, H - 46);
    ctx.textAlign = 'left';
  }
}

function drawMenu() {
  ctx.fillStyle = 'rgba(10, 8, 14, 0.82)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';

  ctx.font = 'bold 84px "Courier New", monospace';
  ctx.fillStyle = '#a4222b';
  ctx.fillText('C R I M S O N', W / 2, H / 2 - 90);
  ctx.font = '16px "Courier New", monospace';
  ctx.fillStyle = '#8d8598';
  ctx.fillText('a very easy top-down survival shooter', W / 2, H / 2 - 55);

  ctx.font = '18px "Courier New", monospace';
  ctx.fillStyle = '#d6d0de';
  const lines = [
    'WASD / arrows — move',
    'mouse — aim',
    'hold left button — fire',
    'P — pause · M — mute',
  ];
  lines.forEach((l, i) => ctx.fillText(l, W / 2, H / 2 + 8 + i * 28));

  const blink = 0.6 + 0.4 * Math.sin(performance.now() / 300);
  ctx.font = 'bold 22px "Courier New", monospace';
  ctx.fillStyle = 'rgba(255, 215, 94, ' + blink.toFixed(3) + ')';
  ctx.fillText('CLICK TO START', W / 2, H / 2 + 150);
  ctx.textAlign = 'left';
}

function drawGameOver() {
  ctx.fillStyle = 'rgba(20, 4, 6, ' + Math.min(0.8, overTimer * 1.5).toFixed(3) + ')';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.font = 'bold 64px "Courier New", monospace';
  ctx.fillStyle = '#d8433a';
  ctx.fillText('YOU DIED', W / 2, H / 2 - 70);
  ctx.font = '20px "Courier New", monospace';
  ctx.fillStyle = '#e5dfe8';
  ctx.fillText('score ' + score + '   ·   kills ' + kills + '   ·   survived ' + fmtTime(gameTime),
               W / 2, H / 2 - 20);
  if (overTimer > 0.6) {
    const blink = 0.6 + 0.4 * Math.sin(performance.now() / 300);
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.fillStyle = 'rgba(255, 215, 94, ' + blink.toFixed(3) + ')';
    ctx.fillText('CLICK OR PRESS R TO RESTART', W / 2, H / 2 + 40);
  }
  ctx.textAlign = 'left';
}

function drawPaused() {
  ctx.fillStyle = 'rgba(8, 6, 12, 0.6)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.font = 'bold 40px "Courier New", monospace';
  ctx.fillStyle = '#e8e2d4';
  ctx.fillText('PAUSED', W / 2, H / 2);
  ctx.font = '14px "Courier New", monospace';
  ctx.fillStyle = '#8d8598';
  ctx.fillText('press P to resume', W / 2, H / 2 + 30);
  ctx.textAlign = 'left';
}

/* ---------------- main loop ---------------- */
centerCamera();

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (state === 'playing' && !paused) {
    update(dt);
  } else if (state === 'over') {
    overTimer += dt;
    updateParticles(dt);    // let the last drops settle
    updateCamera(dt);
  } else {
    updateCamera(dt);
  }
  draw();
}
requestAnimationFrame(frame);
