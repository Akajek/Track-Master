/* TRACK MASTER -- asymmetric multiplayer tower defense.
 *
 *   npm install
 *   node server.js            (then open http://localhost:8080)
 *
 * One Node process serves the page (public/) and runs every game room. The
 * server is authoritative: it owns the grid, towers, runner positions, damage,
 * gold and upgrade points, and streams snapshots to every client 20x per second.
 * Clients only send intentions (paint tile, place tower, move, use ability).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const PUBLIC = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ statics */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('no'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
});

/* ------------------------------------------------------------ game constants */
const GW = 24, GH = 16, CELL = 40;
const TICK_MS = 50;
const T = { EMPTY: 0, PATH: 1, START: 2, END: 3 };
const RUNNER_R = 11;

/* Everything the client needs to draw menus comes from here (sent on join). */
const TOWERS = {
  turret: { name: 'Turret', cost: 50, range: 130, dmg: 12, rate: 2.2, proj: 420, color: '#7dd3fc',
    desc: 'Reliable single-target shooter.' },
  sniper: { name: 'Sniper', cost: 120, range: 290, dmg: 55, rate: 0.55, color: '#f9a8d4',
    desc: 'Very long range, big hits, slow.' },
  frost:  { name: 'Frost', cost: 80, range: 105, slow: 0.5, color: '#a5f3fc',
    desc: 'Slows every runner in range by half.' },
  mortar: { name: 'Mortar', cost: 150, range: 240, minRange: 70, dmg: 45, splash: 65, rate: 0.6, proj: 240,
    color: '#fdba74', desc: 'Lobs shells. Splash damage. Blind up close.' },
  tesla:  { name: 'Tesla', cost: 130, range: 120, dmg: 22, rate: 1.1, chain: 3, chainRange: 95, color: '#c4b5fd',
    desc: 'Zaps a runner, chains to nearby ones.' },
  flame:  { name: 'Flamer', cost: 90, range: 78, dps: 28, color: '#fb7185',
    desc: 'Short range. Burns everything nearby, constantly.' },
  spikes: { name: 'Spikes', cost: 40, onPath: true, dmg: 22, color: '#d1d5db',
    desc: 'Trap ON the path. Bites whoever steps on it.' },
  glue:   { name: 'Glue', cost: 30, onPath: true, slow: 0.65, color: '#bef264',
    desc: 'Trap ON the path. Very sticky.' },
};
const TOWER_MAX_LV = 4;
const MM_ABILITIES = {
  meteor: { name: 'Meteor', cost: 100, cd: 8, dmg: 70, radius: 80, delay: 1.0, desc: 'Click anywhere. Big boom after 1s.' },
  freeze: { name: 'Freeze', cost: 150, cd: 20, dur: 1.6, desc: 'Every runner stops dead for 1.6s.' },
};
const UPGRADES = {
  speed: { name: 'Speed', max: 8, desc: '+12% move speed' },
  hp:    { name: 'Vitality', max: 10, desc: '+30 max HP' },
  regen: { name: 'Regen', max: 6, desc: '+2 HP/s when not hit for 2s' },
  armor: { name: 'Armor', max: 5, desc: '-9% damage taken' },
  dash:  { name: 'Dash', max: 5, desc: 'SPACE: burst forward. Lv1 unlocks; more = shorter cooldown' },
  emp:   { name: 'EMP', max: 4, desc: 'E: disable nearby towers for 2.5s. Lv1 unlocks; more = bigger radius' },
  ghost: { name: 'Ghost', max: 3, desc: 'Q: 1.5s of invulnerability. Lv1 unlocks; more = shorter cooldown' },
};
const POINTS_PER_FINISH = 3;
const POINTS_PER_DEATH = 1;
const GOLD_START = 400;
const GOLD_PER_SEC = 8;
const GOLD_PER_KILL = 60;
const GOLD_PER_FINISH = 30;
const DEFS = { GW, GH, CELL, T, RUNNER_R, TOWERS, TOWER_MAX_LV, MM_ABILITIES, UPGRADES,
  POINTS_PER_FINISH, POINTS_PER_DEATH };

