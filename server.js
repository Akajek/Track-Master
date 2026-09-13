/* TRACK MASTER -- asymmetric multiplayer tower defense.
 *
 *   npm install
 *   node server.js            (then open http://localhost:8080)
 *
 * One Node process serves the page (public/) and runs every game room. The
 * server is authoritative: it owns the grid, the towers, runner positions,
 * damage, gold, victory points and upgrade levels, and streams snapshots to
 * every client 20x per second. Clients only send intentions (paint a tile,
 * place a tower, move, use an ability).
 *
 * The board size is per-room and adjustable, so nothing here may assume a fixed
 * grid: every helper takes the room and reads room.set.gw / room.set.gh.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const RULES = require('./public/rules.js');

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
const CELL = 40;
const TICK_MS = 50;
const RUNNER_R = 11;
const T = { EMPTY: 0, PATH: 1, START: 2, END: 3 };
const MAX_EVENTS = 240;
const SPAWN_GRACE = 1500;      /* invulnerable for a moment after (re)spawning */

/* Every knob the Mastermind can turn before a round. The client builds the
   settings panel straight from this table, so adding a row here is all it takes
   to get a working slider. */
const SETTINGS = {
  gw:         { g: 'Map',     label: 'Map width',               min: 12,  max: 48,    step: 1,   def: 24, rebuild: 1 },
  gh:         { g: 'Map',     label: 'Map height',              min: 10,  max: 32,    step: 1,   def: 16, rebuild: 1 },
  towerPower: { g: 'Balance', label: 'Tower damage %',          min: 10,  max: 300,   step: 5,   def: 100 },
  runnerHp:   { g: 'Balance', label: 'Runner health %',         min: 25,  max: 400,   step: 5,   def: 100 },
  runSpeed:   { g: 'Balance', label: 'Base runner speed',       min: 60,  max: 600,   step: 10,  def: 165 },
  respawn:    { g: 'Balance', label: 'Respawn seconds',         min: 0.5, max: 20,    step: 0.5, def: 2.5 },
  vpTarget:   { g: 'Victory', label: 'Victory points to win',   min: 3,   max: 100,   step: 1,   def: 15 },
  vpFinish:   { g: 'Victory', label: 'VP per runner finish',    min: 1,   max: 20,    step: 1,   def: 2 },
  vpKill:     { g: 'Victory', label: 'VP per runner killed',    min: 1,   max: 20,    step: 1,   def: 1 },
  startGold:  { g: 'Income',  label: 'Mastermind start gold',   min: 0,   max: 20000, step: 100, def: 300 },
  income:     { g: 'Income',  label: 'Gold per second',         min: 0,   max: 120,   step: 1,   def: 6 },
  incomeGrow: { g: 'Income',  label: 'Income growth %/min',     min: 0,   max: 400,   step: 5,   def: 12 },
  goldKill:   { g: 'Income',  label: 'Gold per kill',           min: 0,   max: 1500,  step: 25,  def: 40 },
  goldFinish: { g: 'Income',  label: 'Gold per runner finish',  min: 0,   max: 1500,  step: 25,  def: 25 },
  ptsFinish:  { g: 'Runners', label: 'Upgrade points / finish', min: 1,   max: 60,    step: 1,   def: 5 },
  ptsDeath:   { g: 'Runners', label: 'Upgrade points / death',  min: 0,   max: 30,    step: 1,   def: 2 },
  lapBonus:   { g: 'Runners', label: 'Lap bonus % per finish',  min: 0,   max: 60,    step: 1,   def: 6 },
  upGrow:     { g: 'Scaling', label: 'Runner upgrade cost %',   min: 10,  max: 400,   step: 5,   def: 100 },
  twGrow:     { g: 'Scaling', label: 'Tower upgrade cost %',    min: 10,  max: 400,   step: 5,   def: 100 },
  towerCost:  { g: 'Scaling', label: 'Tower build cost %',      min: 10,  max: 400,   step: 5,   def: 100 },
};


/* ----------------------------------------------------------------- buildings */
/* kind decides how the tick treats it. tracks are the upgrade lines it sells. */
const TOWERS = {
  turret: { name: 'Turret', cost: 50,  kind: 'shoot',   range: 135, dmg: 10, rate: 2.0, proj: 215,
    color: '#7dd3fc', tracks: ['dmg', 'rng', 'spd', 'vel'], desc: 'Reliable single-target shooter.',
    forms: ['Turret', 'Twin Turret', 'Autocannon', 'Gatling', 'Vulcan', 'Warmachine', 'Annihilator'] },
  sniper: { name: 'Sniper', cost: 150, kind: 'hitscan', range: 250, dmg: 34, rate: 0.4,
    color: '#f9a8d4', tracks: ['dmg', 'rng', 'spd'], desc: 'Very long range, big hits, slow.',
    forms: ['Sniper', 'Marksman', 'Longshot', 'Railgun', 'Deadeye', 'Executioner', 'Godshot'] },
  mortar: { name: 'Mortar', cost: 170, kind: 'lob',     range: 240, minRange: 70, dmg: 36, splash: 62, rate: 0.5, proj: 240,
    color: '#fdba74', tracks: ['dmg', 'rng', 'spd', 'pow', 'vel'], desc: 'Lobs shells. Splash damage. Blind up close.',
    forms: ['Mortar', 'Howitzer', 'Siege Mortar', 'Bombard', 'Artillery', 'Devastator', 'Apocalypse'] },
  tesla:  { name: 'Tesla',  cost: 140, kind: 'chain',   range: 120, dmg: 15, rate: 1.0, chain: 3, chainRange: 95,
    color: '#c4b5fd', tracks: ['dmg', 'rng', 'spd'], desc: 'Zaps a runner, chains to nearby ones.',
    forms: ['Tesla Coil', 'Arc Coil', 'Storm Coil', 'Thunderhead', 'Tempest', 'Maelstrom', 'Zeus'] },
  pulse:  { name: 'Pulse',  cost: 180, kind: 'pulse',   range: 110, dmg: 24, rate: 0.6,
    color: '#22d3ee', tracks: ['dmg', 'rng', 'spd'], desc: 'Slams everything around it. Never misses.',
    forms: ['Pulse Node', 'Shockwave', 'Resonator', 'Quake Node', 'Cataclysm', 'Seismic Core', 'Singularity'] },
  laser:  { name: 'Laser',  cost: 210, kind: 'beam',    range: 175, dps: 12, rampMax: 2.2, rampTime: 3,
    color: '#ef4444', tracks: ['dmg', 'rng'], desc: 'Holds a beam. Burns hotter the longer it holds.',
    forms: ['Laser', 'Beam Emitter', 'Focused Beam', 'Prism Lance', 'Solar Lance', 'Starfire', 'Nova Lance'] },
  flame:  { name: 'Flamer', cost: 100, kind: 'aura',    range: 74,  dps: 17,
    color: '#fb7185', tracks: ['dmg', 'rng'], desc: 'Short range. Burns everything nearby, constantly.',
    forms: ['Flamer', 'Burner', 'Incinerator', 'Pyre', 'Inferno', 'Hellmouth', 'Sunforge'] },
  frost:  { name: 'Frost',  cost: 90,  kind: 'slow',    range: 100, slow: 0.45,
    color: '#a5f3fc', tracks: ['pow', 'rng'], desc: 'Slows every runner in range.',
    forms: ['Frost Emitter', 'Chiller', 'Cryo Node', 'Deep Freeze', 'Glacier', 'Absolute Zero', 'Winter'] },
};
const TRAPS = {
  spikes: { name: 'Spikes', cost: 40,  kind: 'spikes', dmg: 16, cd: 1,
    color: '#d1d5db', tracks: ['dmg', 'spd'], desc: 'Bites whoever steps on it.',
    forms: ['Spikes', 'Barbs', 'Caltrops', 'Spike Pit', 'Impaler Bed', 'Spine Field', 'Thornmaw'] },
  glue:   { name: 'Glue',   cost: 30,  kind: 'glue',   slow: 0.55,
    color: '#bef264', tracks: ['pow'], desc: 'Very sticky. Slows anyone standing in it.',
    forms: ['Glue', 'Tar', 'Sludge', 'Quagmire', 'Tar Pit', 'Mire', 'Molasses Sea'] },
  saw:    { name: 'Saw',    cost: 110, kind: 'saw',    dps: 28,
    color: '#94a3b8', tracks: ['dmg'], desc: 'Spinning blade. Shreds anyone standing on it.',
    forms: ['Saw', 'Buzzsaw', 'Ripper', 'Shredder', 'Mulcher', 'Bonesaw', 'Meatgrinder'] },
  mine:   { name: 'Mine',   cost: 80,  kind: 'mine',   dmg: 65, splash: 66, once: 1,
    color: '#f97316', tracks: ['dmg', 'pow'], desc: 'One big blast, then it is gone for good.',
    forms: ['Mine', 'Charge', 'Bomb', 'Cluster Mine', 'Demolition Charge', 'Bunker Buster', 'Doomsday Mine'] },
  snare:  { name: 'Snare',  cost: 90,  kind: 'snare',  root: 1, cd: 8,
    color: '#fcd34d', tracks: ['pow', 'spd'], desc: 'Roots a runner in place. Cannot move at all.',
    forms: ['Snare', 'Trap Jaws', 'Bear Trap', 'Bramble Snare', 'Iron Maiden', 'Root Cage', 'Stasis Field'] },
  portal: { name: 'Portal', cost: 140, kind: 'portal', cd: 14,
    color: '#c084fc', tracks: ['spd'], desc: 'Sends the runner all the way back to the start.',
    forms: ['Portal', 'Rift', 'Warp Gate', 'Void Gate', 'Wormhole', 'Event Horizon', 'Oblivion'] },
};
for (const k in TRAPS) TRAPS[k].onPath = true;
const BUILD = Object.assign({}, TOWERS, TRAPS);

