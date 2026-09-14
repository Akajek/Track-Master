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
const { server, rooms, pathConnected, findTiles, tunnelPartner } = require('../server.js');
const RULES = require('../public/rules.js');

const URL = 'ws://localhost:18765';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = { EMPTY: 0, PATH: 1, START: 2, END: 3, STEEP: 4, TUNNEL: 5 };
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
      else if (m.t === 'ul') c.ul = m;
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
/* The armoury opens by hurting people, which most of these tests are not
   about. The unlock flow itself is tested for real further down; here the
   points are handed over directly and then spent through the real message, so
   the rest of the suite can reach for any building it likes. */
async function openArmoury(mm, room, D) {
  room.unlockPts = D.UNLOCKABLE.length + 2;
  for (const k of D.UNLOCKABLE) mm.send({ t: 'unlock', key: k });
  await waitFor(() => D.UNLOCKABLE.every(k => room.unlocked.has(k)), 'every building unlocked');
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
  assert.ok(page.includes('id="hud"'), 'the page has an ability HUD');
  assert.ok(gameSrc.includes('function buildHud'), 'and the client builds it');
  assert.ok(gameSrc.includes('function updateHud'), 'and keeps it up to date');
  /* Regression guard for the swallowed-click bug: the selected-building panel
     must not rebuild its DOM from the gold total, or the button you are
     clicking gets destroyed between mousedown and click. */
  const panelBody = gameSrc.slice(gameSrc.indexOf('function updateTowerPanel('),
                                  gameSrc.indexOf('function updateRunner('));
  assert.ok(!/S\.gold/.test(panelBody.slice(0, panelBody.indexOf('function refreshTowerPanel'))),
    'updateTowerPanel/buildTowerPanel must not key off the gold total');
  assert.ok(/panelFor !== tw\.id/.test(panelBody),
    'the panel DOM is rebuilt only when a different building is selected');
  assert.strictEqual((panelBody.match(/innerHTML = ''/g) || []).length, 1,
    'exactly one place clears the panel, and it is the per-building build');
  /* The same bug, generalised: NOTHING on the per-snapshot update path may
     assign innerHTML, because that rebuilds the children twenty times a second
     and any element rebuilt under the pointer swallows the click. Markup goes
     through setHtml(), which writes only when the string has actually changed. */
  assert.ok(/function setHtml\(/.test(gameSrc), 'the client has a change-guarded markup writer');
  const perFrame = ['updateSide', 'updateMM', 'refreshTowerPanel', 'updateRunner', 'updateHud'];
  const bounds = {
    updateSide: 'function updateMM(', updateMM: 'function updateTowerPanel(',
    refreshTowerPanel: 'function lvLabel(', updateRunner: 'function setTool(',
    updateHud: '/* ================================================================ canvas io */',
  };
  for (const fn of perFrame) {
    const from = gameSrc.indexOf('function ' + fn + '(');
    const to = gameSrc.indexOf(bounds[fn], from);
    assert.ok(from >= 0 && to > from, 'found ' + fn + ' to check');
    const body = gameSrc.slice(from, to);
    assert.ok(!/\.innerHTML\s*=/.test(body),
      fn + ' runs on every snapshot, so it must use setHtml() and never assign innerHTML');
  }
  assert.strictEqual((await get('/healthz')).status, 200, 'health check for Render responds');

  /* ---- lobby, roles, defs ------------------------------------------------ */
  const mm = await client('Boss', 'mm', '');
  const code = mm.welcome.room;
  assert.strictEqual(mm.welcome.role, 'mm', 'first player takes the Mastermind seat');
  const D = mm.welcome.defs;
  for (const t of ['turret', 'sniper', 'mortar', 'tesla', 'pulse', 'laser', 'flame', 'frost']) {
    assert.ok(D.TOWERS[t], 'tower ' + t + ' is defined');
  }
  for (const t of ['spikes', 'glue', 'saw', 'mine', 'snare', 'portal', 'tar', 'jolt']) {
    assert.ok(D.TRAPS[t], 'trap ' + t + ' is defined');
  }
  for (const k in D.BUILD) {
    assert.strictEqual(D.BUILD[k].forms.length, RULES.MAX_FORM + 1, k + ' has a name for every form');
    assert.ok(D.BUILD[k].tracks.length > 0, k + ' has at least one upgrade track, so it can grow');
  }
  for (const u of ['blink', 'shield', 'decoy', 'surge', 'medkit', 'momentum', 'grip', 'haste', 'tough',
                   'nova', 'barrier', 'healpow', 'oocheal', 'trapres', 'dodge', 'deflect',
                   'resBullet', 'resFire', 'resEnergy']) {
    assert.ok(D.UPGRADES[u], 'upgrade ' + u + ' is defined');
  }
  for (const s of ['gw', 'gh', 'income', 'incomeGrow', 'vpTarget', 'upGrow', 'twGrow', 'lapBonus',
                   'multiEnds', 'steepSlow', 'escapeBase', 'escapeLap', 'endResist', 'unlockRate',
                   'slotStart']) {
    assert.ok(D.SETTINGS[s], 'setting ' + s + ' is defined');
  }
  assert.ok(D.SETTINGS.multiEnds.bool, 'the several-STARTs option is a toggle, not a slider');
  assert.ok(!('max' in (D.UPGRADES.speed || {})), 'runner upgrades no longer carry a level cap');
  /* the HUD draws itself from these, so every ability needs an icon */
  for (const k of D.ABILITY_KEYS) assert.ok(D.UPGRADES[k].icon, 'runner ability ' + k + ' has a HUD icon');
  for (const k in D.MM_ABILITIES) assert.ok(D.MM_ABILITIES[k].icon, 'mastermind ability ' + k + ' has a HUD icon');

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

  /* ---- the armoury: damage buys unlock points, points buy buildings ------ */
  /* A Mastermind now opens the round with almost nothing. The expensive,
     round-ending toys have to be earned by actually hurting somebody, which is
     the whole early-game nerf in one mechanic. */
  assert.deepStrictEqual([...D.UNLOCK_START].sort(), ['glue', 'meteor', 'spikes', 'turret'],
    'the Mastermind starts with a turret, spikes, glue and the meteor');
  for (const k of D.UNLOCK_START) assert.ok(room.unlocked.has(k), k + ' is unlocked from the start');
  assert.ok(!room.unlocked.has('sniper'), 'the sniper is not');
  assert.strictEqual(mm.state.up, 0, 'and there are no unlock points yet');

  mm.msgs.length = 0;
  mm.send({ t: 'tower', type: 'sniper', x: SX + 3, y: ROW - 1 });
  await sleep(150);
  assert.ok(!twAt(mm, SX + 3, ROW - 1), 'a locked building cannot be placed');
  assert.ok(mm.msgs.some(t => /still locked/.test(t)), 'and the Mastermind is told why');

  await setOpt(mm, 'unlockRate', 25);        /* keep the test quick, not the mechanic soft */
  mm.send({ t: 'tower', type: 'turret', x: SX, y: ROW - 2 });
  await waitFor(() => twAt(mm, SX, ROW - 2), 'a turret they already own');
  const need0 = mm.state.upn;
  assert.ok(need0 > 0, 'the bar has a target to reach (' + need0 + ' damage)');
  await waitFor(() => mm.state.up >= 1, 'hurting the runner earns an unlock point', 20000);
  assert.ok(mm.state.upn > need0, 'and the next point costs more damage than the first');
  /* Stop the shooting before counting points, or the bar fills again while we
     are looking at it. Edit mode is the only way to be sure. */
  mm.send({ t: 'sell', x: SX, y: ROW - 2 });
  await waitFor(() => !twAt(mm, SX, ROW - 2), 'turret cleared away');
  mm.send({ t: 'mode', edit: true });
  await waitFor(() => mm.state.edit === 1, 'edit mode, so nothing else earns a point');
  await sleep(200);
  const ptsHeld = room.unlockPts;
  mm.send({ t: 'unlock', key: 'sniper' });
  await waitFor(() => room.unlocked.has('sniper'), 'the point buys the sniper');
  assert.strictEqual(room.unlockPts, ptsHeld - 1, 'and is spent doing it');
  assert.ok(mm.msgs.some(t => /unlocked the Sniper/.test(t)), 'everyone hears about it');
  mm.send({ t: 'mode', edit: false });
  await waitFor(() => mm.state.edit === 0, 'live again after the unlock');
  await setOpt(mm, 'unlockRate', 100);
  await openArmoury(mm, room, D);
  assert.ok(room.unlocked.has('laser') && room.unlocked.has('barrage'), 'the rest of the armoury is open');

  /* ---- holding the END --------------------------------------------------- */
  /* Reaching the END is a touch; escaping is a hold. The clock resets the
     moment a runner steps off, which is what makes a defended END a fight. */
  await setOpt(mm, 'escapeBase', 1.5);
  await setOpt(mm, 'escapeLap', 0);
  await park(mm, run);
  run.send({ t: 'input', dx: 1, dy: 0 });
  await waitFor(() => me(run).esc > 0, 'the escape clock starts on the END tile', 8000);
  assert.strictEqual(me(run).fin, 0, 'and a touch alone is not a finish');
  assert.ok(me(run).en >= 1400, 'the hold is as long as the setting says (' + me(run).en + 'ms)');
  run.send({ t: 'input', dx: -1, dy: 0 });
  await waitFor(() => me(run).esc === 0, 'stepping off resets it to zero', 4000);
  assert.strictEqual(me(run).fin, 0, 'still not a finish');
  await setOpt(mm, 'escapeBase', 0.4);
  await runRight(run, () => me(run).fin === 1, 'holding it through does finish', 9000);
  run.send({ t: 'input', dx: 0, dy: 0 });
  await sleep(100);
  /* the Mastermind can buy more of that hold, which is the late-game buff */
  const scaling = { escapeBase: 0.5, escapeLap: 0.25 };
  const holdWas = RULES.escapeMs(scaling, 0, 0);
  assert.strictEqual(holdWas, 500, 'the hold starts at half a second, as asked');
  assert.ok(RULES.escapeMs(scaling, 0, 1) > holdWas, 'Lockdown lengthens the hold');
  assert.ok(RULES.escapeMs(scaling, 4, 0) > holdWas, 'and so does every win the runner banks');
  assert.strictEqual(D.SETTINGS.escapeBase.def, 0.5, 'and half a second is the default');

  /* ---- finishing: VP, points, lap bonus ---------------------------------- */
  const hp0 = me(run).mh, vp0 = run.state.vpRun, pts0 = me(run).pt, lap0 = me(run).lap;
  await park(mm, run);
  await runRight(run, () => me(run).fin === 2, 'the runner finishes another lap');
  assert.strictEqual(run.state.vpRun, vp0 + mm.set.vpFinish, 'a finish scores VP for the runners');
  assert.strictEqual(me(run).lap, lap0 + 1, 'the lap is banked');
  assert.ok(me(run).mh > hp0, 'the lap bonus raised max HP permanently');
  assert.ok(me(run).sh > 0, 'finishing hands out a free shield');
  assert.strictEqual(me(run).pt, pts0 + mm.set.ptsFinish, 'and upgrade points');
  assert.strictEqual(me(run).x, startPx(SX), 'and puts the runner back at the start');

  /* ---- uncapped levels --------------------------------------------------- */
  await setOpt(mm, 'ptsFinish', 20);
  for (let i = 0; i < 3; i++) {
    await park(mm, run);
    await runRight(run, () => me(run).fin === 3 + i, 'finish ' + (3 + i));
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

  /* ---- diminishing returns ----------------------------------------------- */
  /* Nothing is capped and nothing is unlimited. Past the soft cap a level is
     worth less than the one before it, forever, and the client is given the
     effective number so it can say so out loud. */
  assert.strictEqual(RULES.eff(10), 10, 'below the soft cap a level is worth a level');
  assert.strictEqual(RULES.eff(RULES.DR_START), RULES.DR_START, 'and right up to it');
  for (let lv = RULES.DR_START; lv < 60; lv++) {
    const step = RULES.eff(lv + 1) - RULES.eff(lv);
    const prev = RULES.eff(lv) - RULES.eff(lv - 1);
    assert.ok(step > 0, 'level ' + (lv + 1) + ' is still worth something');
    assert.ok(step < prev, 'and worth less than level ' + lv);
  }
  assert.ok(RULES.eff(500) < RULES.DR_START + RULES.DR_REACH + 0.01, 'the curve converges instead of exploding');
  assert.ok(RULES.speedEff(40) < RULES.eff(40), 'speed is on a harsher curve than everything else');
  /* the bug this fixes: unlimited speed used to cross the whole board in a tick */
  const board = mm.set.gw * 40;
  assert.ok(RULES.speed(mm.set, { speed: 200 }, 0) * 0.05 < board / 3,
    'even an absurdly levelled runner cannot cross a third of the board in one tick');
  assert.ok(RULES.abEff(RULES.AB_CAP) === RULES.AB_CAP, 'abilities pay full value to their cap');
  assert.ok(RULES.abEff(30) < RULES.AB_CAP + RULES.AB_REACH + 0.01, 'and barely move past it');
  assert.ok(RULES.softCapped('speed', 'passive', RULES.DR_START + 1), 'a passive past 15 is flagged');
  assert.ok(!RULES.softCapped('speed', 'passive', RULES.DR_START), 'and not before');
  assert.ok(RULES.softCapped('dash', 'ability', RULES.AB_CAP + 1), 'an ability past 5 is flagged');
  for (const lv of [1, 5, 10, 20, 50, 200]) {
    assert.ok(RULES.dodgeChance({ dodge: lv }) < RULES.DODGE_MAX, 'dodge at ' + lv + ' stays under the ceiling');
    assert.ok(RULES.deflectChance({ deflect: lv }) < RULES.DODGE_MAX, 'deflection at ' + lv + ' does too');
  }
  assert.ok(RULES.dodgeChance({ dodge: 12 }) > 0.25, 'but a heavy investment still gets most of the way there');
  const gameSrcDr = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.js'), 'utf8');
  assert.ok(/function lvLabel/.test(gameSrcDr) && /eff /.test(gameSrcDr),
    'the client shows the effective level, not just the raw one');
  assert.ok(/diminishing/.test(gameSrcDr), 'and says the word out loud');

  /* ---- ability slots ------------------------------------------------------ */
  /* Four slots to start with. A fifth ability needs a slot bought first, which
     is what stops a runner simply owning everything. */
  assert.strictEqual(me(run).sx, mm.set.slotStart, 'a runner starts with the configured slots');
  const fourAbilities = ['blink', 'shield', 'decoy', 'surge'];
  for (const k of fourAbilities) run.send({ t: 'upgrade', key: k });
  await waitFor(() => fourAbilities.every(k => me(run).up[k] >= 1), 'four abilities fill four slots');
  run.msgs.length = 0;
  run.send({ t: 'upgrade', key: 'medkit' });
  await sleep(200);
  assert.strictEqual(me(run).up.medkit, 0, 'a fifth will not fit');
  assert.ok(run.msgs.some(t => /No free ability slot/.test(t)), 'and the runner is told why');
  run.send({ t: 'upgrade', key: 'blink' });
  await waitFor(() => me(run).up.blink === 2, 'but levelling one you already hold is fine');

  const slotCost = RULES.slotCost(mm.set, me(run).sx);
  assert.ok(RULES.slotCost(mm.set, me(run).sx + 1) > slotCost, 'each slot costs more than the last');
  if (me(run).pt < slotCost) {
    await park(mm, run);
    await runRight(run, () => me(run).pt >= slotCost, 'bank enough points for a slot', 12000);
  }
  const ptsBeforeSlot = me(run).pt;
  run.send({ t: 'slot' });
  await waitFor(() => me(run).sx === mm.set.slotStart + 1, 'a slot is bought');
  assert.strictEqual(me(run).pt, ptsBeforeSlot - slotCost, 'and paid for');
  run.send({ t: 'upgrade', key: 'medkit' });
  await waitFor(() => me(run).up.medkit >= 1, 'now the fifth ability fits');

  /* dropping one hands most of the points back and frees the slot again */
  const ptsBeforeDrop = me(run).pt;
  run.send({ t: 'drop', key: 'decoy' });
  await waitFor(() => me(run).up.decoy === 0, 'an ability can be dropped');
  assert.ok(me(run).pt > ptsBeforeDrop, 'for most of its points back');
  run.send({ t: 'upgrade', key: 'decoy' });
  await waitFor(() => me(run).up.decoy >= 1, 'and the freed slot takes something again');

  /* ---- every runner ability ---------------------------------------------- */
  await park(mm, run);
  await runRight(run, () => me(run).pt >= 80, 'bank enough points for the whole kit', 20000);
  await setOpt(mm, 'slotStart', 9);
  await waitFor(() => me(run).sx >= 9, 'raising the setting hands out the slots live');
  for (const k of ['blink', 'shield', 'decoy', 'surge', 'medkit', 'dash', 'emp', 'ghost', 'nova']) {
    run.send({ t: 'upgrade', key: k });
  }
  await waitFor(() => ['blink', 'shield', 'decoy', 'surge', 'medkit', 'dash', 'emp', 'ghost', 'nova']
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

  /* ---- the ultimate ------------------------------------------------------- */
  /* One slot, one SUPER BUFF, one enormous cooldown, and a potency that is the
     chosen stat raised to the 2.5 -- capped per stat, because a thirty times
     move speed is not a super buff, it is a crash. */
  assert.strictEqual(RULES.ULT_EXP, 2.5, 'the potency exponent is the one that was asked for');
  for (const k in RULES.ULTS) {
    const u = RULES.ULTS[k];
    assert.ok(u.name && u.icon && u.stat && u.cap, k + ' is a complete SUPER BUFF');
    assert.ok(RULES.ultMul(k, 1) > 1.5, k + ' at level 1 is already a big number');
    assert.ok(RULES.ultMul(k, 99) <= u.cap, k + ' never passes its own cap');
  }
  assert.ok(RULES.ultPotency(2) > RULES.ultPotency(1), 'levelling the ultimate makes it stronger');
  assert.ok(RULES.ultPotency(1) > Math.pow(1.6, 2) , 'and the exponent is doing real work');

  run.msgs.length = 0;
  run.send({ t: 'ult' });
  await sleep(150);
  assert.strictEqual(me(run).uu, 0, 'the ultimate does nothing before it is bought');
  assert.ok(run.msgs.some(t => /Buy the ultimate slot/.test(t)), 'and says so');
  const ultCost = RULES.ultCost(mm.set, 0);
  assert.ok(RULES.ultCost(mm.set, 1) > ultCost, 'the next level costs more');
  run.send({ t: 'upgrade', key: 'ultimate' });
  await waitFor(() => me(run).up.ultimate === 1, 'the ultimate slot is bought');
  run.msgs.length = 0;
  run.send({ t: 'ult' });
  await sleep(150);
  assert.strictEqual(me(run).uu, 0, 'still nothing with no SUPER BUFF chosen');
  assert.ok(run.msgs.some(t => /SUPER BUFF/.test(t)), 'and it asks for one');
  run.send({ t: 'pickUlt', u: 'flash' });
  await waitFor(() => me(run).ul === 'flash', 'Flash Step is loaded into the slot');
  run.send({ t: 'ult' });
  await waitFor(() => me(run).uu > 0, 'and it fires');
  assert.ok(me(run).uc > 60000, 'onto a very long cooldown (' + Math.round(me(run).uc / 1000) + 's)');
  run.send({ t: 'pickUlt', u: 'iron' });
  await sleep(150);
  assert.strictEqual(me(run).ul, 'flash', 'the choice cannot be swapped mid-flight');
  await waitFor(() => me(run).uu === 0, 'the ultimate runs out', 9000);
  run.send({ t: 'pickUlt', u: 'iron' });
  await waitFor(() => me(run).ul === 'iron', 'and can be re-chosen once it is done');
  run.send({ t: 'pickUlt', u: 'flash' });
  await waitFor(() => me(run).ul === 'flash', 'back to Flash Step');

  /* ---- healing nova ------------------------------------------------------- */
  /* Heals you and anyone within two blocks, which is the only ability in the
     game that helps somebody else. */
  const novaDef = RULES.ability.nova(1);
  assert.strictEqual(novaDef.radius, 80, 'the nova reaches exactly two blocks');
  assert.ok(novaDef.heal > 0, 'and heals something');
  const mate = await client('Buddy', 'runner', code);
  await park(mm, run);
  await waitFor(() => mate.state.r.length === 2, 'a second runner joined');
  /* hurt them both, then heal them both with one press. A pulse, because it
     hits everything in range at once and two runners standing on the same
     start tile would otherwise share a single bolt between them. */
  mm.send({ t: 'tower', type: 'pulse', x: SX, y: ROW - 1 });
  await waitFor(() => twAt(mm, SX, ROW - 1), 'a pulse to do the hurting');
  const lowBoth = () => run.state.r.length === 2 && run.state.r.every(r => r.hp < r.mh - 15 && !r.d);
  await waitFor(lowBoth, 'both runners are hurt', 20000);
  mm.send({ t: 'sell', x: SX, y: ROW - 1 });
  await sleep(120);
  const before2 = {};
  for (const r of run.state.r) before2[r.id] = r.hp;
  run.send({ t: 'act', a: 'nova' });
  await waitFor(() => run.state.r.every(r => r.hp > before2[r.id] + 10),
    'one nova heals both runners at once', 3000);
  assert.ok(RULES.healPow({ healpow: 6 }) > RULES.healPow({ healpow: 0 }),
    'Healing Power multiplies what a nova is worth');
  mate.ws.close();
  await sleep(200);
  await park(mm, run);

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

  /* ---- balance: the reliable weapons hit softer than the dodgeable ones --- */
  const dps = t => (t.rate ? t.dmg * t.rate : t.dps) || 0;
  const turretDps = dps(D.TOWERS.turret);
  for (const t of ['sniper', 'tesla', 'pulse', 'laser', 'flame']) {
    assert.ok(dps(D.TOWERS[t]) < turretDps,
      t + ' cannot be dodged, so it must do less damage per second than the turret (' +
      dps(D.TOWERS[t]).toFixed(1) + ' vs ' + turretDps.toFixed(1) + ')');
  }
  assert.ok(D.TOWERS.sniper.dmg < RULES.maxHp(mm.set, { hp: 0 }, 0) / 3,
    'no single sniper shot takes a third of a fresh runner');
  assert.ok(RULES.slow({ slow: 0.9 }, { pow: 99 }) <= RULES.MAX_SLOW,
    'a slow can never reach a full stop, however upgraded');
  assert.ok(RULES.root({ root: 1 }, { pow: 30 }) < 6, 'roots grow linearly, not exponentially');
  /* the two global dials actually move the numbers */
  assert.ok(RULES.dmg(D.TOWERS.turret, {}, { towerPower: 50 }) * 2 ===
            RULES.dmg(D.TOWERS.turret, {}, { towerPower: 100 }), 'the tower damage dial scales damage');
  assert.ok(RULES.maxHp({ lapBonus: 6, runnerHp: 200 }, { hp: 0 }, 0) >
            RULES.maxHp({ lapBonus: 6, runnerHp: 100 }, { hp: 0 }, 0), 'the runner health dial scales health');
  for (const k of ['towerPower', 'runnerHp']) assert.ok(D.SETTINGS[k], k + ' is a slider the Mastermind can move');

  /* ---- projectiles fly, and can be dodged -------------------------------- */
  assert.ok(D.TOWERS.turret.tracks.includes('vel'), 'the turret sells a projectile speed track');
  assert.ok(D.TOWERS.mortar.tracks.includes('vel'), 'so does the mortar');
  for (const t of ['laser', 'sniper', 'tesla', 'pulse', 'flame', 'frost']) {
    assert.ok(!D.TOWERS[t].tracks.includes('vel'), t + ' launches nothing, so it has no velocity track');
  }
  assert.ok(RULES.proj(D.TOWERS.turret, { vel: 3 }) > RULES.proj(D.TOWERS.turret, {}),
    'the velocity track speeds the bolt up');
  assert.strictEqual(RULES.proj(D.TOWERS.laser, {}), 0, 'a beam has no projectile speed at all');

  await setOpt(mm, 'respawn', 3);
  await park(mm, run);
  /* straight above the start, so running along the path is a clean sidestep */
  mm.send({ t: 'tower', type: 'turret', x: SX, y: ROW - 2 });
  await waitFor(() => twAt(mm, SX, ROW - 2), 'a turret overlooking the start');
  await sleep(1700);                                   /* let spawn protection lapse */
  const hpStill = me(run).hp;
  await waitFor(() => run.state.pj.some(p => p.k === 'bolt'), 'a bolt is in the air', 9000);
  assert.ok(run.state.pj.every(p => typeof p.a === 'number'), 'bolts carry a heading for the client to draw');
  await waitFor(() => me(run).hp < hpStill, 'a runner who stands still is hit by it', 9000);

  /* now dodge one: wait for a bolt, remove the shooter, and step aside */
  await waitFor(() => run.state.pj.some(p => p.k === 'bolt'), 'another bolt in the air', 9000);
  mm.send({ t: 'sell', x: SX, y: ROW - 2 });
  run.send({ t: 'input', dx: 1, dy: 0 });
  const hpAtDodge = me(run).hp;
  await waitFor(() => run.state.pj.length === 0, 'the bolt finishes its flight', 6000);
  run.send({ t: 'input', dx: 0, dy: 0 });
  await sleep(60);
  assert.ok(me(run).hp >= hpAtDodge,
    'the dodged bolt did no damage (' + hpAtDodge + ' -> ' + me(run).hp + ')');
  await waitFor(() => !twAt(mm, SX, ROW - 2), 'shooter cleared away');
  await park(mm, run);

  /* ---- bucket fill, mass upgrade and the area rectangle ------------------ */
  await park(mm, run);
  mm.send({ t: 'clearTowers' });
  await waitFor(() => (mm.towers || []).length === 0, 'board cleared for the tool tests');
  await bankroll(mm, 2000);
  const spikeCost = RULES.buildCost(mm.set, D.TRAPS.spikes);
  const affordable = Math.floor(mm.state.gold / spikeCost);
  mm.send({ t: 'fill', type: 'spikes', x: SX + 4, y: ROW });
  await waitFor(() => (mm.towers || []).length > 3, 'the bucket spreads spikes along the path', 6000);
  const filled = mm.towers.length;
  assert.ok(filled <= affordable, 'the fill never spends gold it does not have');
  assert.ok(mm.towers.every(t => t.ty === 'spikes'), 'and only puts down what was picked');
  assert.ok(mm.towers.every(t => t.gy === ROW), 'spikes are traps, so they only land on the path');
  assert.ok(mm.state.gold < 2000, 'the fill was paid for');

  /* mass upgrade: one track across the whole group, billed together */
  const before = mm.towers.map(t => RULES.upgrades(t.up));
  assert.ok(before.every(n => n === 0), 'the fresh spikes start unupgraded');
  let bill = 0;
  for (const t of mm.towers) {
    bill += RULES.trackCost(mm.set, D.TRAPS.spikes, RULES.upgrades(t.up), t.up.dmg || 0,
                            D.TRAPS.spikes.tracks.length);
  }
  const goldBefore = mm.state.gold;
  mm.send({ t: 'massUp', type: 'spikes', track: 'dmg' });
  await waitFor(() => mm.towers.every(t => t.up.dmg === 1), 'every spike gained a damage level at once', 6000);
  assert.ok(goldBefore - mm.state.gold >= bill - 5, 'and the whole bill was charged (' + bill + ')');
  assert.ok(mm.msgs.some(t => /Damage \+1 on \d+ Spikes/.test(t)), 'with one message covering the lot');

  /* the area rectangle narrows a bulk action to part of the board */
  const leftHalf = { x0: 0, y0: 0, x1: SX + 4, y1: ROW + 1 };
  const inside = mm.towers.filter(t => t.gx <= SX + 4).length;
  const outside = mm.towers.length - inside;
  assert.ok(inside > 0 && outside > 0, 'the rectangle splits the row into two groups');
  mm.send({ t: 'massUp', type: 'spikes', track: 'dmg', area: leftHalf });
  await waitFor(() => mm.towers.filter(t => t.up.dmg === 2).length === inside,
    'only the spikes inside the rectangle went up again', 6000);
  assert.strictEqual(mm.towers.filter(t => t.up.dmg === 1).length, outside,
    'the ones outside it were left alone');

  mm.send({ t: 'clearTowers', area: leftHalf });
  await waitFor(() => mm.towers.length === outside, 'selling by area only sells inside it');
  mm.send({ t: 'clearTowers' });
  await waitFor(() => mm.towers.length === 0, 'and selling with no area sells the rest');
  await setOpt(mm, 'twGrow', 100);

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
  assert.deepStrictEqual(turret.up, { dmg: 0, rng: 0, spd: 0, vel: 0 },
    'a new turret starts with all four of its upgrade tracks at zero');
  assert.ok(mm.state.gold <= gold0 - RULES.buildCost(mm.set, D.TOWERS.turret) + 40, 'gold was charged');

  const upCost = RULES.trackCost(mm.set, D.TOWERS.turret, 0, 0, D.TOWERS.turret.tracks.length);
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
  /* ---- how a building upgrade is priced ---------------------------------
   * The base climbs with the building's TOTAL upgrades, steeply at first and
   * then flattening off, because the late game is where the Mastermind is
   * meant to get frightening -- the thirtieth upgrade must not cost a hundred
   * times the first. On top of that each track is priced RELATIVE to the
   * building's average: a track nobody has touched is cheap, a track you have
   * poured everything into is dear. */
  const base = { twGrow: 100 };
  const nT = D.TOWERS.turret.tracks.length;
  const even = n => RULES.trackCost(base, D.TOWERS.turret, n, n / nT, nT);   /* spread evenly */
  const curve = [];
  for (let n = 0; n <= 30; n += 5) curve.push(even(n));
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i] > curve[i - 1], 'upgrade ' + (i * 5) + ' costs more than upgrade ' + ((i - 1) * 5));
  }
  /* measured on the unrounded curve: whole-gold rounding wobbles the ratio of
     two small numbers by more than the shape of the curve does */
  for (let n = 10; n <= 30; n += 5) {
    const late = RULES.growth(n) / RULES.growth(n - 5);
    const early = RULES.growth(n - 5) / RULES.growth(n - 10);
    assert.ok(late <= early + 1e-9,
      'the price curve flattens instead of steepening (' + early.toFixed(3) + ' then ' + late.toFixed(3) + ')');
  }
  assert.ok(curve[6] / curve[0] < 30,
    'a fully grown building costs a bearable multiple of the first upgrade, not a hundred times it (' +
    (curve[6] / curve[0]).toFixed(1) + 'x)');
  assert.ok(curve[6] > curve[0] * 4, 'but it is still a real climb');

  /* un-upgraded tracks stay cheap; over-fed ones get expensive */
  const total = 12;
  const neglected = RULES.trackCost(base, D.TOWERS.turret, total, 0, nT);
  const average   = RULES.trackCost(base, D.TOWERS.turret, total, total / nT, nT);
  const hogged    = RULES.trackCost(base, D.TOWERS.turret, total, total, nT);
  assert.ok(neglected < average, 'a track you have never touched is cheaper than an average one');
  assert.ok(hogged > average * 1.5, 'and one you have poured everything into is much dearer');
  assert.ok(neglected < hogged / 3, 'the spread between the two is worth playing around');

  /* a one-track trap is not punished for having nowhere else to spend: its one
     track IS its average, so the relative term is always exactly 1 */
  for (const n of [0, 7, 19, 30]) {
    assert.strictEqual(RULES.trackCost(base, D.TRAPS.glue, n, n, 1),
      Math.max(1, Math.round(D.TRAPS.glue.cost * 0.5 * RULES.growth(n))),
      'a single-track trap is priced on its total alone');
  }
  const sum = a => a.reduce((x, y) => x + y, 0);
  const trapTotal = [], towerTotal = [];
  for (let n = 0; n < 30; n++) {
    trapTotal.push(RULES.trackCost(base, D.TRAPS.glue, n, n, 1));
    towerTotal.push(RULES.trackCost(base, D.TOWERS.turret, n, n / nT, nT));
  }
  assert.ok(Math.abs(sum(trapTotal) / D.TRAPS.glue.cost - sum(towerTotal) / D.TOWERS.turret.cost) < 1,
    'reaching the final form costs the same multiple of build cost for a one-track trap as a four-track tower');

  /* towers themselves got dearer, the sniper most of all, and upgrades got
     cheaper late -- the early-nerf, late-buff trade the Mastermind asked for */
  assert.ok(D.TOWERS.sniper.cost >= 250, 'the sniper is properly expensive now (' + D.TOWERS.sniper.cost + ')');
  assert.ok(D.TOWERS.sniper.cost > D.TOWERS.turret.cost * 4, 'and costs several turrets');
  assert.ok(RULES.growth(30) < Math.pow(RULES.TRACK_EXP, 30),
    'the late game is cheaper than a flat exponential would have made it');
  mm.send({ t: 'sell', x: SX + 2, y: ROW - 1 });
  await waitFor(() => !twAt(mm, SX + 2, ROW - 1), 'the overgrown turret is sold again');
  await setOpt(mm, 'twGrow', 100);

  await setOpt(mm, 'respawn', 1);
  await waitFor(() => me(run).d === 0, 'the runner is on their feet before the kill test', 12000);
  const vpMM0 = run.state.vpMM, deaths0 = me(run).dth;
  /* A well-fed runner shrugs off one tower now, which is the point of the
     rebalance -- so lean on the global damage dial to make the kill happen. */
  await setOpt(mm, 'towerPower', 300);
  mm.send({ t: 'tower', type: 'sniper', x: SX + 4, y: ROW - 1 });
  await waitFor(() => twAt(mm, SX + 4, ROW - 1), 'sniper built');
  await waitFor(() => me(run).dth === deaths0 + 1, 'the towers kill the runner', 25000);
  await setOpt(mm, 'towerPower', 100);
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

  /* ---- new ground: steep climbs and tunnels ------------------------------ */
  /* Two more kinds of tile, so a track is not just a corridor of the same
     stuff. Steep ground slows you down; a tunnel mouth drops you out of its
     partner somewhere else entirely. */
  await park(mm, run);
  mm.send({ t: 'clearTowers' });
  await waitFor(() => (mm.towers || []).length === 0, 'board cleared for the terrain tests');
  mm.send({ t: 'mode', edit: true });
  await waitFor(() => mm.state.edit === 1, 'edit mode for painting new ground');
  for (let x = SX + 3; x <= SX + 5; x++) mm.send({ t: 'paint', x, y: ROW, tile: T.STEEP });
  await waitFor(() => run.grid.tiles[ROW * mm.set.gw + SX + 4] === T.STEEP, 'steep ground reaches the runner');
  mm.send({ t: 'mode', edit: false });
  await waitFor(() => mm.state.edit === 0, 'live on the new ground');
  await setOpt(mm, 'steepSlow', 80);
  await park(mm, run);
  await runRight(run, () => me(run).st === 1, 'the runner is slowed by the climb', 8000);
  /* a trap still goes on steep ground: it is path, just harder path */
  mm.send({ t: 'tower', type: 'spikes', x: SX + 4, y: ROW });
  await waitFor(() => twAt(mm, SX + 4, ROW), 'traps can be laid on steep ground');
  mm.send({ t: 'sell', x: SX + 4, y: ROW });
  await waitFor(() => !twAt(mm, SX + 4, ROW), 'and sold again');
  mm.send({ t: 'tower', type: 'turret', x: SX + 3, y: ROW });
  await sleep(150);
  assert.ok(!twAt(mm, SX + 3, ROW), 'but a tower still cannot stand on it');

  mm.send({ t: 'mode', edit: true });
  await waitFor(() => mm.state.edit === 1, 'edit mode for the tunnels');
  for (let x = SX + 3; x <= SX + 5; x++) mm.send({ t: 'paint', x, y: ROW, tile: T.PATH });
  mm.send({ t: 'paint', x: SX + 2, y: ROW, tile: T.TUNNEL });
  mm.send({ t: 'paint', x: EX - 1, y: ROW, tile: T.TUNNEL });
  await waitFor(() => run.grid.tiles[ROW * mm.set.gw + SX + 2] === T.TUNNEL &&
                      run.grid.tiles[ROW * mm.set.gw + EX - 1] === T.TUNNEL, 'two tunnel mouths painted');
  const par = tunnelPartner(room, SX + 2, ROW);
  assert.ok(par && par.x === EX - 1, 'the two mouths pair up in reading order');
  assert.strictEqual(tunnelPartner(room, EX - 1, ROW).x, SX + 2, 'and pair up both ways');
  mm.send({ t: 'mode', edit: false });
  await waitFor(() => mm.state.edit === 0, 'live with tunnels');
  await park(mm, run);
  await runRight(run, () => me(run).x > startPx(EX - 2), 'the tunnel throws the runner across the board', 8000);

  /* ---- several STARTs and several ENDs ------------------------------------ */
  mm.send({ t: 'mode', edit: true });
  await waitFor(() => mm.state.edit === 1, 'edit mode for the second END');
  mm.send({ t: 'paint', x: SX + 2, y: ROW, tile: T.PATH });
  mm.send({ t: 'paint', x: EX - 1, y: ROW, tile: T.PATH });
  await sleep(150);
  assert.strictEqual(mm.set.multiEnds, 0, 'one START and one END by default');
  mm.send({ t: 'paint', x: EX - 2, y: ROW, tile: T.END });
  await waitFor(() => run.grid.tiles[ROW * mm.set.gw + EX - 2] === T.END, 'a second END is painted');
  await sleep(150);
  assert.strictEqual(findTiles(room, T.END).length, 1, 'which replaces the first one while the option is off');
  await setOpt(mm, 'multiEnds', 1);
  mm.send({ t: 'paint', x: EX, y: ROW, tile: T.END });
  await waitFor(() => findTiles(room, T.END).length === 2, 'with the option on, both ENDs stay');
  mm.send({ t: 'paint', x: SX + 1, y: ROW, tile: T.START });
  await waitFor(() => findTiles(room, T.START).length === 2, 'and so do two STARTs');
  assert.ok(pathConnected(room), 'both starts still reach an end');
  /* a start walled off from every end is refused, because somebody would spawn
     into a box and never get out */
  mm.send({ t: 'paint', x: 0, y: 0, tile: T.START });
  await waitFor(() => findTiles(room, T.START).length === 3, 'a third START, stranded in a corner');
  assert.ok(!pathConnected(room), 'a stranded START breaks the connection check');
  mm.msgs.length = 0;
  mm.send({ t: 'mode', edit: false });
  await sleep(250);
  assert.strictEqual(mm.state.edit, 1, 'so the round cannot go live');
  assert.ok(mm.msgs.some(t => /every START needs a walkable route/i.test(t)), 'and says exactly why');
  mm.send({ t: 'paint', x: 0, y: 0, tile: T.EMPTY });
  await sleep(120);
  await setOpt(mm, 'multiEnds', 0);
  await paintTrack(mm);
  mm.send({ t: 'mode', edit: false });
  await waitFor(() => mm.state.edit === 0, 'back to one clean straight track');
  await park(mm, run);

  /* ---- barrier, resists and the elements --------------------------------- */
  /* The barrier is a second bar that eats damage before health and grows back
     out of combat -- the difference between it and the Shield ability is that
     you never have to remember to press it. */
  assert.strictEqual(RULES.barrierMax(mm.set, { barrier: 0 }), 0, 'no barrier until you buy one');
  assert.ok(RULES.barrierMax(mm.set, { barrier: 3 }) > 0, 'and a real one once you do');
  for (let i = 0; i < 4; i++) run.send({ t: 'upgrade', key: 'barrier' });
  await waitFor(() => me(run).up.barrier === 4, 'four levels of barrier bought');
  await waitFor(() => me(run).bm > 0 && me(run).ba >= me(run).bm, 'it fills up out of combat', 12000);
  const fullHp = me(run).hp, fullBa = me(run).ba;
  mm.send({ t: 'tower', type: 'turret', x: SX, y: ROW - 2 });
  await waitFor(() => twAt(mm, SX, ROW - 2), 'a turret to test it against');
  await waitFor(() => me(run).ba < fullBa, 'the barrier takes the hit', 15000);
  assert.strictEqual(me(run).hp, fullHp, 'and health is untouched while it lasts');
  mm.send({ t: 'sell', x: SX, y: ROW - 2 });
  await waitFor(() => me(run).ba >= me(run).bm, 'and it grows back once nothing is shooting', 15000);

  /* elemental resists stack with Armor by adding resistance, not by
     multiplying it, so the second one you buy is never wasted */
  const armorOnly = { armor: 6, resFire: 0 };
  const both = { armor: 6, resFire: 6 };
  assert.strictEqual(RULES.resistPct({ armor: 0 }, 'fire'), 0, 'no resist with nothing bought');
  assert.ok(RULES.resistPct(both, 'fire') > RULES.resistPct(armorOnly, 'fire'),
    'fire resist adds on top of armor');
  assert.strictEqual(RULES.resistPct(both, 'energy'), RULES.resistPct(armorOnly, 'energy'),
    'and does nothing at all against energy');
  assert.ok(RULES.resistPct({ armor: 999 }, 'fire') < 1, 'resistance can never reach immunity');
  for (const el of ['bullet', 'fire', 'energy']) {
    assert.ok(Object.keys(D.BUILD).some(k => D.BUILD[k].el === el),
      'something in the game deals ' + el + ' damage');
  }
  assert.ok(RULES.trapMul({ trapres: 5 }) < 1, 'trap resist reduces trap damage');
  assert.strictEqual(RULES.trapMul({ trapres: 0 }), 1, 'and does nothing unbought');
  assert.ok(RULES.oocPerSec({ oocheal: 4 }) > RULES.regenPerSec({ regen: 4 }),
    'out of combat healing scales better than regen, which is the trade');

  /* ---- the ghost nerf ----------------------------------------------------- */
  /* It used to be invulnerability with no counterplay. Now it hides you from
     towers, it breaks when a trap bites, and it is worth nothing on the END. */
  await setOpt(mm, 'escapeBase', 8);
  await park(mm, run);
  mm.send({ t: 'tower', type: 'spikes', x: SX + 3, y: ROW });
  await waitFor(() => twAt(mm, SX + 3, ROW), 'spikes on the path');
  await waitFor(() => me(run).cd.ghost === 0, 'ghost is off cooldown', 20000);
  run.send({ t: 'act', a: 'ghost' });
  await waitFor(() => me(run).gh === 1, 'ghost is up');
  await runRight(run, () => me(run).fk === 1, 'stepping on a trap makes it flicker', 8000);
  assert.strictEqual(me(run).gh, 0, 'and while it flickers the towers can see you again');
  mm.send({ t: 'sell', x: SX + 3, y: ROW });
  await waitFor(() => !twAt(mm, SX + 3, ROW), 'spikes sold');

  await park(mm, run);
  await waitFor(() => me(run).cd.ghost === 0, 'ghost is ready again', 25000);
  await runRight(run, () => me(run).esc > 0, 'the runner reaches the END and starts the clock', 9000);
  run.msgs.length = 0;
  run.send({ t: 'act', a: 'ghost' });
  await sleep(250);
  assert.strictEqual(me(run).gh, 0, 'ghost refuses to hide a runner standing on the END');
  assert.ok(run.msgs.some(t => /nothing while you are standing on the END/.test(t)), 'and says so');
  run.send({ t: 'input', dx: 0, dy: 0 });
  await setOpt(mm, 'escapeBase', 0.4);
  await park(mm, run);

  /* ---- mastermind gold upgrades ------------------------------------------ */
  /* The other half of the late-game buff: gold spent on the Mastermind
     themselves rather than on any one building. */
  for (const k of ['lockdown', 'siege', 'bounty']) {
    assert.ok(D.MM_UPGRADES[k], 'mastermind upgrade ' + k + ' is defined');
    assert.ok(RULES.mmUpCost(mm.set, D.MM_UPGRADES[k], 1) > RULES.mmUpCost(mm.set, D.MM_UPGRADES[k], 0),
      k + ' costs more each level');
  }
  await bankroll(mm, 5000);
  const lockCost = RULES.mmUpCost(mm.set, D.MM_UPGRADES.lockdown, 0);
  const goldPre = mm.state.gold;
  mm.send({ t: 'mmup', key: 'lockdown' });
  await waitFor(() => room.mmUp.lockdown === 1, 'Lockdown bought');
  await waitFor(() => mm.state.gold <= goldPre - lockCost + 2, 'and paid for (' + lockCost + ' gold)');
  await waitFor(() => mm.ul && mm.ul.up && mm.ul.up.lockdown === 1, 'the client is told about it');
  assert.ok(RULES.escapeMs(mm.set, 0, 1) > RULES.escapeMs(mm.set, 0, 0), 'and the END hold got longer');

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