function upgradeCost(level) { return 1 + Math.floor(level / 2); }
function towerUpgradeCost(def, level) { return Math.round(def.cost * 0.8 * level); }
function towerStat(tw, key) {
  const def = TOWERS[tw.type];
  const v = def[key];
  if (v === undefined) return undefined;
  if (key === 'dmg' || key === 'dps') return v * Math.pow(1.35, tw.lv - 1);
  if (key === 'range') return v * Math.pow(1.1, tw.lv - 1);
  return v;
}

/* --------------------------------------------------------------------- rooms */
const rooms = new Map();
let nextPlayerId = 1;

function makeRoom(code) {
  const room = {
    code, tiles: new Array(GW * GH).fill(T.EMPTY), edit: false,
    players: new Map(), mm: null, towers: new Map(), projectiles: [], meteors: [],
    gold: GOLD_START, freezeUntil: 0, mmCd: { meteor: 0, freeze: 0 },
    events: [], emptySince: Date.now(), nextTid: 1,
  };
  loadPreset(room, 'snake');
  rooms.set(code, room);
  return room;
}

function tileAt(room, x, y) {
  if (x < 0 || y < 0 || x >= GW || y >= GH) return -1;
  return room.tiles[y * GW + x];
}
function walkableTile(t) { return t === T.PATH || t === T.START || t === T.END; }
function findTile(room, type) {
  const i = room.tiles.indexOf(type);
  return i < 0 ? null : { x: i % GW, y: Math.floor(i / GW) };
}

const PRESETS = {
  blank: [],
  snake: [[0, 2], [20, 2], [20, 6], [3, 6], [3, 10], [20, 10], [20, 13], [1, 13]],
  zigzag: [[0, 1], [6, 1], [6, 7], [12, 7], [12, 1], [18, 1], [18, 8], [23, 8], [23, 14], [4, 14]],
};
function loadPreset(room, name) {
  const pts = PRESETS[name];
  if (!pts) return false;
  room.tiles.fill(T.EMPTY);
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = Math.sign(bx - ax), dy = Math.sign(by - ay);
    let x = ax, y = ay;
    room.tiles[y * GW + x] = T.PATH;
    while (x !== bx || y !== by) { x += dx; y += dy; room.tiles[y * GW + x] = T.PATH; }
  }
  if (pts.length) {
    room.tiles[pts[0][1] * GW + pts[0][0]] = T.START;
    room.tiles[pts[pts.length - 1][1] * GW + pts[pts.length - 1][0]] = T.END;
  }
  /* towers on tiles that are now the wrong kind get refunded */
  for (const [key, tw] of [...room.towers]) {
    const onPath = !!TOWERS[tw.type].onPath;
    const t = room.tiles[tw.gy * GW + tw.gx];
    if ((onPath && t !== T.PATH) || (!onPath && t !== T.EMPTY)) { room.gold += tw.spent; room.towers.delete(key); }
  }
  for (const p of runners(room)) placeAtStart(room, p);
  return true;
}

function pathConnected(room) {
  const s = findTile(room, T.START), e = findTile(room, T.END);
  if (!s || !e) return false;
  const seen = new Uint8Array(GW * GH);
  const q = [s]; seen[s.y * GW + s.x] = 1;
  while (q.length) {
    const c = q.shift();
    if (c.x === e.x && c.y === e.y) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const i = ny * GW + nx;
      if (seen[i] || !walkableTile(room.tiles[i])) continue;
      seen[i] = 1; q.push({ x: nx, y: ny });
    }
  }
  return false;
}

/* ------------------------------------------------------------------- players */
function runners(room) { return [...room.players.values()].filter(p => p.role === 'runner'); }

function placeAtStart(room, p) {
  const s = findTile(room, T.START);
  p.x = s ? (s.x + 0.5) * CELL : CELL / 2;
  p.y = s ? (s.y + 0.5) * CELL : CELL / 2;
  p.vx = 0; p.vy = 0; p.dashUntil = 0;
}