const TRACKS = {
  dmg: { name: 'Damage', desc: '+25% damage' },
  rng: { name: 'Range',  desc: '+12% range' },
  spd: { name: 'Rate',   desc: '+18% fire rate, or a faster re-arm for a trap' },
  pow: { name: 'Power',  desc: 'stronger effect' },
  vel: { name: 'Velocity', desc: '+20% projectile speed' },
};

const MM_ABILITIES = {
  meteor:  { name: 'Meteor',  cost: 100, cd: 8,  dmg: 70,  radius: 80, delay: 1.0, aim: 1, icon: '☄', desc: 'Click the board. Big boom after 1s.' },
  freeze:  { name: 'Freeze',  cost: 150, cd: 20, dur: 1.6, icon: '❄', desc: 'Every runner stops dead for 1.6s.' },
  barrage: { name: 'Barrage', cost: 260, cd: 30, dmg: 40, radius: 62, shells: 6, aim: 1, icon: '💥', desc: 'Six shells rain around the spot you pick.' },
  overdrive: { name: 'Overdrive', cost: 300, cd: 40, dur: 6, icon: '⏩', desc: 'Every tower fires at double rate for 6s.' },
  blackout: { name: 'Blackout', cost: 180, cd: 35, dur: 5, icon: '🌑', desc: 'Runners lose every ability for 5s.' },
};

/* Runner upgrades. Nothing is capped: costs grow instead. */
const UPGRADES = {
  speed:    { name: 'Speed',       kind: 'passive', desc: '+9% move speed' },
  hp:       { name: 'Vitality',    kind: 'passive', desc: '+30 max HP' },
  regen:    { name: 'Regen',       kind: 'passive', desc: '+3 HP/s, even while being shot' },
  armor:    { name: 'Armor',       kind: 'passive', desc: 'Less damage taken (diminishing)' },
  grip:     { name: 'Grip',        kind: 'passive', desc: 'Resist slows and glue' },
  haste:    { name: 'Haste',       kind: 'passive', desc: 'Shorter ability cooldowns' },
  momentum: { name: 'Momentum',    kind: 'passive', desc: 'Speeds up while you avoid damage' },
  scholar:  { name: 'Scholar',     kind: 'passive', desc: '+1 upgrade point per finish' },
  revive:   { name: 'Quick Revive', kind: 'passive', desc: 'Respawn faster' },
  tough:    { name: 'Last Stand',  kind: 'passive', desc: 'Damage taken below 30% HP is reduced' },
  dash:     { name: 'Dash',   kind: 'ability', key: 'Space', icon: '💨', desc: 'Burst forward through fire' },
  emp:      { name: 'EMP',    kind: 'ability', key: 'E', icon: '⚡', desc: 'Disable nearby towers' },
  ghost:    { name: 'Ghost',  kind: 'ability', key: 'Q', icon: '👻', desc: 'Brief invulnerability' },
  blink:    { name: 'Blink',  kind: 'ability', key: 'F', icon: '✨', desc: 'Teleport forward along the path' },
  shield:   { name: 'Shield', kind: 'ability', key: 'R', icon: '🛡', desc: 'Absorb a chunk of damage' },
  decoy:    { name: 'Decoy',  kind: 'ability', key: 'C', icon: '👥', desc: 'Towers shoot your double instead' },
  surge:    { name: 'Surge',  kind: 'ability', key: 'V', icon: '🚀', desc: 'Huge speed boost for a few seconds' },
  medkit:   { name: 'Medkit', kind: 'ability', key: 'X', icon: '➕', desc: 'Heal yourself instantly' },
};
const ABILITY_KEYS = Object.keys(UPGRADES).filter(k => UPGRADES[k].kind === 'ability');

const DEFS = { CELL, T, RUNNER_R, TOWERS, TRAPS, BUILD, TRACKS, MM_ABILITIES, UPGRADES, SETTINGS, ABILITY_KEYS };

/* ------------------------------------------------------------------ scaling */
/* The formulas themselves live in public/rules.js so the browser shows exactly
   the numbers the server is about to charge. These are just room-shaped wrappers. */
const upgradeCost = (room, key, lv) => RULES.upgradeCost(room.set, UPGRADES[key], lv);
const buildCost   = (room, type)    => RULES.buildCost(room.set, BUILD[type]);
const trackCost   = (room, tw)      => RULES.trackCost(room.set, BUILD[tw.type], RULES.upgrades(tw.up));
const twDmg   = (room, tw) => RULES.dmg(BUILD[tw.type], tw.up, room.set);
const twRange = tw => RULES.range(BUILD[tw.type], tw.up);
const twRate  = tw => RULES.rate(BUILD[tw.type], tw.up);
const twSlow  = tw => RULES.slow(BUILD[tw.type], tw.up);
const twRoot  = tw => RULES.root(BUILD[tw.type], tw.up);
const twSplash = tw => RULES.splash(BUILD[tw.type], tw.up);
const twCd    = tw => RULES.cooldown(BUILD[tw.type], tw.up);
const twForm  = tw => RULES.form(tw.up);
const twProj  = tw => RULES.proj(BUILD[tw.type], tw.up);

const rSpeed   = (room, p) => RULES.speed(room.set, p.up, p.laps);
const rMaxHp   = (room, p) => RULES.maxHp(room.set, p.up, p.laps);
const rArmor   = p => RULES.armorMul(p.up);
const rGrip    = p => RULES.gripMul(p.up);
const rHaste   = p => RULES.hasteMul(p.up);
const rRespawn = (room, p) => RULES.respawnMs(room.set, p.up);
const rMomentum = (p, now) => RULES.momentumMul(p.up, now - p.lastHurt);
const ABILITY = RULES.ability;

/* --------------------------------------------------------------------- rooms */
const rooms = new Map();
let nextPlayerId = 1;

function defaultSettings() {
  const s = {};
  for (const k in SETTINGS) s[k] = SETTINGS[k].def;
  return s;
}

function makeRoom(code) {
  const room = {
    code, set: defaultSettings(), edit: false,
    tiles: null, players: new Map(), mm: null, towers: new Map(),
    projectiles: [], meteors: [], decoys: [], events: [],
    gold: 0, vpRun: 0, vpMM: 0, winner: null, winUntil: 0,
    freezeUntil: 0, overdriveUntil: 0, blackoutUntil: 0,
    mmCd: {}, roundStart: Date.now(), emptySince: Date.now(),
    nextTid: 1, nextDid: 1, gridDirty: false, towersDirty: false,
  };
  room.tiles = new Array(room.set.gw * room.set.gh).fill(T.EMPTY);
  room.gold = room.set.startGold;
  for (const a in MM_ABILITIES) room.mmCd[a] = 0;
  loadPreset(room, 'snake');
  rooms.set(code, room);
  return room;
}

