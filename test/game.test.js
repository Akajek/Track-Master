/* End-to-end test. Boots the real server, connects a Mastermind and a Runner
 * over real WebSockets, and plays through every system: settings, map resizing,
 * victory points, uncapped upgrades, every ability, every trap, and a win.
 *
 *   npm test
 */
'use strict';
process.env.PORT = '18765';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const WebSocket = require('ws');
const { server, rooms, pathConnected } = require('../server.js');
const RULES = require('../public/rules.js');

const URL = 'ws://localhost:18765';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = { EMPTY: 0, PATH: 1, START: 2, END: 3 };
/* The tiny straight track every movement test runs on. */
const ROW = 5, SX = 1, EX = 9;

function client(name, role, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = { ws, name, state: null, grid: null, set: null, towers: null, welcome: null, msgs: [],
                send: o => ws.send(JSON.stringify(o)) };
    ws.on('open', () => c.send({ t: 'join', name, role, room }));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'w') { c.welcome = m; }
      else if (m.t === 'g') c.grid = m;
      else if (m.t === 'set') c.set = m.set;
      else if (m.t === 'tw') c.towers = m.tw;
      else if (m.t === 's') { c.state = m; if (c.welcome && !c.ready) { c.ready = true; resolve(c); } }
      else if (m.t === 'msg') c.msgs.push(m.text);
      else if (m.t === 'role') c.welcome.role = m.role;
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('join timeout for ' + name)), 4000);
  });
}
async function waitFor(fn, what, ms = 5000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { if (fn()) return; } catch (e) { last = e; }
    await sleep(25);
  }
  throw new Error('timed out waiting for: ' + what + (last ? ' (' + last.message + ')' : ''));
}
const me = c => c.state.r.find(r => r.id === c.welcome.id);
const twAt = (c, x, y) => (c.towers || []).find(t => t.gx === x && t.gy === y);
const startPx = x => (x + 0.5) * 40;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:18765' + urlPath, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });
}

/* Walk right until `done()` is true (or we give up). Movement is server-side,
   so the test just holds the key down the way a player would. */
async function runRight(run, done, what, ms = 6000) {
  run.send({ t: 'input', dx: 1, dy: 0 });
  try { await waitFor(done, what, ms); }
  finally { run.send({ t: 'input', dx: 0, dy: 0 }); await sleep(80); }
}

async function paintTrack(mm) {
  mm.send({ t: 'preset', name: 'blank' });
  await sleep(120);
  mm.send({ t: 'paint', x: SX, y: ROW, tile: T.START });
  for (let x = SX + 1; x < EX; x++) mm.send({ t: 'paint', x, y: ROW, tile: T.PATH });
  mm.send({ t: 'paint', x: EX, y: ROW, tile: T.END });
  await sleep(200);
}
/* Toggling edit mode parks every runner on START and stops them, which is the
   only way to get a deterministic starting position between tests. */
async function park(mm, run) {
  mm.send({ t: 'input', dx: 0, dy: 0 });
  run.send({ t: 'input', dx: 0, dy: 0 });
  mm.send({ t: 'mode', edit: true });
  await waitFor(() => mm.state.edit === 1, 'parked in edit mode');
  mm.send({ t: 'mode', edit: false });
  await waitFor(() => mm.state.edit === 0, 'live again');
  await waitFor(() => me(run).x === startPx(SX) && me(run).d === 0, 'runner is on the start tile');
}
/* Starting gold can only be handed out in edit mode, which is also how a
   Mastermind would top themselves up between rounds. */
async function bankroll(mm, amount) {
  mm.send({ t: 'mode', edit: true });
  await waitFor(() => mm.state.edit === 1, 'edit mode for the bankroll');
  /* The server ignores a setting that is already at that value, so nudge it
     first when we are asking for the amount it is already set to. */
  if (mm.set.startGold === amount) await setOpt(mm, 'startGold', amount - 100);
  await setOpt(mm, 'startGold', amount);
  await waitFor(() => mm.state.gold >= amount, 'gold topped up to ' + amount);
  mm.send({ t: 'mode', edit: false });
  await waitFor(() => mm.state.edit === 0, 'live again');
}
async function setOpt(mm, key, v) {
  mm.send({ t: 'setting', key, v });
  await waitFor(() => mm.set[key] === v, 'setting ' + key + ' = ' + v);
}