function freshRunnerStats(p) {
  p.maxHp = 100 + 30 * p.up.hp;
}

function fits(room, x, y) {
  const R = RUNNER_R, d = R * 0.72;
  const pts = [[x + R, y], [x - R, y], [x, y + R], [x, y - R], [x + d, y + d], [x - d, y + d], [x + d, y - d], [x - d, y - d]];
  for (const [px, py] of pts) {
    if (!walkableTile(tileAt(room, Math.floor(px / CELL), Math.floor(py / CELL)))) return false;
  }
  return true;
}

function tryMove(room, p, dx, dy) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 6));
  const sx = dx / steps, sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    let moved = false;
    if (sx && fits(room, p.x + sx, p.y)) { p.x += sx; moved = true; }
    if (sy && fits(room, p.x, p.y + sy)) { p.y += sy; moved = true; }
    if (!moved) break;
  }
}

function damage(room, p, amt, now, srcType) {
  if (p.dead || p.ghostUntil > now || amt <= 0) return;
  amt *= (1 - 0.09 * p.up.armor);
  p.hp -= amt;
  p.lastHurt = now;
  if (srcType !== 'flame') room.events.push({ k: 'hit', x: Math.round(p.x), y: Math.round(p.y), a: Math.round(amt), id: p.id, s: srcType });
  if (p.hp <= 0) {
    p.hp = 0; p.dead = true; p.respawnAt = now + 2500; p.deaths++; p.points += POINTS_PER_DEATH;
    room.gold += GOLD_PER_KILL;
    room.events.push({ k: 'die', x: Math.round(p.x), y: Math.round(p.y), n: p.name });
  }
}