const GW = r => r.set.gw, GH = r => r.set.gh;
function idx(room, x, y) { return y * room.set.gw + x; }
function inBounds(room, x, y) { return x >= 0 && y >= 0 && x < room.set.gw && y < room.set.gh; }
function tileAt(room, x, y) { return inBounds(room, x, y) ? room.tiles[idx(room, x, y)] : -1; }
function walkable(t) { return t === T.PATH || t === T.START || t === T.END; }
function findTile(room, type) {
  const i = room.tiles.indexOf(type);
  return i < 0 ? null : { x: i % room.set.gw, y: Math.floor(i / room.set.gw) };
}
function boardW(room) { return room.set.gw * CELL; }
function boardH(room) { return room.set.gh * CELL; }

/* Presets are drawn as a fraction of the board so they fit any map size. */
const PRESETS = {
  blank: null,
  snake: (w, h) => {
    const pts = [], rows = Math.max(2, Math.floor(h / 4));
    const top = 1, bottom = h - 2, step = Math.max(2, Math.floor((bottom - top) / rows));
    let y = top, left = 1, right = w - 2, dir = 1;
    pts.push([0, y]);
    while (y <= bottom) {
      pts.push([dir > 0 ? right : left, y]);
      const ny = Math.min(bottom, y + step);
      if (ny === y) break;
      pts.push([dir > 0 ? right : left, ny]);
      y = ny; dir = -dir;
    }
    pts.push([dir > 0 ? right : left, y]);
    return pts;
  },
  zigzag: (w, h) => {
    const pts = [[0, 1]];
    const cols = Math.max(3, Math.floor(w / 6));
    for (let i = 1; i <= cols; i++) {
      const x = Math.round(i * (w - 2) / cols);
      const y = i % 2 ? h - 2 : 1;
      pts.push([x, pts[pts.length - 1][1]]);
      pts.push([x, y]);
    }
    return pts;
  },
  spiral: (w, h) => {
    const pts = []; let l = 0, r = w - 1, t = 0, b = h - 1;
    pts.push([0, 0]);
    while (l + 1 < r && t + 1 < b) {
      pts.push([r, t]); pts.push([r, b]); pts.push([l + 1, b]); pts.push([l + 1, t + 2]);
      l += 2; r -= 2; t += 2; b -= 2;
    }
    return pts;
  },
};

function drawLine(room, ax, ay, bx, by) {
  const dx = Math.sign(bx - ax), dy = Math.sign(by - ay);
  let x = ax, y = ay, guard = 0;
  if (inBounds(room, x, y)) room.tiles[idx(room, x, y)] = T.PATH;
  while ((x !== bx || y !== by) && guard++ < 4000) {
    x += dx; y += dy;
    if (inBounds(room, x, y)) room.tiles[idx(room, x, y)] = T.PATH;
  }
}

function loadPreset(room, name) {
  if (!(name in PRESETS)) return false;
  const w = room.set.gw, h = room.set.gh;
  room.tiles.fill(T.EMPTY);
  const fn = PRESETS[name];
  const pts = fn ? fn(w, h).filter(p => p[0] >= 0 && p[1] >= 0 && p[0] < w && p[1] < h) : [];
  for (let i = 0; i + 1 < pts.length; i++) drawLine(room, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  if (pts.length) {
    room.tiles[idx(room, pts[0][0], pts[0][1])] = T.START;
    const last = pts[pts.length - 1];
    room.tiles[idx(room, last[0], last[1])] = T.END;
  }
  pruneTowers(room);
  room.gridDirty = true;
  for (const p of runners(room)) placeAtStart(room, p, Date.now());
  return true;
}

/* Anything standing on a tile that is now the wrong kind is refunded. */
function pruneTowers(room) {
  for (const [key, tw] of [...room.towers]) {
    const def = BUILD[tw.type];
    const t = tileAt(room, tw.gx, tw.gy);
    const ok = def.onPath ? t === T.PATH : t === T.EMPTY;
    if (!ok) { room.gold += tw.spent; room.towers.delete(key); room.towersDirty = true; }
  }
}

function resize(room, gw, gh) {
  const old = room.tiles, ow = room.set.gw, oh = room.set.gh;
  const tiles = new Array(gw * gh).fill(T.EMPTY);
  for (let y = 0; y < Math.min(oh, gh); y++) {
    for (let x = 0; x < Math.min(ow, gw); x++) tiles[y * gw + x] = old[y * ow + x];
  }
  room.set.gw = gw; room.set.gh = gh; room.tiles = tiles;
  for (const [key, tw] of [...room.towers]) {
    if (!inBounds(room, tw.gx, tw.gy)) { room.gold += tw.spent; room.towers.delete(key); room.towersDirty = true; }
  }
  pruneTowers(room);
  room.gridDirty = true;
  for (const p of runners(room)) placeAtStart(room, p, Date.now());
}

function pathConnected(room) {
  const s = findTile(room, T.START), e = findTile(room, T.END);
  if (!s || !e) return false;
  const w = room.set.gw, seen = new Uint8Array(w * room.set.gh);
  const q = [s]; seen[idx(room, s.x, s.y)] = 1;
  while (q.length) {
    const c = q.shift();
    if (c.x === e.x && c.y === e.y) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.x + dx, ny = c.y + dy;
      if (!inBounds(room, nx, ny)) continue;
      const i = idx(room, nx, ny);
      if (seen[i] || !walkable(room.tiles[i])) continue;
      seen[i] = 1; q.push({ x: nx, y: ny });
    }
  }
  return false;
}

/* ------------------------------------------------------------------- players */
function runners(room) { return [...room.players.values()].filter(p => p.role === 'runner'); }

function placeAtStart(room, p, now) {
  const s = findTile(room, T.START);
  p.x = s ? (s.x + 0.5) * CELL : CELL / 2;
  p.y = s ? (s.y + 0.5) * CELL : CELL / 2;
  p.dashUntil = 0; p.surgeUntil = 0; p.rootUntil = 0;
  p.ghostUntil = Math.max(p.ghostUntil || 0, (now || Date.now()) + SPAWN_GRACE);
}