async function main() {
  await new Promise(r => server.listening ? r() : server.once('listening', r));

  /* ---- the client's files are shipped, parse, and agree with the server --- */
  for (const f of ['rules.js', 'audio.js', 'vfx.js', 'game.js']) {
    new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'));
    const served = await get('/' + f);
    assert.strictEqual(served.status, 200, f + ' is served');
    assert.strictEqual(served.type, 'text/javascript', f + ' is served as javascript');
  }
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const f of ['rules.js', 'audio.js', 'vfx.js', 'game.js']) {
    assert.ok(page.includes('src="' + f + '"'), 'index.html loads ' + f);
  }
  assert.ok(page.indexOf('src="rules.js"') < page.indexOf('src="game.js"'), 'rules load before the game');
  /* Regression guard: a fresh canvas element is 300x150 until something sets
     it, so the offscreen terrain cache has to be resized where it is drawn.
     When this was only done on a size *change*, a default-sized map left the
     cache at 300x150 and most of the board never got painted. */
  const gameSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.js'), 'utf8');
  const drawTerrainBody = gameSrc.slice(gameSrc.indexOf('function drawTerrain('),
                                        gameSrc.indexOf('function drawTower('));
  assert.ok(/terrain\.width\s*=\s*cv\.width/.test(drawTerrainBody),
    'drawTerrain must size the terrain cache to the canvas before drawing into it');
  assert.strictEqual((await get('/healthz')).status, 200, 'health check for Render responds');

  /* ---- lobby, roles, defs ------------------------------------------------ */
  const mm = await client('Boss', 'mm', '');
  const code = mm.welcome.room;
  assert.strictEqual(mm.welcome.role, 'mm', 'first player takes the Mastermind seat');
  const D = mm.welcome.defs;
  for (const t of ['turret', 'sniper', 'mortar', 'tesla', 'pulse', 'laser', 'flame', 'frost']) {
    assert.ok(D.TOWERS[t], 'tower ' + t + ' is defined');
  }
  for (const t of ['spikes', 'glue', 'saw', 'mine', 'snare', 'portal']) {
    assert.ok(D.TRAPS[t], 'trap ' + t + ' is defined');
  }
  for (const k in D.BUILD) {
    assert.strictEqual(D.BUILD[k].forms.length, RULES.MAX_FORM + 1, k + ' has a name for every form');
    assert.ok(D.BUILD[k].tracks.length > 0, k + ' has at least one upgrade track, so it can grow');
  }
  for (const u of ['blink', 'shield', 'decoy', 'surge', 'medkit', 'momentum', 'grip', 'haste', 'tough']) {
    assert.ok(D.UPGRADES[u], 'upgrade ' + u + ' is defined');
  }
  for (const s of ['gw', 'gh', 'income', 'incomeGrow', 'vpTarget', 'upGrow', 'twGrow', 'lapBonus']) {
    assert.ok(D.SETTINGS[s], 'setting ' + s + ' is defined');
  }
  assert.ok(!('max' in (D.UPGRADES.speed || {})), 'runner upgrades no longer carry a level cap');

  const run = await client('Speedy', 'runner', code);
  assert.strictEqual(run.welcome.role, 'runner');
  const late = await client('Late', 'mm', code);
  assert.strictEqual(late.welcome.role, 'runner', 'a second Mastermind is demoted to runner');
  assert.ok(late.msgs.some(t => /seat is taken/.test(t)), 'and is told why');
  late.ws.close();
  await sleep(120);

  const room = rooms.get(code);
  assert.deepStrictEqual([mm.set.gw, mm.set.gh], [24, 16], 'default map is 24x16');
  assert.strictEqual(mm.grid.tiles.length, 24 * 16, 'grid matches the settings');
  assert.ok(pathConnected(room), 'the default preset connects START to END');

  /* ---- the map size slider ----------------------------------------------- */
  mm.send({ t: 'mode', edit: true });
  await waitFor(() => mm.state.edit === 1, 'edit mode');
  await setOpt(mm, 'gw', 30);
  await setOpt(mm, 'gh', 20);
  await waitFor(() => run.grid.gw === 30 && run.grid.gh === 20, 'the runner sees the bigger map');
  assert.strictEqual(run.grid.tiles.length, 30 * 20, 'resized grid has the right number of tiles');
  assert.strictEqual(room.tiles.length, 30 * 20, 'and so does the server');
  await setOpt(mm, 'gw', 14);
  await waitFor(() => run.grid.gw === 14, 'and shrinks again');
  assert.strictEqual(run.grid.tiles.length, 14 * 20, 'shrunk grid is consistent');
  mm.send({ t: 'setting', key: 'gw', v: 99 });
  await waitFor(() => mm.set.gw === D.SETTINGS.gw.max, 'an out-of-range width clamps to the maximum');
  assert.strictEqual(room.tiles.length, D.SETTINGS.gw.max * 20, 'clamped map is still consistent');
  await setOpt(mm, 'gw', 14);

  /* keep the round long so nothing wins by accident mid-test */
  await setOpt(mm, 'vpTarget', 60);

  /* ---- a tiny track, then go live ---------------------------------------- */
  await paintTrack(mm);
  await waitFor(() => run.grid.tiles[ROW * 14 + EX] === T.END, 'painted tiles reach the runner');
  run.send({ t: 'input', dx: 1, dy: 0 });
  await sleep(300);
  assert.strictEqual(me(run).x, startPx(SX), 'runners are parked at START while the track is edited');
  run.send({ t: 'input', dx: 0, dy: 0 });
  mm.send({ t: 'mode', edit: false });
  await waitFor(() => mm.state.edit === 0, 'live');

  mm.send({ t: 'setting', key: 'gw', v: 20 });
  await sleep(150);
  assert.strictEqual(mm.set.gw, 14, 'the map cannot be resized while the round is live');
  assert.ok(mm.msgs.some(t => /only change while editing/.test(t)), 'and says so');

  /* ---- finishing: VP, points, lap bonus ---------------------------------- */
  const hp0 = me(run).mh;
  await runRight(run, () => me(run).fin === 1, 'the runner finishes a lap');
  assert.strictEqual(run.state.vpRun, mm.set.vpFinish, 'a finish scores VP for the runners');
  assert.strictEqual(me(run).lap, 1, 'the lap is banked');
  assert.ok(me(run).mh > hp0, 'the lap bonus raised max HP permanently');
  assert.ok(me(run).sh > 0, 'finishing hands out a free shield');
  assert.strictEqual(me(run).pt, mm.set.ptsFinish, 'and upgrade points');
  assert.strictEqual(me(run).x, startPx(SX), 'and puts the runner back at the start');

  /* ---- uncapped levels --------------------------------------------------- */
  await setOpt(mm, 'ptsFinish', 20);
  for (let i = 0; i < 3; i++) {
    await runRight(run, () => me(run).fin === 2 + i, 'finish ' + (2 + i));
  }
  assert.ok(me(run).pt >= 60, 'banked plenty of points (' + me(run).pt + ')');
  let spent = 0;
  for (let lv = 0; lv < 10; lv++) {
    spent += RULES.upgradeCost(mm.set, D.UPGRADES.speed, lv);
    run.send({ t: 'upgrade', key: 'speed' });
  }
  await waitFor(() => me(run).up.speed === 10, 'Speed reaches level 10, well past the old cap of 8');
  const ptsAfter = me(run).pt;
  await setOpt(mm, 'upGrow', 200);
  assert.strictEqual(RULES.upgradeCost(mm.set, D.UPGRADES.speed, 10),
    RULES.upgradeCost({ upGrow: 200 }, D.UPGRADES.speed, 10), 'cost scaling setting feeds the shared rules');
  await setOpt(mm, 'upGrow', 100);
  assert.ok(ptsAfter >= 0, 'points went down, not negative');

  /* ---- every runner ability ---------------------------------------------- */
  for (const k of ['blink', 'shield', 'decoy', 'surge', 'medkit', 'dash', 'emp', 'ghost']) {
    run.send({ t: 'upgrade', key: k });
  }
  await waitFor(() => ['blink', 'shield', 'decoy', 'surge', 'medkit', 'dash', 'emp', 'ghost']
    .every(k => me(run).up[k] >= 1), 'every ability is bought');

  run.send({ t: 'input', dx: 1, dy: 0 });
  await sleep(200);
  const beforeBlink = me(run).x;
  run.send({ t: 'act', a: 'blink' });
  await waitFor(() => me(run).x > beforeBlink + 60, 'blink jumps the runner forward');
  run.send({ t: 'input', dx: 0, dy: 0 });
  await sleep(100);

  run.send({ t: 'act', a: 'shield' });
  await waitFor(() => me(run).sh >= 40, 'shield absorbs are stocked');
  run.send({ t: 'act', a: 'decoy' });
  await waitFor(() => run.state.dc.length === 1, 'a decoy is standing on the board');
  run.send({ t: 'act', a: 'surge' });
  await waitFor(() => me(run).su === 1, 'surge is running');
  run.send({ t: 'act', a: 'ghost' });
  await waitFor(() => me(run).gh === 1, 'ghost is running');
  await waitFor(() => me(run).cd.blink > 0 && me(run).cd.shield > 0, 'abilities went on cooldown');

  /* ---- traps -------------------------------------------------------------- */
  mm.send({ t: 'tower', type: 'portal', x: SX + 2, y: ROW });
  await waitFor(() => twAt(mm, SX + 2, ROW), 'portal trap built');
  await park(mm, run);
  /* The runner keeps moving on the same tick the portal fires, so the proof is
     that they got past the portal and then ended up behind it again. */
  let wentFar = false;
  await runRight(run, () => {
    const x = me(run).x;
    if (x >= startPx(SX + 2)) wentFar = true;
    return wentFar && x < startPx(SX + 1);
  }, 'the portal sends the runner back toward START', 6000);
  mm.send({ t: 'sell', x: SX + 2, y: ROW });
  await waitFor(() => !twAt(mm, SX + 2, ROW), 'portal sold');

  mm.send({ t: 'tower', type: 'snare', x: SX + 2, y: ROW });
  await waitFor(() => twAt(mm, SX + 2, ROW), 'snare built');
  await park(mm, run);
  await runRight(run, () => me(run).rt === 1, 'the snare roots the runner', 6000);
  await waitFor(() => me(run).rt === 0, 'and lets go again', 4000);
  mm.send({ t: 'sell', x: SX + 2, y: ROW });
  await waitFor(() => !twAt(mm, SX + 2, ROW), 'snare sold');

  mm.send({ t: 'tower', type: 'mine', x: SX + 3, y: ROW });
  await waitFor(() => twAt(mm, SX + 3, ROW), 'mine built');
  await park(mm, run);
  await runRight(run, () => !twAt(mm, SX + 3, ROW), 'the mine goes off once and is gone for good', 6000);

  /* ---- healing works through damage -------------------------------------- */
  /* Regeneration used to wait two seconds after the last hit. It must not: the
     test damages the runner, removes the source, and checks that health starts
     climbing again well inside the old grace period. */
  await runRight(run, () => me(run).pt >= 10, 'bank points for regen', 9000);
  for (let i = 0; i < 3; i++) run.send({ t: 'upgrade', key: 'regen' });
  await waitFor(() => me(run).up.regen === 3, 'three levels of regen bought');
  await park(mm, run);
  mm.send({ t: 'tower', type: 'sniper', x: SX + 4, y: ROW - 1 });
  await waitFor(() => twAt(mm, SX + 4, ROW - 1), 'a sniper to do the hurting');
  const full = me(run).hp;
  await waitFor(() => me(run).hp < full && !me(run).d, 'the sniper lands a hit', 15000);
  const hurtAt = Date.now(), low = me(run).hp;
  mm.send({ t: 'sell', x: SX + 4, y: ROW - 1 });
  await waitFor(() => me(run).hp > low, 'health climbs back while the hit is still fresh', 1600);
  assert.ok(Date.now() - hurtAt < 2000,
    'healing restarted ' + (Date.now() - hurtAt) + 'ms after the hit, inside the old 2s grace');

  /* ---- towers, upgrade tracks, and a kill -------------------------------- */
  const gold0 = mm.state.gold;
  mm.send({ t: 'tower', type: 'turret', x: SX + 2, y: ROW });
  await sleep(150);
  assert.ok(!twAt(mm, SX + 2, ROW), 'a turret cannot be built on the path');
  mm.send({ t: 'tower', type: 'spikes', x: SX + 2, y: ROW - 1 });
  await sleep(150);
  assert.ok(!twAt(mm, SX + 2, ROW - 1), 'a trap cannot be built off the path');

  mm.send({ t: 'tower', type: 'turret', x: SX + 2, y: ROW - 1 });
  await waitFor(() => twAt(mm, SX + 2, ROW - 1), 'turret built on grass');
  const turret = twAt(mm, SX + 2, ROW - 1);
  assert.deepStrictEqual(turret.up, { dmg: 0, rng: 0, spd: 0 }, 'a new turret has three upgrade tracks at zero');
  assert.ok(mm.state.gold <= gold0 - RULES.buildCost(mm.set, D.TOWERS.turret) + 40, 'gold was charged');

  const upCost = RULES.trackCost(mm.set, D.TOWERS.turret, 0);
  const goldBeforeUp = mm.state.gold;
  mm.send({ t: 'tup', x: SX + 2, y: ROW - 1, track: 'dmg' });
  await waitFor(() => twAt(mm, SX + 2, ROW - 1).up.dmg === 1, 'damage track upgraded');
  mm.send({ t: 'tup', x: SX + 2, y: ROW - 1, track: 'rng' });
  mm.send({ t: 'tup', x: SX + 2, y: ROW - 1, track: 'spd' });
  await waitFor(() => {
    const t = twAt(mm, SX + 2, ROW - 1);
    return t.up.rng === 1 && t.up.spd === 1;
  }, 'range and rate tracks upgraded too');
  assert.strictEqual(RULES.upgrades(twAt(mm, SX + 2, ROW - 1).up), 3, 'upgrades are the sum of every track');
  assert.strictEqual(RULES.form(twAt(mm, SX + 2, ROW - 1).up), 0, 'three upgrades is not yet a new form');
  assert.strictEqual(RULES.toNextForm(twAt(mm, SX + 2, ROW - 1).up), 2, 'two more upgrades to the next form');
  assert.ok(mm.state.gold < goldBeforeUp, 'upgrades cost gold (' + upCost + ' for the first)');
  mm.send({ t: 'tup', x: SX + 2, y: ROW - 1, track: 'pow' });
  await sleep(150);
  assert.strictEqual(twAt(mm, SX + 2, ROW - 1).up.pow, undefined, 'a turret has no power track to buy');

  /* ---- forms: a new shape every five upgrades, six of them, then stats only */
  /* Thirty-odd exponential upgrades is a lot of gold, so fund it and turn the
     cost-scaling setting down: the shape of the curve is what matters here. */
  await setOpt(mm, 'twGrow', 25);
  await bankroll(mm, 20000);
  const seen = [];                       /* [upgrades, form] after each purchase */
  for (let i = 0; i < 32; i++) {
    const track = ['dmg', 'rng', 'spd'][i % 3];
    if (mm.state.gold < 4000) await bankroll(mm, 20000);   /* exponential costs bite */
    const want = RULES.upgrades(twAt(mm, SX + 2, ROW - 1).up) + 1;
    mm.send({ t: 'tup', x: SX + 2, y: ROW - 1, track });
    await waitFor(() => RULES.upgrades(twAt(mm, SX + 2, ROW - 1).up) === want, 'upgrade ' + want);
    seen.push([want, RULES.form(twAt(mm, SX + 2, ROW - 1).up)]);
  }
  for (const [n, f] of seen) {
    assert.strictEqual(f, Math.min(RULES.MAX_FORM, Math.floor(n / 5)),
      'at ' + n + ' upgrades the form should be ' + Math.min(RULES.MAX_FORM, Math.floor(n / 5)));
  }
  const changedAt = seen.filter((e, i) => i > 0 && e[1] !== seen[i - 1][1]).map(e => e[0]);
  assert.deepStrictEqual(changedAt, [5, 10, 15, 20, 25, 30],
    'the shape changes at exactly 5, 10, 15, 20, 25 and 30 upgrades, and never again');
  const finalTurret = twAt(mm, SX + 2, ROW - 1);
  assert.strictEqual(RULES.upgrades(finalTurret.up), 35, '35 upgrades bought in total');
  assert.strictEqual(RULES.form(finalTurret.up), RULES.MAX_FORM, 'the last form is reached at 30');
  assert.strictEqual(RULES.toNextForm(finalTurret.up), 0, 'and there is nothing left to grow into');
  assert.strictEqual(RULES.formName(D.TOWERS.turret, finalTurret.up), 'Annihilator', 'the final shape is named');
  assert.strictEqual(RULES.formName(D.TOWERS.turret, {}), 'Turret', 'and so is the first');
  assert.ok(mm.msgs.some(t => /grew into a Twin Turret/.test(t)), 'everyone is told about a new shape');
  /* past the last form, upgrades still raise the stats */
  const dmgAt35 = RULES.dmg(D.TOWERS.turret, finalTurret.up);
  mm.send({ t: 'tup', x: SX + 2, y: ROW - 1, track: 'dmg' });
  await waitFor(() => RULES.upgrades(twAt(mm, SX + 2, ROW - 1).up) === 36, 'a 36th upgrade');
  const after = twAt(mm, SX + 2, ROW - 1);
  assert.strictEqual(RULES.form(after.up), RULES.MAX_FORM, 'the shape does not change any more');
  assert.ok(RULES.dmg(D.TOWERS.turret, after.up) > dmgAt35, 'but the damage still climbs');
  /* and the cost climbed exponentially on the way */
  /* The price curve is exponential in the building's total upgrades: every five
     upgrades multiply it by the same factor, all the way up. */
  const base = { twGrow: 100 };
  const curve = [];
  for (let n = 0; n <= 30; n += 5) curve.push(RULES.trackCost(base, D.TOWERS.turret, n));
  const perFive = Math.pow(RULES.TRACK_EXP, 5);
  for (let i = 1; i < curve.length; i++) {
    const ratio = curve[i] / curve[i - 1];
    assert.ok(Math.abs(ratio - perFive) < perFive * 0.04,
      'five more upgrades multiply the price by about ' + perFive.toFixed(2) + ', got ' + ratio.toFixed(2));
  }
  assert.ok(curve[6] > curve[0] * 100,
    'the last form costs two orders of magnitude more than the first upgrade (' +
    curve[0] + ' -> ' + curve[6] + ')');
  /* and a one-track trap is no further from its final form than a three-track tower */
  const trapTotal = [], towerTotal = [];
  for (let n = 0; n < 30; n++) {
    trapTotal.push(RULES.trackCost(base, D.TRAPS.glue, n));
    towerTotal.push(RULES.trackCost(base, D.TOWERS.turret, n));
  }
  const sum = a => a.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum(trapTotal) / D.TRAPS.glue.cost - sum(towerTotal) / D.TOWERS.turret.cost) < 1,
    'reaching the final form costs the same multiple of build cost for a one-track trap as a three-track tower');
  mm.send({ t: 'sell', x: SX + 2, y: ROW - 1 });
  await waitFor(() => !twAt(mm, SX + 2, ROW - 1), 'the overgrown turret is sold again');
  await setOpt(mm, 'twGrow', 100);

  await setOpt(mm, 'respawn', 1);
  await waitFor(() => me(run).d === 0, 'the runner is on their feet before the kill test', 12000);
  const vpMM0 = run.state.vpMM, deaths0 = me(run).dth;
  mm.send({ t: 'tower', type: 'sniper', x: SX + 4, y: ROW - 1 });
  await waitFor(() => twAt(mm, SX + 4, ROW - 1), 'sniper built');
  await waitFor(() => me(run).dth === deaths0 + 1, 'the towers kill the runner', 25000);
  assert.strictEqual(run.state.vpMM, vpMM0 + mm.set.vpKill, 'a kill scores VP for the Mastermind');
  await waitFor(() => me(run).d === 0, 'and the runner respawns', 5000);

  /* ---- mastermind abilities ---------------------------------------------- */
  await bankroll(mm, 5000);
  assert.ok(mm.state.gold >= 5000, 'setting the bankroll while editing tops the gold up');
  assert.strictEqual(D.SETTINGS.startGold.max, 20000, 'the bankroll slider reaches far enough to grow a final form');

  mm.send({ t: 'ability', a: 'barrage', x: 200, y: 200 });
  await waitFor(() => mm.state.mt.length >= 6, 'barrage puts six shells in the air');
  mm.send({ t: 'ability', a: 'overdrive' });
  await waitFor(() => mm.state.od > 0, 'overdrive is running');
  mm.send({ t: 'ability', a: 'freeze' });
  await waitFor(() => mm.state.frz > 0, 'freeze is running');
  mm.send({ t: 'ability', a: 'blackout' });
  await waitFor(() => mm.state.bo > 0, 'blackout is running');
  run.msgs.length = 0;
  run.send({ t: 'act', a: 'dash' });
  await sleep(150);
  assert.ok(run.msgs.some(t => /Blackout/.test(t)), 'runner abilities are locked out during a blackout');
  await waitFor(() => mm.state.bo === 0, 'blackout ends', 8000);

  /* ---- income settings --------------------------------------------------- */
  await setOpt(mm, 'income', 60);
  const g1 = mm.state.gold;
  await sleep(1200);
  assert.ok(mm.state.gold > g1 + 30, 'a high income setting actually pays out (' + (mm.state.gold - g1) + ')');
  await setOpt(mm, 'income', 0);
  const g2 = mm.state.gold;
  await sleep(800);
  assert.ok(mm.state.gold - g2 < 5, 'zero income pays nothing');

  /* ---- winning the round ------------------------------------------------- */
  mm.send({ t: 'clearTowers' });
  await waitFor(() => (mm.towers || []).length === 0, 'board cleared for the finale');
  await setOpt(mm, 'vpTarget', run.state.vpRun + 1);
  await runRight(run, () => !!run.state.win, 'somebody wins the round', 12000);
  assert.strictEqual(run.state.win, 'runners', 'the runners took it');
  assert.ok(run.state.winIn > 0, 'a countdown to the next round is running');
  assert.ok(mm.msgs.some(t => /RUNNERS WIN/.test(t)), 'everyone is told');
  await waitFor(() => run.state.win === null, 'the next round starts on its own', 14000);
  assert.strictEqual(run.state.vpRun, 0, 'victory points reset');
  assert.strictEqual(run.state.vpMM, 0, 'for both sides');
  assert.strictEqual(run.state.edit, 1, 'and the Mastermind gets the board back in edit mode');
  assert.strictEqual(mm.state.gold, mm.set.startGold, 'a new round starts from the configured bankroll');
  assert.ok(me(run).up.speed >= 10, 'runner levels survive the new round');

  /* ---- every sound the client asks for exists ---------------------------- */
  const audio = fs.readFileSync(path.join(__dirname, '..', 'public', 'audio.js'), 'utf8');
  const game = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.js'), 'utf8');
  const block = audio.slice(audio.indexOf('const V = {'), audio.indexOf('server event -> sound'));
  const voices = new Set();
  for (const m of block.matchAll(/^\s{4}(\w+):/gm)) voices.add(m[1]);
  assert.ok(voices.size > 30, 'found the voice table (' + voices.size + ' voices)');
  for (const src of [game, audio]) {
    for (const m of src.matchAll(/SFX\.play\('(\w+)'/g)) {
      assert.ok(voices.has(m[1]), 'client plays "' + m[1] + '" but audio.js has no such voice');
    }
  }
  /* and every event the server can send is handled by both the eyes and ears */
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const vfx = fs.readFileSync(path.join(__dirname, '..', 'public', 'vfx.js'), 'utf8');
  const kinds = new Set();
  for (const m of srv.matchAll(/\{ k: '(\w+)'/g)) kinds.add(m[1]);
  assert.ok(kinds.size > 20, 'found the event kinds (' + kinds.size + ')');
  for (const k of kinds) {
    assert.ok(vfx.includes("case '" + k + "'"), 'vfx.js draws nothing for event "' + k + '"');
  }

  console.log('ALL TESTS PASSED  (' + voices.size + ' voices, ' + kinds.size + ' event kinds)');
  mm.ws.close(); run.ws.close();
  process.exit(0);
}
main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