/* ---------------------------------------------------------------------- tick */
function tick(room, now) {
  const dt = TICK_MS / 1000;
  const live = !room.edit;
  const rs = runners(room);

  /* resource income */
  if (live && room.mm) room.gold += GOLD_PER_SEC * dt;

  /* frost auras and disabled flags feed the runner step */
  for (const p of rs) { p.slow = 1; p.frost = false; }
  if (live) {
    for (const tw of room.towers.values()) {
      if (tw.disabledUntil > now) continue;
      const def = TOWERS[tw.type];
      if (tw.type === 'frost') {
        const r = towerStat(tw, 'range');
        for (const p of rs) {
          if (p.dead) continue;
          if (Math.hypot(p.x - tw.x, p.y - tw.y) <= r) { p.slow = Math.min(p.slow, 1 - def.slow); p.frost = true; }
        }
      }
    }
  }

  /* runners */
  for (const p of rs) {
    if (p.dead) {
      if (now >= p.respawnAt) { p.dead = false; p.hp = p.maxHp; placeAtStart(room, p); }
      continue;
    }
    if (!live) continue;
    /* trap under the feet */
    const gx = Math.floor(p.x / CELL), gy = Math.floor(p.y / CELL);
    const under = room.towers.get(gx + ',' + gy);
    if (under && under.disabledUntil <= now) {
      if (under.type === 'glue') p.slow = Math.min(p.slow, 1 - TOWERS.glue.slow);
      if (under.type === 'spikes' && now - (p.spiked[under.id] || 0) > 900) {
        p.spiked[under.id] = now; damage(room, p, towerStat(under, 'dmg'), now, 'spikes');
      }
    }
    /* movement */
    const frozen = room.freezeUntil > now;
    if (!frozen) {
      let ix = p.input.dx, iy = p.input.dy;
      const len = Math.hypot(ix, iy);
      if (len > 1) { ix /= len; iy /= len; }
      if (len > 0.01) { p.faceX = ix / (len || 1); p.faceY = iy / (len || 1); }
      let spd = 150 * Math.pow(1.12, p.up.speed) * p.slow;
      if (p.dashUntil > now) { spd = 720; ix = p.faceX; iy = p.faceY; }
      if (ix || iy) tryMove(room, p, ix * spd * dt, iy * spd * dt);
    }
    /* regen */
    if (now - p.lastHurt > 2000 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + (2 + 2 * p.up.regen) * dt);
    /* finish line */
    if (tileAt(room, Math.floor(p.x / CELL), Math.floor(p.y / CELL)) === T.END) {
      p.finishes++; p.points += POINTS_PER_FINISH; room.gold += GOLD_PER_FINISH;
      p.hp = p.maxHp;
      room.events.push({ k: 'fin', x: Math.round(p.x), y: Math.round(p.y), n: p.name });
      placeAtStart(room, p);
    }
  }

  /* towers */
  if (live) {
    const alive = rs.filter(p => !p.dead && p.ghostUntil <= now);
    for (const tw of room.towers.values()) {
      const def = TOWERS[tw.type];
      if (def.onPath || tw.type === 'frost') continue;
      if (tw.disabledUntil > now) continue;
      const range = towerStat(tw, 'range');
      if (tw.type === 'flame') {
        let any = false;
        for (const p of alive) {
          if (Math.hypot(p.x - tw.x, p.y - tw.y) <= range) { damage(room, p, towerStat(tw, 'dps') * dt, now, 'flame'); any = true; }
        }
        tw.firing = any;
        continue;
      }
      if (now < tw.nextShot) continue;
      let best = null, bestD = Infinity;
      for (const p of alive) {
        const d = Math.hypot(p.x - tw.x, p.y - tw.y);
        if (d > range || (def.minRange && d < def.minRange)) continue;
        if (d < bestD) { bestD = d; best = p; }
      }
      if (!best) continue;
      tw.nextShot = now + 1000 / def.rate;
      tw.aim = Math.atan2(best.y - tw.y, best.x - tw.x);
      const dmg = towerStat(tw, 'dmg');
      if (tw.type === 'turret') {
        room.projectiles.push({ x: tw.x, y: tw.y, tid: best.id, spd: def.proj, dmg, c: def.color, kind: 'homing' });
        room.events.push({ k: 'fire', x: Math.round(tw.x), y: Math.round(tw.y), ty: 'turret' });
      } else if (tw.type === 'sniper') {
        damage(room, best, dmg, now, 'sniper');
        room.events.push({ k: 'shot', x1: Math.round(tw.x), y1: Math.round(tw.y), x2: Math.round(best.x), y2: Math.round(best.y), c: def.color, w: 3 });
      } else if (tw.type === 'mortar') {
        const dist = Math.hypot(best.x - tw.x, best.y - tw.y);
        room.projectiles.push({ x: tw.x, y: tw.y, tx: best.x, ty: best.y, sx: tw.x, sy: tw.y, t: 0,
          dur: dist / def.proj, dmg, splash: def.splash, c: def.color, kind: 'lob' });
        room.events.push({ k: 'fire', x: Math.round(tw.x), y: Math.round(tw.y), ty: 'mortar' });
      } else if (tw.type === 'tesla') {
        const hit = [best]; let last = best; let d = dmg;
        damage(room, best, d, now, 'tesla');
        room.events.push({ k: 'shot', x1: Math.round(tw.x), y1: Math.round(tw.y), x2: Math.round(best.x), y2: Math.round(best.y), c: def.color, w: 2, z: 1 });
        for (let i = 1; i < def.chain; i++) {
          let nxt = null, nd = Infinity;
          for (const p of alive) {
            if (hit.includes(p)) continue;
            const dd = Math.hypot(p.x - last.x, p.y - last.y);
            if (dd <= def.chainRange && dd < nd) { nd = dd; nxt = p; }
          }
          if (!nxt) break;
          d *= 0.7; damage(room, nxt, d, now, 'tesla');
          room.events.push({ k: 'shot', x1: Math.round(last.x), y1: Math.round(last.y), x2: Math.round(nxt.x), y2: Math.round(nxt.y), c: def.color, w: 2, z: 1 });
          hit.push(nxt); last = nxt;
        }
      }
    }
  }

  /* projectiles */
  for (let i = room.projectiles.length - 1; i >= 0; i--) {
    const pr = room.projectiles[i];
    if (pr.kind === 'homing') {
      const tgt = room.players.get(pr.tid);
      if (!tgt || tgt.dead || tgt.role !== 'runner' || !live) { room.projectiles.splice(i, 1); continue; }
      const dx = tgt.x - pr.x, dy = tgt.y - pr.y, d = Math.hypot(dx, dy);
      const step = pr.spd * dt;
      if (d <= step + 4) { damage(room, tgt, pr.dmg, now, 'turret'); room.projectiles.splice(i, 1); continue; }
      pr.x += dx / d * step; pr.y += dy / d * step;
    } else if (pr.kind === 'lob') {
      pr.t += dt;
      const f = Math.min(1, pr.t / pr.dur);
      pr.x = pr.sx + (pr.tx - pr.sx) * f; pr.y = pr.sy + (pr.ty - pr.sy) * f;
      pr.h = Math.sin(f * Math.PI) * 40;
      if (f >= 1) {
        explode(room, pr.tx, pr.ty, pr.splash, pr.dmg, now, pr.c);
        room.projectiles.splice(i, 1);
      }
    }
  }

  /* meteors */
  for (let i = room.meteors.length - 1; i >= 0; i--) {
    const m = room.meteors[i];
    if (now >= m.at) { explode(room, m.x, m.y, MM_ABILITIES.meteor.radius, MM_ABILITIES.meteor.dmg, now, '#f97316'); room.meteors.splice(i, 1); }
  }
}