function fits(room, x, y) {
  const R = RUNNER_R, d = R * 0.72;
  const pts = [[x + R, y], [x - R, y], [x, y + R], [x, y - R],
               [x + d, y + d], [x - d, y + d], [x + d, y - d], [x - d, y - d]];
  for (const [px, py] of pts) {
    if (!walkable(tileAt(room, Math.floor(px / CELL), Math.floor(py / CELL)))) return false;
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

function ev(room, e) { if (room.events.length < MAX_EVENTS) room.events.push(e); }

function damage(room, p, amt, now, src) {
  if (p.dead || p.ghostUntil > now || amt <= 0) return;
  amt *= rArmor(p);
  if (p.up.tough && p.hp / p.maxHp < 0.3) amt *= RULES.toughMul(p.up);
  if (p.shield > 0) {
    const eaten = Math.min(p.shield, amt);
    p.shield -= eaten; amt -= eaten;
    ev(room, { k: 'absorb', x: Math.round(p.x), y: Math.round(p.y), a: Math.round(eaten) });
    if (p.shield <= 0) ev(room, { k: 'shieldpop', x: Math.round(p.x), y: Math.round(p.y) });
    if (amt <= 0.01) { p.lastHurt = now; return; }
  }
  p.hp -= amt;
  p.lastHurt = now;
  if (src !== 'flame' && src !== 'saw' && src !== 'laser') {
    ev(room, { k: 'hit', x: Math.round(p.x), y: Math.round(p.y), a: Math.round(amt), id: p.id, s: src });
  } else if (Math.random() < 0.25) {
    ev(room, { k: 'burn', x: Math.round(p.x), y: Math.round(p.y), id: p.id, s: src });
  }
  if (p.hp <= 0) kill(room, p, now);
}

function kill(room, p, now) {
  p.hp = 0; p.dead = true; p.shield = 0;
  p.respawnAt = now + rRespawn(room, p);
  p.deaths++; p.points += room.set.ptsDeath;
  room.gold += room.set.goldKill;
  room.vpMM += room.set.vpKill;
  ev(room, { k: 'die', x: Math.round(p.x), y: Math.round(p.y), n: p.name, id: p.id });
  ev(room, { k: 'vp', x: Math.round(p.x), y: Math.round(p.y), n: room.set.vpKill, team: 'mm' });
  checkWin(room, now);
}

function finish(room, p, now) {
  p.finishes++; p.laps++;
  p.points += room.set.ptsFinish + p.up.scholar;
  room.vpRun += room.set.vpFinish;
  room.gold += room.set.goldFinish;
  p.maxHp = rMaxHp(room, p);
  p.hp = p.maxHp;
  p.shield = Math.max(p.shield, 25);
  ev(room, { k: 'fin', x: Math.round(p.x), y: Math.round(p.y), n: p.name, id: p.id });
  ev(room, { k: 'vp', x: Math.round(p.x), y: Math.round(p.y), n: room.set.vpFinish, team: 'run' });
  ev(room, { k: 'lap', x: Math.round(p.x), y: Math.round(p.y), n: p.laps });
  checkWin(room, now);
  if (!room.winner) placeAtStart(room, p, now);
}

function checkWin(room, now) {
  if (room.winner) return;
  const target = room.set.vpTarget;
  if (room.vpRun >= target) room.winner = 'runners';
  else if (room.vpMM >= target) room.winner = 'mastermind';
  if (room.winner) {
    room.winUntil = now + 9000;
    ev(room, { k: 'win', team: room.winner });
    shout(room, room.winner === 'runners' ? 'THE RUNNERS WIN THE ROUND!' : 'THE MASTERMIND WINS THE ROUND!', 'good');
  }
}

function newRound(room, now) {
  room.winner = null; room.vpRun = 0; room.vpMM = 0;
  room.edit = true;
  /* A fresh round starts from the configured bankroll, not from whatever was
     left over when the last one ended. */
  room.gold = room.set.startGold;
  room.towersDirty = true;
  room.projectiles = []; room.meteors = []; room.decoys = [];
  room.freezeUntil = 0; room.overdriveUntil = 0; room.blackoutUntil = 0;
  room.roundStart = now;
  for (const p of runners(room)) {
    p.dead = false; p.hp = p.maxHp; p.shield = 0;
    placeAtStart(room, p, now);
  }
  shout(room, 'New round. The Mastermind is setting up.', 'info');
}

/* ---------------------------------------------------------------------- tick */
function targetsOf(room, now) {
  const list = [];
  for (const p of room.players.values()) {
    if (p.role !== 'runner' || p.dead || p.ghostUntil > now) continue;
    list.push({ x: p.x, y: p.y, p, decoy: null });
  }
  for (const d of room.decoys) list.push({ x: d.x, y: d.y, p: null, decoy: d });
  return list;
}

/* Where to shoot so a target moving in a straight line walks into the shot.
   Falls back to firing straight at them when there is no solution. */
function leadPoint(sx, sy, t, speed) {
  const vx = t.p ? (t.p.vx || 0) : 0, vy = t.p ? (t.p.vy || 0) : 0;
  const dx = t.x - sx, dy = t.y - sy;
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (dx * vx + dy * vy);
  const c = dx * dx + dy * dy;
  let time;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-6) return { x: t.x, y: t.y };
    time = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return { x: t.x, y: t.y };
    const r = Math.sqrt(disc);
    const opts = [(-b + r) / (2 * a), (-b - r) / (2 * a)].filter(v => v > 0);
    if (!opts.length) return { x: t.x, y: t.y };
    time = Math.min.apply(null, opts);
  }
  if (!(time > 0) || !isFinite(time) || time > 6) return { x: t.x, y: t.y };
  return { x: t.x + vx * time, y: t.y + vy * time };
}

function hurtTarget(room, tgt, amt, now, src) {
  if (tgt.p) damage(room, tgt.p, amt, now, src);
  else if (tgt.decoy) {
    tgt.decoy.hp -= amt;
    ev(room, { k: 'hit', x: Math.round(tgt.x), y: Math.round(tgt.y), a: Math.round(amt), id: -1, s: src });
  }
}

