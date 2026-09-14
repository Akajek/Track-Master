/* Not part of the suite: a quick empirical readout of how a round actually
 * goes. Builds a realistic defence on a straight track, holds the runner's
 * right arrow for a while, and reports laps against deaths. */
'use strict';
process.env.PORT = '18799';
const WebSocket = require('ws');
const { server, rooms, DEFS } = require('../server.js');

const URL = 'ws://localhost:18799';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROW = 6, SX = 0, EX = 19;

function client(name, role, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = { ws, state: null, set: null, towers: null, welcome: null,
                send: o => ws.send(JSON.stringify(o)) };
    ws.on('open', () => c.send({ t: 'join', name, role, room }));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'w') c.welcome = m;
      else if (m.t === 'set') c.set = m.set;
      else if (m.t === 'tw') c.towers = m.tw;
      else if (m.t === 's') { c.state = m; if (c.welcome && !c.ready) { c.ready = true; resolve(c); } }
    });
    ws.on('error', reject);
  });
}
const me = c => c.state.r.find(r => r.id === c.welcome.id);
async function set(mm, k, v) { mm.send({ t: 'setting', key: k, v }); await sleep(90); }

async function run(label, tweak, plan) {
  const mm = await client('MM', 'mm', '');
  const code = mm.welcome.room;
  const rn = await client('Runner', 'runner', code);
  mm.send({ t: 'mode', edit: true }); await sleep(250);
  /* The armoury is earned in a real game; a probe is not a real game, so open
     it outright and measure the defence rather than the unlock pace. */
  const room = rooms.get(code);
  room.unlockPts = DEFS.UNLOCKABLE.length + 2;
  for (const k of DEFS.UNLOCKABLE) mm.send({ t: 'unlock', key: k });
  await sleep(200);
  await set(mm, 'gw', 20); await set(mm, 'gh', 12);
  await set(mm, 'startGold', 1600);   /* buildings cost more than they used to */
  await set(mm, 'vpTarget', 100);           /* long enough not to end early */
  if (tweak) await tweak(mm);
  mm.send({ t: 'preset', name: 'blank' }); await sleep(200);
  for (let x = 0; x <= EX; x++) {
    mm.send({ t: 'paint', x, y: ROW, tile: x === SX ? 2 : (x === EX ? 3 : 1) });
  }
  await sleep(350);
  mm.send({ t: 'mode', edit: false }); await sleep(350);

  /* a defence a Mastermind could plausibly have up a couple of minutes in */
  plan = plan || [['turret', 4, 5], ['turret', 9, 7], ['turret', 14, 5], ['turret', 17, 7],
                  ['sniper', 6, 7], ['sniper', 12, 5], ['spikes', 8, ROW], ['glue', 13, ROW]];
  for (const [ty, x, y] of plan) mm.send({ t: 'tower', type: ty, x, y });
  await sleep(600);
  const built = (mm.towers || []).length;
  const spent = 1600 - mm.state.gold;

  rn.send({ t: 'input', dx: 1, dy: 0 });
  const t0 = Date.now();
  let lowest = 999;
  /* a runner who actually spends what they earn, the way a player would */
  const wish = ['hp', 'armor', 'regen', 'speed', 'hp', 'grip', 'armor', 'speed', 'tough', 'hp'];
  let wi = 0;
  while (Date.now() - t0 < 60000) {
    const r = me(rn);
    if (r && !r.d) lowest = Math.min(lowest, Math.round(100 * r.hp / r.mh));
    if (r && r.pt >= 4) { rn.send({ t: 'upgrade', key: wish[wi % wish.length] }); wi++; }
    await sleep(100);
  }
  rn.send({ t: 'input', dx: 0, dy: 0 });
  const r = me(rn);
  let lv = 0; for (const k in r.up) lv += r.up[k];
  console.log(label.padEnd(26) + '| towers ' + built + ' (' + spent + 'g) | runner lv ' + String(lv).padStart(2) +
    ' | laps ' + String(r.fin).padStart(2) +
    ' | deaths ' + String(r.dth).padStart(2) + ' | VP runners ' + rn.state.vpRun +
    ' vs MM ' + rn.state.vpMM + ' | lowest HP ' + lowest + '%');
  mm.ws.close(); rn.ws.close();
  await sleep(200);
}

(async () => {
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  await run('defaults');
  await run('tower damage 200%', mm => set(mm, 'towerPower', 200));
  await run('tower damage 50%', mm => set(mm, 'towerPower', 50));
  await run('snipers only (6)', null,
    [['sniper', 3, 5], ['sniper', 6, 7], ['sniper', 9, 5], ['sniper', 12, 7], ['sniper', 15, 5], ['sniper', 18, 7]]);
  await run('one sniper', null, [['sniper', 9, 5]]);
  process.exit(0);
})();