function explode(room, x, y, radius, dmg, now, color) {
  room.events.push({ k: 'boom', x: Math.round(x), y: Math.round(y), r: radius, c: color });
  for (const p of runners(room)) {
    if (p.dead) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= radius + RUNNER_R) damage(room, p, dmg * (d < radius * 0.5 ? 1 : 0.6), now, 'boom');
  }
}

/* ------------------------------------------------------------- snapshots */
function gridMsg(room) {
  return JSON.stringify({ t: 'g', tiles: room.tiles, edit: room.edit });
}
function stateMsg(room, now) {
  const r = runners(room).map(p => ({
    id: p.id, n: p.name, x: Math.round(p.x), y: Math.round(p.y), hp: Math.round(p.hp), mh: p.maxHp,
    d: p.dead ? 1 : 0, pt: p.points, fin: p.finishes, dth: p.deaths, up: p.up,
    cd: { dash: Math.max(0, p.cd.dash - now), emp: Math.max(0, p.cd.emp - now), ghost: Math.max(0, p.cd.ghost - now) },
    gh: p.ghostUntil > now ? 1 : 0, ds: p.dashUntil > now ? 1 : 0, sl: p.slow < 1 ? 1 : 0, fx: p.faceX, fy: p.faceY,
  }));
  const tw = [...room.towers.values()].map(t => ({
    id: t.id, ty: t.type, gx: t.gx, gy: t.gy, lv: t.lv, dis: t.disabledUntil > now ? 1 : 0,
    aim: t.aim === undefined ? undefined : Math.round(t.aim * 100) / 100, f: t.firing ? 1 : 0, sp: t.spent,
  }));
  const pj = room.projectiles.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), c: p.c, h: p.h ? Math.round(p.h) : 0, k: p.kind }));
  const mt = room.meteors.map(m => ({ x: m.x, y: m.y, in: Math.max(0, m.at - now) }));
  const msg = {
    t: 's', now, edit: room.edit ? 1 : 0, gold: Math.floor(room.gold),
    mm: room.mm ? { id: room.mm.id, n: room.mm.name } : null,
    mmCd: { meteor: Math.max(0, room.mmCd.meteor - now), freeze: Math.max(0, room.mmCd.freeze - now) },
    frz: Math.max(0, room.freezeUntil - now), r, tw, pj, mt, ev: room.events,
  };
  room.events = [];
  return JSON.stringify(msg);
}
function broadcast(room, str) {
  for (const p of room.players.values()) send(p, str);
}
function send(p, str) {
  if (p.ws.readyState === WebSocket.OPEN) { try { p.ws.send(str); } catch (e) { /* gone */ } }
}
function note(p, text, kind) { send(p, JSON.stringify({ t: 'msg', text, kind: kind || 'info' })); }
function shout(room, text, kind) { broadcast(room, JSON.stringify({ t: 'msg', text, kind: kind || 'info' })); }