function tick(room, now) {
  const dt = TICK_MS / 1000;
  const S = room.set;

  if (room.winner) {
    if (now >= room.winUntil) newRound(room, now);
    return;
  }
  const live = !room.edit;
  const rs = runners(room);

  if (live && room.mm) {
    const mins = (now - room.roundStart) / 60000;
    room.gold += S.income * (1 + S.incomeGrow / 100 * mins) * dt;
  }

  /* decoys age out */
  for (let i = room.decoys.length - 1; i >= 0; i--) {
    const d = room.decoys[i];
    if (!live || now >= d.until || d.hp <= 0) {
      ev(room, { k: 'decoypop', x: Math.round(d.x), y: Math.round(d.y) });
      room.decoys.splice(i, 1);
    }
  }

  /* slow auras are recomputed every tick from scratch */
  for (const p of rs) { p.slow = 1; p.inFrost = false; }
  if (live) {
    for (const tw of room.towers.values()) {
      if (tw.type !== 'frost' || tw.disabledUntil > now) continue;
      const r = twRange(tw), s = twSlow(tw);
      for (const p of rs) {
        if (p.dead) continue;
        if (Math.hypot(p.x - tw.x, p.y - tw.y) <= r) {
          p.slow = Math.min(p.slow, 1 - s);
          p.inFrost = true;
        }
      }
    }
  }

  /* ------------------------------------------------------------- runners */
  for (const p of rs) {
    p.maxHp = rMaxHp(room, p);
    if (p.hp > p.maxHp) p.hp = p.maxHp;
    if (p.dead) {
      if (now >= p.respawnAt) {
        p.dead = false; p.hp = p.maxHp;
        placeAtStart(room, p, now);
        ev(room, { k: 'spawn', x: Math.round(p.x), y: Math.round(p.y), id: p.id });
      }
      continue;
    }
    if (!live) continue;

    /* whatever is under the feet */
    const gx = Math.floor(p.x / CELL), gy = Math.floor(p.y / CELL);
    const under = room.towers.get(gx + ',' + gy);
    if (under && under.disabledUntil <= now && BUILD[under.type].onPath) stepOnTrap(room, under, p, now, dt);

    /* movement */
    const frozen = room.freezeUntil > now || p.rootUntil > now;
    const wasX = p.x, wasY = p.y;
    if (!frozen) {
      let ix = p.input.dx, iy = p.input.dy;
      const len = Math.hypot(ix, iy);
      if (len > 1) { ix /= len; iy /= len; }
      if (len > 0.01) { p.faceX = ix / len; p.faceY = iy / len; }
      const slowMul = 1 - (1 - p.slow) * rGrip(p);
      let spd = rSpeed(room, p) * slowMul * rMomentum(p, now);
      if (p.surgeUntil > now) spd *= p.surgeMul;
      if (p.dashUntil > now) { spd = 760; ix = p.faceX; iy = p.faceY; }
      if (ix || iy) tryMove(room, p, ix * spd * dt, iy * spd * dt);
    }
    /* Measured, not requested: this is what towers aim ahead of. Hold one
       direction and a shot will meet you; change it and the shot sails past. */
    p.vx = (p.x - wasX) / dt; p.vy = (p.y - wasY) / dt;

    /* Regeneration does not care whether you are being shot at: it races the
       incoming damage instead of waiting politely for it to stop. */
    if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + RULES.regenPerSec(p.up) * dt);
    if (p.shieldUntil && now > p.shieldUntil && p.shield > 0) { p.shield = 0; }

    if (tileAt(room, Math.floor(p.x / CELL), Math.floor(p.y / CELL)) === T.END) finish(room, p, now);
    if (room.winner) return;
  }

  /* -------------------------------------------------------------- towers */
  if (live) {
    const tgts = targetsOf(room, now);
    const odMul = room.overdriveUntil > now ? 2 : 1;
    for (const tw of room.towers.values()) {
      const def = BUILD[tw.type];
      if (def.onPath || def.kind === 'slow') continue;
      if (tw.disabledUntil > now) { tw.firing = false; tw.beam = 0; continue; }
      const range = twRange(tw);

      if (def.kind === 'aura') {
        let any = false;
        for (const t of tgts) {
          if (Math.hypot(t.x - tw.x, t.y - tw.y) <= range) { hurtTarget(room, t, twDmg(room, tw) * dt * odMul, now, 'flame'); any = true; }
        }
        tw.firing = any;
        continue;
      }

      if (def.kind === 'beam') {
        let best = null, bd = Infinity;
        for (const t of tgts) {
          const d = Math.hypot(t.x - tw.x, t.y - tw.y);
          if (d <= range && d < bd) { bd = d; best = t; }
        }
        if (!best) { tw.firing = false; tw.beam = 0; tw.bx = 0; tw.by = 0; continue; }
        tw.beam = Math.min(def.rampTime, (tw.beam || 0) + dt);
        const ramp = 1 + (def.rampMax - 1) * (tw.beam / def.rampTime);
        hurtTarget(room, best, twDmg(room, tw) * ramp * dt * odMul, now, 'laser');
        tw.firing = true; tw.bx = Math.round(best.x); tw.by = Math.round(best.y);
        tw.aim = Math.atan2(best.y - tw.y, best.x - tw.x);
        continue;
      }

      if (now < tw.nextShot) continue;
      const rate = twRate(tw) * odMul;

      if (def.kind === 'pulse') {
        const inRange = tgts.filter(t => Math.hypot(t.x - tw.x, t.y - tw.y) <= range);
        if (!inRange.length) continue;
        tw.nextShot = now + 1000 / rate;
        ev(room, { k: 'pulse', x: Math.round(tw.x), y: Math.round(tw.y), r: Math.round(range), c: def.color });
        for (const t of inRange) hurtTarget(room, t, twDmg(room, tw), now, 'pulse');
        continue;
      }

      let best = null, bd = Infinity;
      for (const t of tgts) {
        const d = Math.hypot(t.x - tw.x, t.y - tw.y);
        if (d > range || (def.minRange && d < def.minRange)) continue;
        if (d < bd) { bd = d; best = t; }
      }
      if (!best) continue;
      tw.nextShot = now + 1000 / rate;
      tw.aim = Math.atan2(best.y - tw.y, best.x - tw.x);
      const dmg = twDmg(room, tw);

      if (def.kind === 'shoot') {
        const speed = twProj(tw);
        const aim = leadPoint(tw.x, tw.y, best, speed);
        const d = Math.hypot(aim.x - tw.x, aim.y - tw.y) || 1;
        room.projectiles.push({ x: tw.x, y: tw.y, vx: (aim.x - tw.x) / d * speed, vy: (aim.y - tw.y) / d * speed,
          dmg, c: def.color, kind: 'bolt', left: range * 1.8 });
        tw.aim = Math.atan2(aim.y - tw.y, aim.x - tw.x);
        ev(room, { k: 'fire', x: Math.round(tw.x), y: Math.round(tw.y), ty: 'turret', a: Math.round(tw.aim * 100) / 100 });
      } else if (def.kind === 'hitscan') {
        hurtTarget(room, best, dmg, now, 'sniper');
        ev(room, { k: 'fire', x: Math.round(tw.x), y: Math.round(tw.y), ty: 'sniper', a: Math.round(tw.aim * 100) / 100 });
        ev(room, { k: 'shot', x1: Math.round(tw.x), y1: Math.round(tw.y), x2: Math.round(best.x), y2: Math.round(best.y), c: def.color, w: 3 });
      } else if (def.kind === 'lob') {
        const speed = twProj(tw);
        const aim = leadPoint(tw.x, tw.y, best, speed);
        const dist = Math.hypot(aim.x - tw.x, aim.y - tw.y);
        room.projectiles.push({ x: tw.x, y: tw.y, tx: aim.x, ty: aim.y, sx: tw.x, sy: tw.y, t: 0,
          dur: Math.max(0.15, dist / speed), dmg, splash: twSplash(tw), c: def.color, kind: 'lob' });
        tw.aim = Math.atan2(aim.y - tw.y, aim.x - tw.x);
        ev(room, { k: 'fire', x: Math.round(tw.x), y: Math.round(tw.y), ty: 'mortar', a: Math.round(tw.aim * 100) / 100 });
      } else if (def.kind === 'chain') {
        const hit = [best]; let last = best, d = dmg;
        hurtTarget(room, best, d, now, 'tesla');
        ev(room, { k: 'shot', x1: Math.round(tw.x), y1: Math.round(tw.y), x2: Math.round(best.x), y2: Math.round(best.y), c: def.color, w: 2, z: 1 });
        for (let i = 1; i < def.chain; i++) {
          let nxt = null, nd = Infinity;
          for (const t of tgts) {
            if (hit.includes(t)) continue;
            const dd = Math.hypot(t.x - last.x, t.y - last.y);
            if (dd <= def.chainRange && dd < nd) { nd = dd; nxt = t; }
          }
          if (!nxt) break;
          d *= 0.7;
          hurtTarget(room, nxt, d, now, 'tesla');
          ev(room, { k: 'shot', x1: Math.round(last.x), y1: Math.round(last.y), x2: Math.round(nxt.x), y2: Math.round(nxt.y), c: def.color, w: 2, z: 1 });
          hit.push(nxt); last = nxt;
        }
      }
      if (room.winner) return;
    }
  }

  /* --------------------------------------------------------- projectiles */
  /* Bolts fly in a straight line and hit only what they actually run into, so
     stepping out of the way works. Substepped so a fast one cannot skip past a
     runner between ticks. */
  const flying = live ? targetsOf(room, now) : [];
  for (let i = room.projectiles.length - 1; i >= 0; i--) {
    const pr = room.projectiles[i];
    if (!live) { room.projectiles.splice(i, 1); continue; }

    if (pr.kind === 'bolt') {
      const dist = Math.hypot(pr.vx, pr.vy) * dt;
      const sub = Math.max(1, Math.ceil(dist / 8));
      let hit = false;
      for (let k = 0; k < sub && !hit; k++) {
        pr.x += pr.vx * dt / sub;
        pr.y += pr.vy * dt / sub;
        pr.left -= dist / sub;
        for (const t of flying) {
          if (t.p && (t.p.dead || t.p.ghostUntil > now)) continue;
          if (t.decoy && t.decoy.hp <= 0) continue;
          const tx = t.p ? t.p.x : t.decoy.x, ty = t.p ? t.p.y : t.decoy.y;
          if (Math.hypot(tx - pr.x, ty - pr.y) <= RUNNER_R + 4) {
            hurtTarget(room, t, pr.dmg, now, 'turret');
            ev(room, { k: 'spark', x: Math.round(pr.x), y: Math.round(pr.y), c: pr.c });
            hit = true;
            break;
          }
        }
      }
      const gone = pr.left <= 0 || pr.x < -30 || pr.y < -30 ||
                   pr.x > boardW(room) + 30 || pr.y > boardH(room) + 30;
      if (hit || gone) {
        if (!hit) ev(room, { k: 'fizzle', x: Math.round(pr.x), y: Math.round(pr.y), c: pr.c });
        room.projectiles.splice(i, 1);
      }
    } else if (pr.kind === 'lob') {
      pr.t += dt;
      const f = Math.min(1, pr.t / pr.dur);
      pr.x = pr.sx + (pr.tx - pr.sx) * f;
      pr.y = pr.sy + (pr.ty - pr.sy) * f;
      pr.h = Math.sin(f * Math.PI) * 46;
      if (f >= 1) { explode(room, pr.tx, pr.ty, pr.splash, pr.dmg, now, pr.c); room.projectiles.splice(i, 1); }
    }
    if (room.winner) return;
  }

  for (let i = room.meteors.length - 1; i >= 0; i--) {
    const m = room.meteors[i];
    if (now >= m.at) {
      explode(room, m.x, m.y, m.r, m.dmg, now, '#f97316');
      room.meteors.splice(i, 1);
    }
  }
}

function stepOnTrap(room, tw, p, now, dt) {
  const def = BUILD[tw.type];
  switch (def.kind) {
    case 'glue':
      p.slow = Math.min(p.slow, 1 - twSlow(tw));
      break;
    case 'saw':
      damage(room, p, twDmg(room, tw) * dt, now, 'saw');
      tw.firing = true;
      break;
    case 'spikes':
      if (now - (p.trapAt[tw.id] || 0) > twCd(tw) * 1000) {
        p.trapAt[tw.id] = now;
        damage(room, p, twDmg(room, tw), now, 'spikes');
      }
      break;
    case 'mine':
      explode(room, tw.x, tw.y, twSplash(tw), twDmg(room, tw), now, '#f97316');
      room.towers.delete(tw.gx + ',' + tw.gy);
      room.towersDirty = true;
      break;
    case 'snare':
      if (tw.cdUntil <= now) {
        tw.cdUntil = now + twCd(tw) * 1000;
        p.rootUntil = now + twRoot(tw) * 1000;
        ev(room, { k: 'snare', x: Math.round(p.x), y: Math.round(p.y), d: twRoot(tw) });
      }
      break;
    case 'portal':
      if (tw.cdUntil <= now) {
        tw.cdUntil = now + twCd(tw) * 1000;
        ev(room, { k: 'portal', x: Math.round(p.x), y: Math.round(p.y), id: p.id });
        placeAtStart(room, p, now);
        ev(room, { k: 'portalout', x: Math.round(p.x), y: Math.round(p.y), id: p.id });
      }
      break;
  }
}

