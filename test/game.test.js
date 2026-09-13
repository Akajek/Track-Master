/* End-to-end test: boots the real server, connects a Mastermind and a Runner
 * over WebSocket and plays through the core loop. Run with `npm test`. */
'use strict';
process.env.PORT = '18765';
const assert = require('assert');
const WebSocket = require('ws');
const { server, rooms, pathConnected } = require('../server.js');

const URL = 'ws://localhost:18765';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name, role, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = { ws, name, state: null, grid: null, welcome: null, msgs: [], send: o => ws.send(JSON.stringify(o)) };
    ws.on('open', () => c.send({ t: 'join', name, role, room }));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'w') { c.welcome = m; resolve(c); }
      else if (m.t === 'g') c.grid = m;
      else if (m.t === 's') c.state = m;
      else if (m.t === 'msg') c.msgs.push(m.text);
      else if (m.t === 'role') c.welcome.role = m.role;
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('join timeout for ' + name)), 3000);
  });
}
async function waitFor(fn, what, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(25); }
  throw new Error('timed out waiting for: ' + what);
}
const me = c => c.state.r.find(r => r.id === c.welcome.id);
const towerAt = (c, x, y) => c.state.tw.find(t => t.gx === x && t.gy === y);

async function main() {
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const mm = await client('Boss', 'mm', '');
  const code = mm.welcome.room;
  assert.strictEqual(mm.welcome.role, 'mm', 'first player gets the Mastermind seat');
  assert.ok(mm.welcome.defs.TOWERS.turret, 'defs are sent');

  const run = await client('Speedy', 'runner', code);
  assert.strictEqual(run.welcome.role, 'runner');
  const mm2 = await client('Late', 'mm', code);
  assert.strictEqual(mm2.welcome.role, 'runner', 'second mastermind is demoted to runner');
  assert.ok(mm2.msgs.some(t => /seat is taken/.test(t)), 'told the seat is taken');
  mm2.ws.close();

  await waitFor(() => mm.state && run.state && run.grid, 'first state + grid');
  const room = rooms.get(code);
  assert.strictEqual(room.tiles.length, 24 * 16);
  assert.ok(pathConnected(room), 'default snake track connects start and end');
  const start = room.tiles.indexOf(2), sx = start % 24, sy = Math.floor(start / 24);
  assert.deepStrictEqual([sx, sy], [0, 2], 'snake starts at (0,2)');

  /* --- runner movement + collision -------------------------------------- */
  const r0 = me(run);
  assert.deepStrictEqual([r0.x, r0.y], [20, 100], 'runner spawns in the middle of the start tile');
  run.send({ t: 'input', dx: 0, dy: -1 });           // up: into grass, blocked
  await sleep(300);
  assert.ok(me(run).y >= 91 && me(run).y < 100, 'runner slides to the tile edge but cannot leave the path (y=' + me(run).y + ')');
  run.send({ t: 'input', dx: 1, dy: 0 });            // right: along the path
  await waitFor(() => me(run).x > 100, 'runner moving right along the path');
  run.send({ t: 'input', dx: 0, dy: 0 });
  await sleep(120);
  const stopped = me(run).x;
  await sleep(200);
  assert.strictEqual(me(run).x, stopped, 'runner stops when input is released');

  /* --- tower placement rules --------------------------------------------- */
  const gold0 = mm.state.gold;
  mm.send({ t: 'tower', type: 'turret', x: 5, y: 2 });      // path tile: refused
  await sleep(150);
  assert.ok(!towerAt(mm, 5, 2), 'turret is not allowed on the path');
  assert.ok(mm.msgs.some(t => /empty ground/.test(t)), 'refusal message arrives');
  mm.send({ t: 'tower', type: 'spikes', x: 5, y: 4 });      // grass tile: refused for a trap
  await sleep(150);
  assert.ok(!towerAt(mm, 5, 4), 'trap is not allowed off the path');
  mm.send({ t: 'tower', type: 'sniper', x: 5, y: 3 });      // grass next to the path: ok
  await waitFor(() => towerAt(mm, 5, 3), 'sniper placed');
  assert.ok(mm.state.gold <= gold0 - 120 + 8, 'gold was charged for the sniper');
  mm.send({ t: 'tower', type: 'sniper', x: 5, y: 3 });
  await sleep(150);
  assert.ok(mm.msgs.some(t => /already something/.test(t)), 'cannot stack towers');
  mm.send({ t: 'tower', type: 'glue', x: 8, y: 2 });
  await waitFor(() => towerAt(mm, 8, 2), 'glue trap placed on the path');
  assert.ok(!run.state.tw.find(() => false), 'runner also receives tower list');
  await waitFor(() => run.state.tw.length === 2, 'runner sees both placements');

  /* --- the sniper shoots the runner, the runner dies and respawns -------- */
  const hp0 = me(run).hp;
  await waitFor(() => me(run).hp < hp0, 'sniper damages the runner');
  await waitFor(() => me(run).d === 1, 'runner dies', 8000);
  assert.strictEqual(me(run).dth, 1, 'death counted');
  assert.strictEqual(me(run).pt, 1, 'pity point for dying');
  assert.ok(mm.state.gold > 60, 'mastermind was paid for the kill');
  await waitFor(() => me(run).d === 0 && me(run).x === 20, 'runner respawns at start', 5000);

  /* --- tower upgrade + sell --------------------------------------------- */
  mm.send({ t: 'tup', x: 5, y: 3 });
  await waitFor(() => towerAt(mm, 5, 3).lv === 2, 'sniper upgraded to level 2');
  const goldBeforeSell = mm.state.gold;
  mm.send({ t: 'sell', x: 5, y: 3 });
  await waitFor(() => !towerAt(mm, 5, 3), 'sniper sold');
  assert.ok(mm.state.gold > goldBeforeSell, 'sell refunds gold');

  /* --- edit mode: rebuild a tiny track, go live, finish a lap ----------- */
  mm.send({ t: 'mode', edit: true });
  await waitFor(() => mm.state.edit === 1, 'edit mode on');
  mm.send({ t: 'preset', name: 'blank' });
  await waitFor(() => run.grid.tiles.every(t => t === 0), 'blank preset reached the runner');
  mm.send({ t: 'mode', edit: false });
  await sleep(150);
  assert.strictEqual(mm.state.edit, 1, 'cannot go live without a connected track');
  assert.ok(mm.msgs.some(t => /needs a Start/.test(t)), 'explains why');
  mm.send({ t: 'paint', x: 0, y: 0, tile: 2 });
  mm.send({ t: 'paint', x: 1, y: 0, tile: 1 });
  mm.send({ t: 'paint', x: 2, y: 0, tile: 1 });
  mm.send({ t: 'paint', x: 3, y: 0, tile: 3 });
  await waitFor(() => run.grid.tiles[3] === 3, 'painted tiles reach the runner');
  run.send({ t: 'input', dx: 1, dy: 0 });
  await sleep(300);
  assert.strictEqual(me(run).x, 20, 'runner is frozen at start during editing');
  mm.send({ t: 'mode', edit: false });
  await waitFor(() => mm.state.edit === 0, 'live again');
  await waitFor(() => me(run).fin === 1, 'runner finishes the tiny track', 5000);
  assert.strictEqual(me(run).pt, 4, '1 pity + 3 finish points');
  run.send({ t: 'input', dx: 0, dy: 0 });

  /* --- upgrades ---------------------------------------------------------- */
  run.send({ t: 'upgrade', key: 'speed' });
  await waitFor(() => me(run).up.speed === 1, 'speed upgrade bought');
  run.send({ t: 'upgrade', key: 'hp' });
  await waitFor(() => me(run).up.hp === 1 && me(run).mh === 130, 'vitality raises max hp');
  run.send({ t: 'upgrade', key: 'dash' });
  await waitFor(() => me(run).up.dash === 1, 'dash bought');
  assert.strictEqual(me(run).pt, 1, 'points spent: 1+1+1');
  run.send({ t: 'act', a: 'emp' });
  await sleep(100);
  assert.ok(run.msgs.some(t => /Buy the EMP/.test(t)), 'locked ability is refused nicely');
  run.send({ t: 'act', a: 'dash' });
  await waitFor(() => me(run).cd.dash > 0, 'dash goes on cooldown');

  /* --- mastermind abilities ---------------------------------------------- */
  mm.send({ t: 'ability', a: 'freeze' });
  await waitFor(() => mm.state.frz > 0, 'freeze is active');
  mm.send({ t: 'ability', a: 'meteor', x: 60, y: 20 });
  await waitFor(() => mm.state.mt.length === 1, 'meteor incoming');
  await waitFor(() => mm.state.mt.length === 0, 'meteor landed', 3000);

  /* --- seat handover ------------------------------------------------------ */
  mm.ws.close();
  await waitFor(() => run.state.mm === null, 'seat opens when the mastermind leaves');
  run.send({ t: 'role', role: 'mm' });
  await waitFor(() => run.state.mm && run.state.mm.id === run.welcome.id, 'runner takes the seat');
  assert.strictEqual(run.state.r.length, 0, 'new mastermind is no longer a runner');
  run.ws.close();

  console.log('ALL TESTS PASSED');
  process.exit(0);
}
main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