/* ------------------------------------------------------------ main loop */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0) {
      if (now - room.emptySince > 60 * 60 * 1000) rooms.delete(code);
      continue;
    }
    try { tick(room, now); } catch (e) { console.error('tick error', code, e); }
    broadcast(room, stateMsg(room, now));
  }
}, TICK_MS);

/* ------------------------------------------------------------- messages */
function clean(str, max) { return String(str || '').replace(/[^\w \-!?.']/g, '').trim().slice(0, max); }
function isInt(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

function onJoin(ws, m) {
  let code = clean(m.room, 8).toUpperCase().replace(/\s/g, '');
  if (!code) {
    do { code = ''; for (let i = 0; i < 4; i++) code += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]; } while (rooms.has(code));
  }
  const room = rooms.get(code) || makeRoom(code);
  const name = clean(m.name, 14) || ('Player' + nextPlayerId);
  const p = {
    id: nextPlayerId++, ws, name, room, role: 'runner',
    x: 0, y: 0, vx: 0, vy: 0, hp: 100, maxHp: 100, dead: false, respawnAt: 0, points: 0, finishes: 0, deaths: 0,
    up: { speed: 0, hp: 0, regen: 0, armor: 0, dash: 0, emp: 0, ghost: 0 },
    input: { dx: 0, dy: 0 }, faceX: 1, faceY: 0, dashUntil: 0, ghostUntil: 0, cd: { dash: 0, emp: 0, ghost: 0 },
    slow: 1, lastHurt: 0, spiked: {},
  };
  ws.player = p;
  room.players.set(p.id, p);
  if (m.role === 'mm' && !room.mm) { p.role = 'mm'; room.mm = p; }
  else if (m.role === 'mm') note(p, 'Mastermind seat is taken by ' + room.mm.name + '. You are a runner for now.', 'warn');
  placeAtStart(room, p);
  send(p, JSON.stringify({ t: 'w', id: p.id, role: p.role, room: code, name, defs: DEFS }));
  send(p, gridMsg(room));
  shout(room, name + ' joined as ' + (p.role === 'mm' ? 'the Mastermind' : 'a runner') + '.');
}

function setRole(p, role) {
  const room = p.room;
  if (role === 'mm') {
    if (room.mm && room.mm !== p) { note(p, 'Mastermind seat is taken.', 'warn'); return; }
    if (room.mm === p) return;
    p.role = 'mm'; room.mm = p; p.input = { dx: 0, dy: 0 };
    shout(room, p.name + ' is now the Mastermind.');
  } else {
    if (room.mm === p) room.mm = null;
    if (p.role === 'runner') return;
    p.role = 'runner'; p.dead = false; p.hp = p.maxHp; placeAtStart(room, p);
    shout(room, p.name + ' is now a runner.');
  }
  send(p, JSON.stringify({ t: 'role', role: p.role }));
}

function onMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  const p = ws.player;
  if (!p) { if (m.t === 'join') onJoin(ws, m); return; }
  const room = p.room;
  const now = Date.now();
  const isMM = room.mm === p;

  switch (m.t) {
    case 'role': setRole(p, m.role === 'mm' ? 'mm' : 'runner'); break;

    case 'input': {
      if (p.role !== 'runner') break;
      const dx = Number(m.dx), dy = Number(m.dy);
      p.input.dx = Number.isFinite(dx) ? Math.max(-1, Math.min(1, dx)) : 0;
      p.input.dy = Number.isFinite(dy) ? Math.max(-1, Math.min(1, dy)) : 0;
      break;
    }

    case 'act': {
      if (p.role !== 'runner' || p.dead || room.edit) break;
      if (m.a === 'dash') {
        if (p.up.dash < 1) { note(p, 'Buy the Dash upgrade first.', 'warn'); break; }
        if (p.cd.dash > now) break;
        p.cd.dash = now + (4000 - 600 * (p.up.dash - 1));
        p.dashUntil = now + 160;
        room.events.push({ k: 'dash', x: Math.round(p.x), y: Math.round(p.y) });
      } else if (m.a === 'emp') {
        if (p.up.emp < 1) { note(p, 'Buy the EMP upgrade first.', 'warn'); break; }
        if (p.cd.emp > now) break;
        p.cd.emp = now + 12000;
        const radius = 120 + 45 * (p.up.emp - 1);
        let n = 0;
        for (const tw of room.towers.values()) {
          if (Math.hypot(tw.x - p.x, tw.y - p.y) <= radius) { tw.disabledUntil = now + 2500; n++; }
        }
        room.events.push({ k: 'emp', x: Math.round(p.x), y: Math.round(p.y), r: radius });
        note(p, 'EMP! ' + n + ' tower' + (n === 1 ? '' : 's') + ' disabled.');
      } else if (m.a === 'ghost') {
        if (p.up.ghost < 1) { note(p, 'Buy the Ghost upgrade first.', 'warn'); break; }
        if (p.cd.ghost > now) break;
        p.cd.ghost = now + (10000 - 2000 * (p.up.ghost - 1));
        p.ghostUntil = now + 1500;
      }
      break;
    }

    case 'upgrade': {
      if (p.role !== 'runner') break;
      const def = UPGRADES[m.key];
      if (!def) break;
      const lv = p.up[m.key];
      if (lv >= def.max) { note(p, def.name + ' is maxed.', 'warn'); break; }
      const cost = upgradeCost(lv);
      if (p.points < cost) { note(p, 'Need ' + cost + ' points for ' + def.name + '.', 'warn'); break; }
      p.points -= cost; p.up[m.key] = lv + 1;
      freshRunnerStats(p);
      if (m.key === 'hp' && !p.dead) p.hp += 30;
      note(p, def.name + ' is now level ' + p.up[m.key] + '.', 'good');
      break;
    }

    /* ---- mastermind only from here ---- */
    case 'mode': {
      if (!isMM) break;
      const wantEdit = !!m.edit;
      if (wantEdit === room.edit) break;
      if (!wantEdit && !pathConnected(room)) {
        note(p, 'The track needs a Start, an End, and a connected path between them.', 'warn');
        break;
      }
      room.edit = wantEdit;
      room.projectiles = []; room.meteors = [];
      for (const r of runners(room)) { r.dead = false; r.hp = r.maxHp; placeAtStart(room, r); }
      broadcast(room, gridMsg(room));
      shout(room, wantEdit ? 'The Mastermind is rebuilding the track. Runners wait at the start.' : 'The track is LIVE. Run!', wantEdit ? 'warn' : 'good');
      break;
    }

    case 'paint': {
      if (!isMM || !room.edit) break;
      const x = m.x, y = m.y, tile = m.tile;
      if (!isInt(x, 0, GW - 1) || !isInt(y, 0, GH - 1) || !isInt(tile, 0, 3)) break;
      const i = y * GW + x;
      if (room.tiles[i] === tile) break;
      if (tile === T.START || tile === T.END) {
        const old = findTile(room, tile);
        if (old) room.tiles[old.y * GW + old.x] = T.PATH;
      }
      room.tiles[i] = tile;
      const tw = room.towers.get(x + ',' + y);
      if (tw) {
        const onPath = !!TOWERS[tw.type].onPath;
        if ((onPath && tile !== T.PATH) || (!onPath && tile !== T.EMPTY)) { room.gold += tw.spent; room.towers.delete(x + ',' + y); }
      }
      for (const r of runners(room)) placeAtStart(room, r);
      broadcast(room, gridMsg(room));
      break;
    }

    case 'preset': {
      if (!isMM || !room.edit) break;
      if (loadPreset(room, m.name)) broadcast(room, gridMsg(room));
      break;
    }

    case 'tower': {
      if (!isMM) break;
      const def = TOWERS[m.type];
      const x = m.x, y = m.y;
      if (!def || !isInt(x, 0, GW - 1) || !isInt(y, 0, GH - 1)) break;
      const key = x + ',' + y;
      if (room.towers.has(key)) { note(p, 'There is already something there.', 'warn'); break; }
      const t = room.tiles[y * GW + x];
      if (def.onPath && t !== T.PATH) { note(p, def.name + ' goes on the path.', 'warn'); break; }
      if (!def.onPath && t !== T.EMPTY) { note(p, def.name + ' goes on empty ground, not the path.', 'warn'); break; }
      if (room.gold < def.cost) { note(p, 'Not enough gold (' + def.cost + ' needed).', 'warn'); break; }
      room.gold -= def.cost;
      room.towers.set(key, { id: room.nextTid++, type: m.type, gx: x, gy: y, x: (x + 0.5) * CELL, y: (y + 0.5) * CELL,
        lv: 1, nextShot: 0, disabledUntil: 0, spent: def.cost, aim: 0, firing: false });
      room.events.push({ k: 'build', x: (x + 0.5) * CELL, y: (y + 0.5) * CELL });
      break;
    }

    case 'sell': {
      if (!isMM) break;
      const key = m.x + ',' + m.y;
      const tw = room.towers.get(key);
      if (!tw) break;
      const refund = Math.round(tw.spent * 0.7);
      room.gold += refund; room.towers.delete(key);
      note(p, 'Sold for ' + refund + ' gold.');
      break;
    }

    case 'tup': {
      if (!isMM) break;
      const tw = room.towers.get(m.x + ',' + m.y);
      if (!tw) break;
      if (tw.lv >= TOWER_MAX_LV) { note(p, 'That one is maxed out.', 'warn'); break; }
      const cost = towerUpgradeCost(TOWERS[tw.type], tw.lv);
      if (room.gold < cost) { note(p, 'Need ' + cost + ' gold to upgrade.', 'warn'); break; }
      room.gold -= cost; tw.spent += cost; tw.lv++;
      room.events.push({ k: 'build', x: tw.x, y: tw.y });
      break;
    }

    case 'ability': {
      if (!isMM || room.edit) break;
      const ab = MM_ABILITIES[m.a];
      if (!ab) break;
      if (room.mmCd[m.a] > now) break;
      if (room.gold < ab.cost) { note(p, 'Need ' + ab.cost + ' gold for ' + ab.name + '.', 'warn'); break; }
      if (m.a === 'meteor') {
        const x = Number(m.x), y = Number(m.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) break;
        room.meteors.push({ x: Math.max(0, Math.min(GW * CELL, x)), y: Math.max(0, Math.min(GH * CELL, y)), at: now + ab.delay * 1000 });
      } else if (m.a === 'freeze') {
        room.freezeUntil = now + ab.dur * 1000;
        shout(room, 'FREEZE!', 'warn');
      }
      room.gold -= ab.cost; room.mmCd[m.a] = now + ab.cd * 1000;
      break;
    }

    case 'clearTowers': {
      if (!isMM) break;
      let refund = 0;
      for (const tw of room.towers.values()) refund += tw.spent;
      room.gold += refund; room.towers.clear();
      note(p, 'All towers sold for the full ' + refund + ' gold.');
      break;
    }

    case 'ping': send(p, JSON.stringify({ t: 'pong', c: m.c })); break;
  }
}

function onClose(ws) {
  const p = ws.player;
  if (!p) return;
  const room = p.room;
  room.players.delete(p.id);
  if (room.mm === p) room.mm = null;
  ws.player = null;
  if (room.players.size === 0) room.emptySince = Date.now();
  else shout(room, p.name + ' left.' + (p.role === 'mm' ? ' The Mastermind seat is open.' : ''));
}

/* ------------------------------------------------------------ websockets */
const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => { try { onMessage(ws, raw.toString()); } catch (e) { console.error('message error', e); } });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => onClose(ws));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* gone */ }
  }
}, 25000);

server.listen(PORT, () => console.log('Track Master listening on http://localhost:' + PORT));

module.exports = { server, rooms, DEFS, pathConnected, loadPreset, makeRoom };