function explode(room, x, y, radius, dmg, now, color) {
  ev(room, { k: 'boom', x: Math.round(x), y: Math.round(y), r: Math.round(radius), c: color });
  for (const p of runners(room)) {
    if (p.dead) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= radius + RUNNER_R) damage(room, p, dmg * (d < radius * 0.5 ? 1 : 0.6), now, 'boom');
  }
  for (const dc of room.decoys) {
    if (Math.hypot(dc.x - x, dc.y - y) <= radius + RUNNER_R) dc.hp -= dmg;
  }
}

/* ----------------------------------------------------------------- messages */
function gridMsg(room) {
  return JSON.stringify({ t: 'g', gw: room.set.gw, gh: room.set.gh, tiles: room.tiles, edit: room.edit });
}
function towersMsg(room) {
  const tw = [...room.towers.values()].map(t => ({
    id: t.id, ty: t.type, gx: t.gx, gy: t.gy, up: t.up, sp: t.spent,
  }));
  return JSON.stringify({ t: 'tw', tw });
}
function setMsg(room) { return JSON.stringify({ t: 'set', set: room.set }); }

function stateMsg(room, now) {
  const r = runners(room).map(p => ({
    id: p.id, n: p.name, x: Math.round(p.x), y: Math.round(p.y),
    hp: Math.round(p.hp), mh: Math.round(p.maxHp), sh: Math.round(p.shield),
    d: p.dead ? 1 : 0, pt: p.points, fin: p.finishes, dth: p.deaths, lap: p.laps, up: p.up,
    cd: abilityCds(p, now),
    gh: p.ghostUntil > now ? 1 : 0, ds: p.dashUntil > now ? 1 : 0, su: p.surgeUntil > now ? 1 : 0,
    rt: p.rootUntil > now ? 1 : 0, sl: p.slow < 1 ? 1 : 0, fr: p.inFrost ? 1 : 0,
    fx: Math.round(p.faceX * 100) / 100, fy: Math.round(p.faceY * 100) / 100,
    rs: p.dead ? Math.max(0, p.respawnAt - now) : 0,
  }));
  /* Only towers that are doing something send per-tick state; the rest are
     already known from the last 'tw' message. */
  const twd = [];
  for (const tw of room.towers.values()) {
    const dis = tw.disabledUntil > now ? 1 : 0;
    const cd = tw.cdUntil > now ? Math.round(tw.cdUntil - now) : 0;
    const aimChanged = tw.aim !== undefined && Math.abs((tw.aim || 0) - (tw.sentAim || 0)) > 0.04;
    if (!dis && !cd && !tw.firing && !aimChanged) continue;
    const o = { i: tw.id };
    if (aimChanged) { o.a = Math.round(tw.aim * 100) / 100; tw.sentAim = tw.aim; }
    if (tw.firing) o.f = 1;
    if (dis) o.d = 1;
    if (cd) o.c = cd;
    if (tw.type === 'laser' && tw.firing) { o.bx = tw.bx; o.by = tw.by; o.bt = Math.round((tw.beam || 0) * 100) / 100; }
    twd.push(o);
    if (tw.type === 'saw') tw.firing = false;
  }
  const msg = {
    t: 's', now, edit: room.edit ? 1 : 0, gold: Math.floor(room.gold),
    vpRun: room.vpRun, vpMM: room.vpMM, win: room.winner,
    winIn: room.winner ? Math.max(0, room.winUntil - now) : 0,
    mm: room.mm ? { id: room.mm.id, n: room.mm.name } : null,
    mmCd: mmCds(room, now),
    frz: Math.max(0, room.freezeUntil - now),
    od: Math.max(0, room.overdriveUntil - now),
    bo: Math.max(0, room.blackoutUntil - now),
    r, twd,
    pj: room.projectiles.map(p => ({
      x: Math.round(p.x), y: Math.round(p.y), c: p.c, h: Math.round(p.h || 0), k: p.kind,
      a: p.kind === 'bolt' ? Math.round(Math.atan2(p.vy, p.vx) * 100) / 100 : 0,
    })),
    mt: room.meteors.map(m => ({ x: m.x, y: m.y, r: m.r, in: Math.max(0, m.at - now) })),
    dc: room.decoys.map(d => ({ id: d.id, x: Math.round(d.x), y: Math.round(d.y), hp: Math.round(d.hp), mh: d.maxHp })),
    ev: room.events,
  };
  room.events = [];
  return JSON.stringify(msg);
}
function abilityCds(p, now) {
  const o = {};
  for (const k of ABILITY_KEYS) o[k] = Math.max(0, (p.cd[k] || 0) - now);
  return o;
}
function mmCds(room, now) {
  const o = {};
  for (const a in MM_ABILITIES) o[a] = Math.max(0, room.mmCd[a] - now);
  return o;
}

function broadcast(room, str) { for (const p of room.players.values()) send(p, str); }
function send(p, str) {
  if (p.ws.readyState === WebSocket.OPEN) { try { p.ws.send(str); } catch (e) { /* gone */ } }
}
function note(p, text, kind) { send(p, JSON.stringify({ t: 'msg', text, kind: kind || 'info' })); }
function shout(room, text, kind) { broadcast(room, JSON.stringify({ t: 'msg', text, kind: kind || 'info' })); }

/* ------------------------------------------------------------- the main loop */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0) {
      if (now - room.emptySince > 60 * 60 * 1000) rooms.delete(code);
      continue;
    }
    try { tick(room, now); } catch (e) { console.error('tick error', code, e); }
    if (room.gridDirty) { room.gridDirty = false; broadcast(room, gridMsg(room)); }
    if (room.towersDirty) { room.towersDirty = false; broadcast(room, towersMsg(room)); }
    broadcast(room, stateMsg(room, now));
  }
}, TICK_MS);

/* -------------------------------------------------------------- client input */
function clean(str, max) { return String(str || '').replace(/[^\w \-!?.']/g, '').trim().slice(0, max); }
function isInt(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

function onJoin(ws, m) {
  let code = clean(m.room, 8).toUpperCase().replace(/\s/g, '');
  if (!code) {
    do { code = ''; for (let i = 0; i < 4; i++) code += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]; }
    while (rooms.has(code));
  }
  const room = rooms.get(code) || makeRoom(code);
  const name = clean(m.name, 14) || ('Player' + nextPlayerId);
  const up = {};
  for (const k in UPGRADES) up[k] = 0;
  const p = {
    id: nextPlayerId++, ws, name, room, role: 'runner',
    x: 0, y: 0, hp: 100, maxHp: 100, shield: 0, shieldUntil: 0,
    dead: false, respawnAt: 0, points: 0, finishes: 0, deaths: 0, laps: 0,
    up, input: { dx: 0, dy: 0 }, faceX: 1, faceY: 0,
    dashUntil: 0, ghostUntil: 0, surgeUntil: 0, surgeMul: 1, rootUntil: 0,
    cd: {}, slow: 1, inFrost: false, lastHurt: 0, trapAt: {},
  };
  ws.player = p;
  room.players.set(p.id, p);
  if (m.role === 'mm' && !room.mm) { p.role = 'mm'; room.mm = p; }
  else if (m.role === 'mm') note(p, 'The Mastermind seat is taken by ' + room.mm.name + '. You are a runner for now.', 'warn');
  p.maxHp = rMaxHp(room, p); p.hp = p.maxHp;
  placeAtStart(room, p, Date.now());
  send(p, JSON.stringify({ t: 'w', id: p.id, role: p.role, room: code, name, defs: DEFS }));
  send(p, setMsg(room));
  send(p, gridMsg(room));
  send(p, towersMsg(room));
  shout(room, name + ' joined as ' + (p.role === 'mm' ? 'the Mastermind' : 'a runner') + '.');
}

/* Shared by single placement and the bucket fill. */
function canPlace(room, type, x, y) {
  const def = BUILD[type];
  if (!def || !inBounds(room, x, y)) return false;
  if (room.towers.has(x + ',' + y)) return false;
  const t = room.tiles[idx(room, x, y)];
  return def.onPath ? t === T.PATH : t === T.EMPTY;
}
function placeTower(room, type, x, y, cost, quiet) {
  const def = BUILD[type];
  const up = {};
  for (const tr of def.tracks) up[tr] = 0;
  room.gold -= cost;
  room.towers.set(x + ',' + y, {
    id: room.nextTid++, type, gx: x, gy: y, x: (x + 0.5) * CELL, y: (y + 0.5) * CELL,
    up, spent: cost, nextShot: 0, disabledUntil: 0, cdUntil: 0, aim: 0, sentAim: 0,
    firing: false, beam: 0, bx: 0, by: 0,
  });
  room.towersDirty = true;
  if (!quiet) ev(room, { k: 'build', x: (x + 0.5) * CELL, y: (y + 0.5) * CELL, c: def.color });
}

/* An optional rectangle of tiles, so the bulk actions can be aimed at one part
   of the board instead of all of it. */
function cleanArea(a) {
  if (!a || typeof a !== 'object') return null;
  const v = [a.x0, a.y0, a.x1, a.y1];
  if (!v.every(n => Number.isInteger(n))) return null;
  return { x0: Math.min(a.x0, a.x1), y0: Math.min(a.y0, a.y1),
           x1: Math.max(a.x0, a.x1), y1: Math.max(a.y0, a.y1) };
}
function inArea(area, tw) {
  return !area || (tw.gx >= area.x0 && tw.gx <= area.x1 && tw.gy >= area.y0 && tw.gy <= area.y1);
}

function setRole(p, role) {
  const room = p.room, now = Date.now();
  if (role === 'mm') {
    if (room.mm && room.mm !== p) { note(p, 'The Mastermind seat is taken.', 'warn'); return; }
    if (room.mm === p) return;
    p.role = 'mm'; room.mm = p; p.input = { dx: 0, dy: 0 };
    shout(room, p.name + ' is now the Mastermind.');
  } else {
    if (room.mm === p) room.mm = null;
    if (p.role === 'runner') return;
    p.role = 'runner'; p.dead = false; p.hp = p.maxHp;
    placeAtStart(room, p, now);
    shout(room, p.name + ' is now a runner.');
  }
  send(p, JSON.stringify({ t: 'role', role: p.role }));
}

function useAbility(room, p, key, now) {
  const lv = p.up[key];
  const def = UPGRADES[key];
  if (!def || def.kind !== 'ability') return;
  if (lv < 1) { note(p, 'Buy ' + def.name + ' first.', 'warn'); return; }
  if (room.blackoutUntil > now) { note(p, 'Blackout! No abilities right now.', 'warn'); return; }
  if ((p.cd[key] || 0) > now) return;
  const a = ABILITY[key](lv);
  const cd = a.cd * rHaste(p);

  switch (key) {
    case 'dash':
      p.dashUntil = now + a.dur;
      ev(room, { k: 'dash', x: Math.round(p.x), y: Math.round(p.y), fx: p.faceX, fy: p.faceY });
      break;
    case 'emp': {
      let n = 0;
      for (const tw of room.towers.values()) {
        if (Math.hypot(tw.x - p.x, tw.y - p.y) <= a.radius) { tw.disabledUntil = now + a.dur; n++; }
      }
      ev(room, { k: 'emp', x: Math.round(p.x), y: Math.round(p.y), r: Math.round(a.radius) });
      note(p, 'EMP! ' + n + ' tower' + (n === 1 ? '' : 's') + ' disabled.', n ? 'good' : 'info');
      break;
    }
    case 'ghost':
      p.ghostUntil = now + a.dur;
      ev(room, { k: 'ghost', x: Math.round(p.x), y: Math.round(p.y), id: p.id });
      break;
    case 'blink': {
      const sx = p.x, sy = p.y;
      let bx = p.x, by = p.y;
      for (let d = 6; d <= a.dist; d += 6) {
        const nx = p.x + p.faceX * d, ny = p.y + p.faceY * d;
        if (fits(room, nx, ny)) { bx = nx; by = ny; }
      }
      if (bx === p.x && by === p.y) { note(p, 'Nowhere to blink to.', 'warn'); return; }
      p.x = bx; p.y = by;
      ev(room, { k: 'blink', x1: Math.round(sx), y1: Math.round(sy), x2: Math.round(bx), y2: Math.round(by), id: p.id });
      break;
    }
    case 'shield':
      p.shield = a.amount; p.shieldUntil = now + a.dur;
      ev(room, { k: 'shieldup', x: Math.round(p.x), y: Math.round(p.y), id: p.id, a: a.amount });
      break;
    case 'decoy': {
      const d = { id: room.nextDid++, x: p.x, y: p.y, hp: a.hp, maxHp: a.hp, until: now + a.dur, owner: p.id };
      room.decoys.push(d);
      ev(room, { k: 'decoy', x: Math.round(p.x), y: Math.round(p.y) });
      break;
    }
    case 'surge':
      p.surgeUntil = now + a.dur; p.surgeMul = a.mul;
      ev(room, { k: 'surge', x: Math.round(p.x), y: Math.round(p.y), id: p.id });
      break;
    case 'medkit': {
      const before = p.hp;
      p.hp = Math.min(p.maxHp, p.hp + a.heal);
      ev(room, { k: 'heal', x: Math.round(p.x), y: Math.round(p.y), a: Math.round(p.hp - before) });
      break;
    }
  }
  p.cd[key] = now + cd;
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

    case 'act':
      if (p.role !== 'runner' || p.dead || room.edit || room.winner) break;
      useAbility(room, p, m.a, now);
      break;

    case 'upgrade': {
      if (p.role !== 'runner') break;
      const def = UPGRADES[m.key];
      if (!def) break;
      const lv = p.up[m.key];
      const cost = upgradeCost(room, m.key, lv);
      if (p.points < cost) { note(p, 'Need ' + cost + ' points for ' + def.name + '.', 'warn'); break; }
      p.points -= cost; p.up[m.key] = lv + 1;
      p.maxHp = rMaxHp(room, p);
      if (m.key === 'hp' && !p.dead) p.hp += 30 * (room.set.runnerHp / 100);
      ev(room, { k: 'levelup', x: Math.round(p.x), y: Math.round(p.y), id: p.id });
      note(p, def.name + ' is now level ' + p.up[m.key] + '.', 'good');
      break;
    }

    /* ---------------------------------------------- mastermind only below */
    case 'setting': {
      if (!isMM) break;
      const def = SETTINGS[m.key];
      if (!def) break;
      let v = Number(m.v);
      if (!Number.isFinite(v)) break;
      v = Math.max(def.min, Math.min(def.max, Math.round(v / def.step) * def.step));
      v = Math.round(v * 1000) / 1000;
      if (def.rebuild && !room.edit) { note(p, 'Map size can only change while editing the track.', 'warn'); break; }
      if (room.set[m.key] === v) break;
      if (m.key === 'gw') resize(room, v, room.set.gh);
      else if (m.key === 'gh') resize(room, room.set.gw, v);
      else room.set[m.key] = v;
      if (m.key === 'startGold' && room.edit) room.gold = v;
      broadcast(room, setMsg(room));
      break;
    }

    case 'mode': {
      if (!isMM) break;
      const wantEdit = !!m.edit;
      if (wantEdit === room.edit) break;
      if (!wantEdit && !pathConnected(room)) {
        note(p, 'The track needs a START, an END, and a connected path between them.', 'warn');
        break;
      }
      room.edit = wantEdit;
      room.projectiles = []; room.meteors = []; room.decoys = [];
      room.freezeUntil = 0; room.overdriveUntil = 0; room.blackoutUntil = 0;
      if (!wantEdit) room.roundStart = now;
      for (const r of runners(room)) {
        r.dead = false; r.hp = r.maxHp; r.shield = 0;
        placeAtStart(room, r, now);
      }
      room.gridDirty = true;
      shout(room, wantEdit ? 'The Mastermind is rebuilding the track. Runners wait at the start.'
                           : 'The track is LIVE. Run!', wantEdit ? 'warn' : 'good');
      break;
    }

    case 'paint': {
      if (!isMM || !room.edit) break;
      const x = m.x, y = m.y, tile = m.tile;
      if (!isInt(x, 0, room.set.gw - 1) || !isInt(y, 0, room.set.gh - 1) || !isInt(tile, 0, 3)) break;
      const i = idx(room, x, y);
      if (room.tiles[i] === tile) break;
      if (tile === T.START || tile === T.END) {
        const old = findTile(room, tile);
        if (old) room.tiles[idx(room, old.x, old.y)] = T.PATH;
      }
      room.tiles[i] = tile;
      const tw = room.towers.get(x + ',' + y);
      if (tw) {
        const onPath = !!BUILD[tw.type].onPath;
        if ((onPath && tile !== T.PATH) || (!onPath && tile !== T.EMPTY)) {
          room.gold += tw.spent; room.towers.delete(x + ',' + y); room.towersDirty = true;
        }
      }
      room.gridDirty = true;
      for (const r of runners(room)) placeAtStart(room, r, now);
      break;
    }

    case 'preset':
      if (!isMM || !room.edit) break;
      loadPreset(room, m.name);
      break;

    case 'tower': {
      if (!isMM) break;
      const def = BUILD[m.type];
      const x = m.x, y = m.y;
      if (!def || !isInt(x, 0, room.set.gw - 1) || !isInt(y, 0, room.set.gh - 1)) break;
      const key = x + ',' + y;
      if (room.towers.has(key)) { note(p, 'There is already something there.', 'warn'); break; }
      const t = room.tiles[idx(room, x, y)];
      if (def.onPath && t !== T.PATH) { note(p, def.name + ' is a trap: it goes on the path.', 'warn'); break; }
      if (!def.onPath && t !== T.EMPTY) { note(p, def.name + ' goes on empty ground, not the path.', 'warn'); break; }
      const cost = buildCost(room, m.type);
      if (room.gold < cost) { note(p, 'Not enough gold (' + cost + ' needed).', 'warn'); break; }
      placeTower(room, m.type, x, y, cost);
      break;
    }

    /* Bucket fill: spread outwards from the clicked tile, dropping one of these
       on every tile that will take one, until the gold runs out. */
    case 'fill': {
      if (!isMM) break;
      const def = BUILD[m.type];
      if (!def || !isInt(m.x, 0, room.set.gw - 1) || !isInt(m.y, 0, room.set.gh - 1)) break;
      const cost = buildCost(room, m.type);
      if (room.gold < cost) { note(p, 'Not enough gold (' + cost + ' needed).', 'warn'); break; }
      const w = room.set.gw, h = room.set.gh;
      const seen = new Uint8Array(w * h);
      const queue = [[m.x, m.y]];
      seen[m.y * w + m.x] = 1;
      let placed = 0, spent = 0, head = 0;
      while (head < queue.length && room.gold >= cost && placed < 600) {
        const [x, y] = queue[head++];
        if (canPlace(room, m.type, x, y)) {
          placeTower(room, m.type, x, y, cost, placed >= 50);
          placed++; spent += cost;
        }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (!inBounds(room, nx, ny) || seen[ny * w + nx]) continue;
          seen[ny * w + nx] = 1;
          queue.push([nx, ny]);
        }
      }
      note(p, placed ? 'Filled ' + placed + ' ' + def.name + (placed === 1 ? '' : 's') + ' for ' + spent + ' gold.'
                     : 'Nowhere to put a ' + def.name + ' from there.', placed ? 'good' : 'warn');
      break;
    }

    /* Mass upgrade: one track on every building of a type, cheapest first, with
       the whole bill added up and paid in one go. */
    case 'massUp': {
      if (!isMM) break;
      const def = BUILD[m.type];
      if (!def || !def.tracks.includes(m.track)) break;
      const area = cleanArea(m.area);
      const list = [...room.towers.values()].filter(tw => tw.type === m.type && inArea(area, tw));
      list.sort((a, b) => trackCost(room, a) - trackCost(room, b));
      let n = 0, spent = 0;
      for (const tw of list) {
        const c = trackCost(room, tw);
        if (room.gold < c) break;
        const was = twForm(tw);
        room.gold -= c; tw.spent += c; tw.up[m.track]++;
        spent += c; n++;
        if (twForm(tw) > was) {
          ev(room, { k: 'morph', x: tw.x, y: tw.y, c: def.color, f: twForm(tw),
            n: RULES.formName(def, tw.up) });
        } else if (n <= 40) {
          ev(room, { k: 'levelup', x: tw.x, y: tw.y, c: def.color, tower: 1 });
        }
      }
      if (n) {
        room.towersDirty = true;
        note(p, TRACKS[m.track].name + ' +1 on ' + n + ' ' + def.name +
          (n === 1 ? '' : 's') + ' for ' + spent + ' gold.', 'good');
      } else {
        note(p, list.length ? 'Not enough gold for that.' : 'No ' + def.name + ' to upgrade there.', 'warn');
      }
      break;
    }

    case 'sell': {
      if (!isMM) break;
      const key = m.x + ',' + m.y;
      const tw = room.towers.get(key);
      if (!tw) break;
      const refund = Math.round(tw.spent * 0.7);
      room.gold += refund; room.towers.delete(key); room.towersDirty = true;
      ev(room, { k: 'sell', x: tw.x, y: tw.y });
      note(p, 'Sold for ' + refund + ' gold.');
      break;
    }

    case 'tup': {
      if (!isMM) break;
      const tw = room.towers.get(m.x + ',' + m.y);
      if (!tw) break;
      const track = m.track;
      if (!BUILD[tw.type].tracks.includes(track)) break;
      const cost = trackCost(room, tw);
      if (room.gold < cost) { note(p, 'Need ' + cost + ' gold for that upgrade.', 'warn'); break; }
      const was = twForm(tw);
      room.gold -= cost; tw.spent += cost; tw.up[track]++;
      room.towersDirty = true;
      /* Every fifth upgrade grows the building into its next shape. */
      if (twForm(tw) > was) {
        const name = RULES.formName(BUILD[tw.type], tw.up);
        ev(room, { k: 'morph', x: tw.x, y: tw.y, c: BUILD[tw.type].color, f: twForm(tw), n: name });
        shout(room, BUILD[tw.type].name + ' grew into a ' + name + '!', 'warn');
      } else {
        ev(room, { k: 'levelup', x: tw.x, y: tw.y, c: BUILD[tw.type].color, tower: 1 });
      }
      break;
    }

    case 'ability': {
      if (!isMM || room.edit || room.winner) break;
      const ab = MM_ABILITIES[m.a];
      if (!ab) break;
      if (room.mmCd[m.a] > now) break;
      if (room.gold < ab.cost) { note(p, 'Need ' + ab.cost + ' gold for ' + ab.name + '.', 'warn'); break; }
      const x = Number(m.x), y = Number(m.y);
      if (ab.aim && (!Number.isFinite(x) || !Number.isFinite(y))) break;
      const cx = Math.max(0, Math.min(boardW(room), x)), cy = Math.max(0, Math.min(boardH(room), y));
      if (m.a === 'meteor') {
        room.meteors.push({ x: cx, y: cy, r: ab.radius, dmg: ab.dmg, at: now + ab.delay * 1000 });
      } else if (m.a === 'barrage') {
        for (let i = 0; i < ab.shells; i++) {
          const ang = Math.random() * Math.PI * 2, rad = Math.random() * 90;
          room.meteors.push({
            x: Math.max(0, Math.min(boardW(room), cx + Math.cos(ang) * rad)),
            y: Math.max(0, Math.min(boardH(room), cy + Math.sin(ang) * rad)),
            r: ab.radius, dmg: ab.dmg, at: now + 700 + i * 260,
          });
        }
      } else if (m.a === 'freeze') {
        room.freezeUntil = now + ab.dur * 1000;
        shout(room, 'FREEZE!', 'warn');
      } else if (m.a === 'overdrive') {
        room.overdriveUntil = now + ab.dur * 1000;
        shout(room, 'OVERDRIVE! Every tower is firing double time.', 'warn');
      } else if (m.a === 'blackout') {
        room.blackoutUntil = now + ab.dur * 1000;
        shout(room, 'BLACKOUT! Runner abilities are offline.', 'warn');
      }
      room.gold -= ab.cost; room.mmCd[m.a] = now + ab.cd * 1000;
      break;
    }

    case 'clearTowers': {
      if (!isMM) break;
      const area = cleanArea(m.area);
      let refund = 0, n = 0;
      for (const [key, tw] of [...room.towers]) {
        if (!inArea(area, tw)) continue;
        refund += tw.spent; room.towers.delete(key); n++;
      }
      room.gold += refund; room.towersDirty = true;
      note(p, n + ' sold for the full ' + refund + ' gold.');
      break;
    }

    case 'resetVp': {
      if (!isMM) break;
      room.vpRun = 0; room.vpMM = 0; room.winner = null;
      shout(room, 'Victory points reset.');
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
  room.decoys = room.decoys.filter(d => d.owner !== p.id);
  ws.player = null;
  if (room.players.size === 0) room.emptySince = Date.now();
  else shout(room, p.name + ' left.' + (p.role === 'mm' ? ' The Mastermind seat is open.' : ''));
}

/* --------------------------------------------------------------- websockets */
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

module.exports = { server, rooms, DEFS, SETTINGS, pathConnected, loadPreset, makeRoom, upgradeCost, trackCost };
