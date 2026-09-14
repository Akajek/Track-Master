/* TRACK MASTER -- the client.
 *
 * Talks to the server, draws the board, and builds both sidebars. The server is
 * authoritative about everything; this file only sends intentions and paints
 * what comes back. Runner positions are smoothed between snapshots so 20 ticks
 * a second look like 60 frames a second.
 */
'use strict';
const $ = id => document.getElementById(id);

/* ---------------------------------------------------------------- net state */
let ws = null, me = null, D = null, SET = null;
let grid = null, towers = [], S = null;
let UL = { have: [], pts: 0, up: {} };     /* the Mastermind's armoury */
let INV = { bag: [], equip: {} };         /* this runner's bag and worn gear */
let bagFor = '';                          /* the bag signature the DOM was built from */
let twDyn = new Map();                     /* tower id -> {a,f,d,c,bx,by,bt} */
let lastStateAt = 0;
const disp = new Map();                    /* smoothed runner positions */

/* ------------------------------------------------------------- ui state */
let toolKind = null, toolType = null;      /* mastermind's current tool */
let selTower = null;                       /* "gx,gy" of the selected building */
let hover = null;
let stroke = null;            /* an in-progress drag: paint, place or sell */
let area = null;              /* tile rectangle the bulk actions are aimed at */
let areaDrag = null;
let bucket = false;           /* the fill tool: place until the gold runs out */
let showSettings = false;
let showUlts = false;
let panelFor = null;          /* which building the selected-panel DOM belongs to */
const panelEls = {};
function areaBox() { return area ? { x0: area.x0, y0: area.y0, x1: area.x1, y1: area.y1 } : null; }
function inArea(t) {
  if (!area) return true;
  const x0 = Math.min(area.x0, area.x1), x1 = Math.max(area.x0, area.x1);
  const y0 = Math.min(area.y0, area.y1), y1 = Math.max(area.y0, area.y1);
  return t.gx >= x0 && t.gx <= x1 && t.gy >= y0 && t.gy <= y1;
}
function unlocked(key) { return UL.have.indexOf(key) >= 0; }
const keys = {};
const el = {};                             /* cached sidebar nodes */

/* transitions that make a noise or a flash the first frame they become true */
let prevEdit = null, prevFrz = 0, prevDead = false, prevSlow = false;
let prevMeteors = 0, prevWin = null, prevOd = 0, prevBo = 0, prevRoot = false;
let prevEsc = 0, prevUlt = 0;

function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function isMM() { return me && me.role === 'mm'; }
function myRunner() { return S && S.r.find(r => r.id === me.id); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function defOf(type) { return D.BUILD[type]; }
/* Siege raises the damage of every building the Mastermind owns. The stat
   lines are read off the shared rules, which only know the per-room damage
   dial -- so fold Siege into a copy of it rather than quietly under-reporting
   what a building actually hits for. */
function setWithSiege() {
  const siege = (UL.up && UL.up.siege) || 0;
  if (!siege || !SET) return SET;
  return Object.assign({}, SET, { towerPower: SET.towerPower * (1 + 0.08 * siege) });
}
function towerAt(x, y) { return towers.find(t => t.gx === x && t.gy === y); }
function abilityDef(k) { return D.UPGRADES[k]; }
/* Bought levels plus the levels your gear is lending you. Stat formulas take
   this; prices and "lv N" labels take the bought levels on their own. */
function totOf(r) { return RULES.totalLevels(r.up, r.gu); }
function rarityOf(i) { return RULES.RARITY[i] || RULES.RARITY[0]; }

/* ------------------------------------------------------------------ connect */
function connect(role) {
  SFX.init();
  const name = $('name').value.trim();
  const room = $('room').value.trim().toUpperCase();
  if (!name) { $('lobbyMsg').textContent = 'Type a name first.'; return; }
  try { localStorage.setItem('tm_name', name); } catch (e) {}
  $('lobbyMsg').textContent = 'Connecting...';
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, room, role }));
  ws.onmessage = e => onMsg(JSON.parse(e.data));
  ws.onclose = () => {
    $('game').style.display = 'none'; $('lobby').style.display = 'flex';
    $('lobbyMsg').textContent = me ? 'Connection lost. Join again to continue.' : 'Could not reach the server.';
    me = null; S = null; VFX.reset();
  };
}

function onMsg(m) {
  switch (m.t) {
    case 'w':
      me = { id: m.id, role: m.role, room: m.room, name: m.name };
      D = m.defs;
      buildTileMap();
      $('lobby').style.display = 'none'; $('game').style.display = 'flex';
      $('roomCode').textContent = m.room;
      history.replaceState(null, '', '?room=' + m.room);
      toolKind = null; selTower = null; VFX.reset();
      INV = { bag: [], equip: {} }; bagFor = '';
      break;
    case 'set': {
      /* Only the first settings message builds the sidebar. Rebuilding it on
         every change would throw away the scroll position and the focused
         slider halfway through setting a game up. */
      const first = !SET;
      SET = m.set;
      if (first) buildSide();
      else if (el.setRows) syncSettings();
      break;
    }
    case 'ul':
      UL = { have: m.have, pts: m.pts, up: m.up || {} };
      updateSide();
      break;
    case 'inv':
      INV = { bag: m.bag || [], equip: m.equip || {} };
      buildBag();
      updateSide();
      break;
    case 'g': {
      const resized = !grid || grid.gw !== m.gw || grid.gh !== m.gh;
      grid = m;
      if (resized) fitCanvas();
      terrainDirty = true;
      break;
    }
    case 'tw':
      towers = m.tw;
      break;
    case 's': {
      S = m; lastStateAt = performance.now();
      applyDyn(m.twd);
      for (const e of m.ev) { VFX.event(e, me.id); SFX.event(e, me.id); }
      transitions(m);
      updateSide();
      break;
    }
    case 'role':
      me.role = m.role; toolKind = null; selTower = null; buildSide();
      break;
    case 'msg':
      toast(m.text, m.kind);
      SFX.play(m.kind === 'good' ? 'good' : m.kind === 'warn' ? 'warn' : 'info');
      break;
  }
}

/* Towers that are idle are left out of the per-tick payload, so their last
   known barrel angle has to survive from one snapshot to the next. */
function applyDyn(list) {
  const next = new Map();
  for (const o of list) {
    const prev = twDyn.get(o.i);
    next.set(o.i, {
      a: o.a !== undefined ? o.a : (prev ? prev.a : 0),
      f: o.f || 0, d: o.d || 0, c: o.c || 0, bx: o.bx, by: o.by, bt: o.bt || 0,
    });
  }
  for (const [id, prev] of twDyn) if (!next.has(id)) next.set(id, { a: prev.a, f: 0, d: 0, c: 0 });
  twDyn = next;
}

function transitions(m) {
  if (prevEdit !== null && prevEdit !== m.edit) SFX.play(m.edit ? 'edit' : 'live');
  prevEdit = m.edit;
  if (m.frz > 0 && prevFrz <= 0) { SFX.play('freeze'); VFX.flash('#1e3a8a', 0.3); }
  else if (m.frz <= 0 && prevFrz > 0) SFX.play('unfreeze');
  prevFrz = m.frz;
  if (m.od > 0 && prevOd <= 0) { SFX.play('warn'); VFX.flash('#7c2d12', 0.25); }
  prevOd = m.od;
  if (m.bo > 0 && prevBo <= 0) { SFX.play('warn'); VFX.flash('#111827', 0.4); }
  prevBo = m.bo;
  if (m.mt.length > prevMeteors) SFX.meteorIncoming(m.mt[m.mt.length - 1].x);
  prevMeteors = m.mt.length;
  if (m.win && !prevWin) SFX.play(m.win === 'runners' ? 'winrun' : 'winmm');
  prevWin = m.win;

  const r = myRunner();
  if (r) {
    if (!r.d && prevDead) SFX.play('respawn');
    prevDead = !!r.d;
    if (r.sl && !prevSlow) SFX.play('slow', 0);
    prevSlow = !!r.sl;
    if (r.rt && !prevRoot) SFX.play('root', 0);
    prevRoot = !!r.rt;
    /* the escape clock ticks up audibly while you hold the END */
    SFX.escape(r.esc > 0 ? r.esc : 0, prevEsc);
    prevEsc = r.esc;
    if (r.uu > 0 && prevUlt <= 0) VFX.flash('#000000', 0.45);
    prevUlt = r.uu;
    SFX.lowHp(!r.d && r.hp / r.mh < 0.3);
  } else {
    prevDead = false; prevSlow = false; prevRoot = false; prevEsc = 0; prevUlt = 0;
    SFX.lowHp(false);
  }

  let flaming = false;
  for (const tw of towers) {
    const d = twDyn.get(tw.id);
    if (d && d.f && !d.d && (tw.ty === 'flame' || tw.ty === 'laser' || tw.ty === 'saw' || tw.ty === 'tar')) { flaming = true; break; }
  }
  SFX.flame(!m.edit && flaming);
}

function toast(text, kind) {
  const n = document.createElement('div');
  n.className = 'toast ' + (kind || '');
  n.textContent = text;
  $('toasts').appendChild(n);
  setTimeout(() => n.remove(), 4000);
}

/* =========================================================== sidebar: build */
const side = $('side');

function buildSide() {
  if (!me || !D || !SET) return;
  side.innerHTML = '';
  for (const k in el) delete el[k];
  panelFor = null;
  $('rolePill').textContent = isMM() ? 'MASTERMIND' : 'RUNNER · ' + me.name;
  $('switchRole').textContent = isMM() ? 'Become a runner' : 'Take the Mastermind seat';
  if (isMM()) buildMM(); else buildRunner();
  buildHud();
  const sb = document.createElement('div');
  sb.innerHTML = '<h3>Scoreboard</h3><table id="score"></table>';
  side.appendChild(sb);
  el.score = $('score');
  updateSide();
}

function row(html) { const d = document.createElement('div'); d.innerHTML = html; return d; }

/* Write markup into a live node only when it has actually changed.
 *
 * Assigning innerHTML destroys and rebuilds the children even when the string
 * is identical, and the update path below runs on every snapshot -- twenty
 * times a second. Any element that gets rebuilt under the pointer swallows the
 * click, because a browser only fires one when mousedown and mouseup landed on
 * the same element. That is what made upgrade clicks miss half the time, and
 * every label and button below that carries markup goes through here so it
 * cannot come back. Plain text is safe: a text node is never an event target,
 * so textContent is left alone. */
function setHtml(node, html) {
  if (!node || node.__html === html) return;
  node.__html = html;
  node.innerHTML = html;
}

/* ---------------------------------------------------------- mastermind side */
function buildMM() {
  side.appendChild(row(
    '<button id="modeBtn" class="big"></button>' +
    '<div class="hint" id="modeHint"></div>' +
    '<button id="setToggle" style="width:100%;margin-top:8px">&#9881; Game setup</button>' +
    '<div id="setPanel" style="display:none"></div>' +
    '<h3>Armoury</h3>' +
    '<div id="unlockWrap">' +
      '<div class="ulTop"><span>Unlock points <b class="gold" id="ulPts">0</b></span>' +
      '<span class="muted" id="ulNext"></span></div>' +
      '<div class="bar"><i id="ulBar" style="background:linear-gradient(90deg,#b45309,#fbbf24)"></i></div>' +
      '<div class="hint" id="ulHint"></div>' +
    '</div>' +
    '<h3>Track tools</h3><div class="grid2" id="trackTools">' +
      '<button data-tool="path">Path brush</button>' +
      '<button data-tool="erase">Eraser</button>' +
      '<button data-tool="steep" title="Rough ground. Runners climb it slowly, and traps still go on it.">&#9650; Steep brush</button>' +
      '<button data-tool="tunnel" title="Tunnel mouths pair up in reading order: 1 with 2, 3 with 4. Step in one, come out the other.">&#9673; Tunnel brush</button>' +
      '<button data-tool="start">Set START</button>' +
      '<button data-tool="end">Set END</button>' +
      '<button data-preset="snake">Preset: Snake</button>' +
      '<button data-preset="zigzag">Preset: Zigzag</button>' +
      '<button data-preset="spiral">Preset: Spiral</button>' +
      '<button data-preset="blank">Clear track</button>' +
      '<button data-tool="area" title="Drag a rectangle. Bulk actions then only touch what is inside it.">Select area</button>' +
      '<button id="bucketBtn" title="Click the board with a building picked and it spreads outwards until the gold runs out.">&#129516; Bucket fill</button>' +
    '</div>' +
    '<div class="hint">Hold <span class="kbd">Shift</span> and drag to lay a whole line of anything, ' +
    'or to sell a line with the right button. <span class="kbd">Esc</span> clears the tool and the area. ' +
    'Turn on <b>Several STARTs and ENDs</b> in game setup to keep more than one of each.</div>' +
    '<h3>Towers <span class="muted">(on empty ground)</span></h3><div class="list" id="towerList"></div>' +
    '<h3>Traps <span class="muted">(on path or steep ground)</span></h3><div class="list" id="trapList"></div>' +
    '<div id="towerPanel" style="display:none"></div>' +
    '<h3>Abilities</h3><div class="list" id="abList"></div>' +
    '<h3>Mastermind upgrades <span class="muted">(gold, permanent)</span></h3><div class="list" id="mmUpList"></div>' +
    '<h3>Danger zone</h3><div class="grid2">' +
      '<button id="clearTowers"></button>' +
      '<button id="resetVp">Reset VP</button>' +
    '</div>' +
    '<div class="hint">Click a building to select it. <span class="kbd">1</span>-<span class="kbd">9</span> pick, ' +
    '<span class="kbd">X</span> sell selected, <span class="kbd">Esc</span> deselect, right-click sells.</div>'
  ));
  el.modeBtn = $('modeBtn'); el.modeHint = $('modeHint');
  el.modeBtn.onclick = () => send({ t: 'mode', edit: !(grid && grid.edit) });
  $('setToggle').onclick = () => { showSettings = !showSettings; $('setPanel').style.display = showSettings ? '' : 'none'; };
  $('setPanel').style.display = showSettings ? '' : 'none';
  buildSettings($('setPanel'));
  el.ulPts = $('ulPts'); el.ulNext = $('ulNext'); el.ulBar = $('ulBar'); el.ulHint = $('ulHint');
  el.trackTools = [...side.querySelectorAll('[data-tool]')];
  for (const b of el.trackTools) b.onclick = () => setTool(b.dataset.tool);
  for (const b of side.querySelectorAll('[data-preset]')) b.onclick = () => send({ t: 'preset', name: b.dataset.preset });

  /* Every building is one button that does one of two jobs: unlock it with a
     point, or pick it up as a tool. Which one is on the label. */
  el.buildBtns = [];
  const mk = (type, host) => {
    const def = defOf(type);
    const b = document.createElement('button');
    b.dataset.type = type;
    b.innerHTML = '<span class="sw" style="background:' + def.color + '"></span>' +
      '<span class="name"><span class="bn"></span><small>' + esc(def.desc) + '</small></span>' +
      '<span class="gold cost"></span>';
    b.onclick = () => {
      if (!unlocked(type)) send({ t: 'unlock', key: type });
      else setTool('tower', type);
    };
    host.appendChild(b);
    el.buildBtns.push(b);
  };
  for (const t in D.TOWERS) mk(t, $('towerList'));
  for (const t in D.TRAPS) mk(t, $('trapList'));

  el.abBtns = [];
  for (const a in D.MM_ABILITIES) {
    const ab = D.MM_ABILITIES[a];
    const b = document.createElement('button');
    b.dataset.ab = a;
    b.innerHTML = '<span class="name"><span class="bn"></span><small>' + esc(ab.desc) + '</small></span><span class="gold cost"></span>';
    b.onclick = () => {
      if (!unlocked(a)) { send({ t: 'unlock', key: a }); return; }
      if (ab.aim) setTool('aim', a); else send({ t: 'ability', a });
    };
    $('abList').appendChild(b);
    el.abBtns.push(b);
  }

  el.mmUpBtns = [];
  for (const k in D.MM_UPGRADES) {
    const u = D.MM_UPGRADES[k];
    const b = document.createElement('button');
    b.dataset.mmup = k;
    b.innerHTML = '<span class="name">' + (u.icon || '') + ' ' + esc(u.name) +
      ' <span class="lv muted"></span><small>' + esc(u.desc) + '</small></span><span class="gold cost"></span>';
    b.onclick = () => send({ t: 'mmup', key: k });
    $('mmUpList').appendChild(b);
    el.mmUpBtns.push(b);
  }

  el.clearBtn = $('clearTowers');
  el.clearBtn.onclick = () => {
    const what = area ? 'everything inside the selected area' : 'every tower and trap';
    if (confirm('Sell ' + what + '?')) send({ t: 'clearTowers', area: areaBox() });
  };
  el.bucketBtn = $('bucketBtn');
  el.bucketBtn.onclick = () => { bucket = !bucket; updateSide(); };
  $('resetVp').onclick = () => { if (confirm('Reset both victory point scores?')) send({ t: 'resetVp' }); };
  el.towerPanel = $('towerPanel');
}

/* Sliders are generated from the server's settings table, so the two can never
   describe different ranges. A row flagged bool:1 becomes a toggle instead. */
function buildSettings(host) {
  host.innerHTML = '';
  el.setRows = {};
  let group = null;
  for (const k in D.SETTINGS) {
    const s = D.SETTINGS[k];
    if (s.g !== group) {
      group = s.g;
      const h = document.createElement('div');
      h.className = 'setGroup'; h.textContent = group;
      host.appendChild(h);
    }
    const d = document.createElement('div');
    d.className = 'setRow';
    if (s.bool) {
      const btn = document.createElement('button');
      btn.className = 'toggle';
      btn.onclick = () => { send({ t: 'setting', key: k, v: SET[k] ? 0 : 1 }); SFX.play('ui'); };
      d.appendChild(btn);
      if (s.help) d.appendChild(row('<div class="hint">' + esc(s.help) + '</div>'));
      host.appendChild(d);
      el.setRows[k] = { btn, label: s.label };
      continue;
    }
    d.innerHTML = '<div class="top"><span>' + s.label + '</span><span class="val"></span></div>';
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = s.min; inp.max = s.max; inp.step = s.step;
    inp.value = SET[k];
    d.appendChild(inp);
    if (s.help) d.appendChild(row('<div class="hint">' + esc(s.help) + '</div>'));
    host.appendChild(d);
    const val = d.querySelector('.val');
    val.textContent = SET[k];
    inp.oninput = () => { val.textContent = inp.value; };
    inp.onchange = () => { send({ t: 'setting', key: k, v: parseFloat(inp.value) }); SFX.play('ui'); };
    el.setRows[k] = { inp, val };
  }
  const note = document.createElement('div');
  note.className = 'hint';
  note.textContent = 'Map size only changes while the track is in edit mode. Everything else can change mid-round.';
  host.appendChild(note);
  /* Toggles get their label from the current value, and only a later 'set'
     message used to supply it -- so a freshly built panel showed a blank
     button until the Mastermind happened to move some other slider. */
  syncSettings();
}
function syncSettings() {
  for (const k in el.setRows) {
    const r = el.setRows[k];
    if (r.btn) {
      r.btn.textContent = (SET[k] ? '☑ ' : '☐ ') + r.label;
      r.btn.classList.toggle('sel', !!SET[k]);
      continue;
    }
    if (document.activeElement === r.inp) continue;
    r.inp.value = SET[k];
    r.val.textContent = SET[k];
  }
}

/* -------------------------------------------------------------- runner side */
function buildRunner() {
  side.appendChild(row(
    '<div style="display:flex;justify-content:space-between"><b>Health</b><span id="hpTxt"></span></div>' +
    '<div class="bar"><i id="hpBar"></i></div>' +
    '<div id="baWrap" style="margin-top:4px;display:none">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px"><span class="muted">Barrier</span>' +
      '<span id="baTxt"></span></div><div class="bar"><i id="baBar" style="background:#38bdf8"></i></div></div>' +
    '<div id="shWrap" style="margin-top:4px;display:none">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px"><span class="muted">Shield</span>' +
      '<span id="shTxt"></span></div><div class="bar"><i id="shBar" style="background:#60a5fa"></i></div></div>' +
    '<div style="margin-top:8px">Upgrade points: <span class="gold" id="ptsTxt">0</span>' +
      '<span class="muted" id="lapTxt"></span></div>' +
    '<div class="hint" id="rewardHint"></div>' +
    '<h3>Gear</h3><div id="gearBox"></div>' +
    '<div class="hint" id="gearHint"></div>' +
    '<div class="list" id="bagList"></div>' +
    '<h3>Your numbers</h3><div id="statBox" class="statbox"></div>' +
    '<h3>Ultimate slot</h3><div id="ultBox"></div>' +
    '<h3>Ability slots</h3><div id="slotBox"></div>' +
    '<div class="list" id="upAbil"></div>' +
    '<h3>Buy upgrades</h3><div class="list" id="upPass"></div>' +
    '<h3>How levelling works</h3><div class="hint" id="drHint"></div>' +
    '<h3>Controls</h3><div class="hint"><span class="kbd">W</span><span class="kbd">A</span>' +
    '<span class="kbd">S</span><span class="kbd">D</span> or arrows to move. Abilities live in the bar under ' +
    'the board: click a slot or press its key. <span class="kbd">G</span> fires the ultimate.</div>'
  ));
  el.hpTxt = $('hpTxt'); el.hpBar = $('hpBar'); el.ptsTxt = $('ptsTxt'); el.lapTxt = $('lapTxt');
  el.shWrap = $('shWrap'); el.shTxt = $('shTxt'); el.shBar = $('shBar');
  el.baWrap = $('baWrap'); el.baTxt = $('baTxt'); el.baBar = $('baBar');
  el.rewardHint = $('rewardHint'); el.statBox = $('statBox'); el.slotBox = $('slotBox');
  el.gearBox = $('gearBox'); el.gearHint = $('gearHint'); el.bagList = $('bagList');
  bagFor = '';
  buildBag();

  $('drHint').innerHTML =
    'Nothing is hard capped and nothing is unlimited. Passive upgrades pay full value to level ' +
    '<b>' + RULES.DR_START + '</b>; past that every level buys less than the one before, which the ' +
    'buttons mark <span class="warn">diminishing</span> and show as an <b>effective</b> level. ' +
    '<b>Speed</b> is on a harsher curve of its own — it used to be a teleport. ' +
    'Abilities are capped at level <b>' + RULES.AB_CAP + '</b> and diminish past it. ' +
    'Dodge and Deflection each approach <b>' + Math.round(RULES.DODGE_MAX * 100) +
    '%</b> on their own curve, and they <b>stack</b> — buying both is better than buying either. ' +
    'Gear lends you extra levels on top of what you bought, and those ride the same curves.';

  /* The ultimate: one slot, one SUPER BUFF, one very long cooldown. */
  el.ultBox = $('ultBox');
  el.ultBox.innerHTML =
    '<button id="ultBuy" style="width:100%"></button>' +
    '<div class="hint" id="ultHint"></div>' +
    '<button id="ultPick" style="width:100%;margin-top:6px">Choose the SUPER BUFF</button>' +
    '<div class="list" id="ultList" style="display:none;margin-top:6px"></div>';
  $('ultBuy').onclick = () => send({ t: 'upgrade', key: 'ultimate' });
  $('ultPick').onclick = () => { showUlts = !showUlts; $('ultList').style.display = showUlts ? '' : 'none'; };
  el.ultBtns = [];
  for (const k in RULES.ULTS) {
    const u = RULES.ULTS[k];
    const b = document.createElement('button');
    b.dataset.ult = k;
    b.innerHTML = '<span class="name">' + u.icon + ' ' + esc(u.name) +
      '<small>' + esc(u.desc) + '</small></span><span class="cost muted"></span>';
    b.onclick = () => send({ t: 'pickUlt', u: k });
    $('ultList').appendChild(b);
    el.ultBtns.push(b);
  }

  el.slotBox.innerHTML = '<div class="slotline" id="slotLine"></div>' +
    '<button id="slotBuy" style="width:100%;margin-top:6px"></button>' +
    '<div class="hint">Every ability you own takes a slot. Buying a slot is the only way to hold more; ' +
    'dropping one gives most of its points back.</div>';
  $('slotBuy').onclick = () => send({ t: 'slot' });

  el.upBtns = [];
  el.dropBtns = [];
  for (const k in D.UPGRADES) {
    const u = D.UPGRADES[k];
    const b = document.createElement('button');
    b.dataset.up = k;
    b.innerHTML = '<span class="name">' + (u.icon ? u.icon + ' ' : '') + esc(u.name) +
      ' <span class="lv muted"></span>' +
      (u.key ? ' <span class="kbd">' + u.key + '</span>' : '') +
      '<small>' + esc(u.desc) + '</small></span>' +
      '<span class="gold cost"></span>';
    b.onclick = () => send({ t: 'upgrade', key: k });
    const host = $(u.kind === 'ability' ? 'upAbil' : 'upPass');
    if (u.kind === 'ability') {
      /* The drop control is a button of its own, beside the buy button rather
         than inside it. Inside, it inherited the buy button's disabled state --
         so the moment you could not afford the next level you also could not
         get rid of the ability, which is precisely when you want to. */
      const wrap = document.createElement('div');
      wrap.className = 'abrow';
      const drop = document.createElement('button');
      drop.className = 'drop';
      drop.textContent = '✕';
      drop.title = 'Drop ' + u.name + ' and free the slot';
      drop.onclick = () => {
        if (confirm('Drop ' + u.name + '? You get most of the points back and the slot is free again.')) {
          send({ t: 'drop', key: k });
        }
      };
      wrap.appendChild(b); wrap.appendChild(drop);
      host.appendChild(wrap);
      el.dropBtns.push({ k, el: drop });
    } else {
      host.appendChild(b);
    }
    el.upBtns.push(b);
  }
}

/* ========================================================== sidebar: update */
function updateSide() {
  if (!me || !S || !SET) return;
  $('phasePill').textContent = S.win ? 'ROUND OVER' : S.edit ? 'EDITING' : 'LIVE';
  $('phasePill').style.color = S.win ? 'var(--gold)' : S.edit ? 'var(--warn)' : 'var(--good)';
  const tgt = SET.vpTarget;
  $('vpRunTxt').textContent = S.vpRun; $('vpMMTxt').textContent = S.vpMM;
  $('vpRunBar').style.width = Math.min(50, 50 * S.vpRun / tgt) + '%';
  $('vpMMBar').style.width = Math.min(50, 50 * S.vpMM / tgt) + '%';
  $('vpWrap').title = 'Runners ' + S.vpRun + ' vs Mastermind ' + S.vpMM + ' — first to ' + tgt + ' wins';
  $('switchRole').style.display = (isMM() || !S.mm) ? '' : 'none';

  if (el.score) {
    const rows = [...S.r].sort((a, b) => b.fin - a.fin || a.dth - b.dth);
    setHtml(el.score,
      '<tr><th>Runner</th><th>Fin</th><th>Died</th><th>Lv</th><th>Pts</th></tr>' +
      rows.map(r => {
        /* what the runner is worth right now, gear included -- it is the
           Mastermind's only quick read on how dangerous somebody has become */
        const rt = totOf(r);
        let lv = 0; for (const k in rt) lv += rt[k];
        return '<tr><td>' + (r.id === me.id ? '<b>' + esc(r.n) + '</b>' : esc(r.n)) + '</td><td>' +
          r.fin + '</td><td>' + r.dth + '</td><td>' + lv + '</td><td>' + r.pt + '</td></tr>';
      }).join('') +
      '<tr><td colspan="5" class="muted">Mastermind: ' +
      (S.mm ? esc(S.mm.n) : '<span class="warn">nobody — seat open</span>') + '</td></tr>');
  }
  if (isMM()) updateMM(); else updateRunner();
  updateHud();
}

function updateMM() {
  setHtml($('statPill'), 'Gold <span class="gold">' + S.gold + '</span>');
  if (el.modeBtn) {
    el.modeBtn.textContent = S.edit ? '▶ GO LIVE' : '✎ EDIT TRACK';
    el.modeHint.textContent = S.edit
      ? 'Runners wait at the start while you edit. Go live once every START reaches an END.'
      : 'Build any time. Editing the track parks the runners at the start.';
  }
  /* the armoury bar: hurting people is what opens it */
  if (el.ulBar) {
    const pct = Math.min(100, 100 * S.upr / Math.max(1, S.upn));
    el.ulBar.style.width = pct + '%';
    el.ulPts.textContent = S.up;
    el.ulNext.textContent = S.upr + ' / ' + S.upn + ' damage';
    const left = D.UNLOCKABLE.length - UL.have.length;
    setHtml(el.ulHint, left
      ? 'Damage you deal to runners fills this bar. Each point unlocks any one locked tower, trap or ability — ' +
        '<b>' + left + '</b> still locked.'
      : '<b class="good">Everything is unlocked.</b> Points keep banking anyway.');
  }
  for (const b of el.trackTools || []) {
    /* the area picker is not a track edit, so it works while the round is live */
    b.disabled = b.dataset.tool !== 'area' && !S.edit;
    b.classList.toggle('sel', toolKind === b.dataset.tool);
  }
  if (el.bucketBtn) el.bucketBtn.classList.toggle('sel', bucket);
  if (el.clearBtn) el.clearBtn.textContent = area ? 'Sell area' : 'Sell everything';
  for (const b of side.querySelectorAll('[data-preset]')) b.disabled = !S.edit;
  for (const b of el.buildBtns || []) {
    const type = b.dataset.type, def = defOf(type), have = unlocked(type);
    const cost = RULES.buildCost(SET, def);
    setHtml(b.querySelector('.bn'), have ? esc(def.name)
      : '<span class="lock">🔒</span> ' + esc(def.name));
    b.querySelector('.cost').textContent = have ? cost : (S.up > 0 ? 'UNLOCK' : '1 pt');
    b.querySelector('.cost').style.color = have ? '' : (S.up > 0 ? 'var(--good)' : 'var(--muted)');
    b.disabled = have ? S.gold < cost : S.up < 1;
    b.classList.toggle('locked', !have);
    b.classList.toggle('sel', have && toolKind === 'tower' && toolType === type);
  }
  for (const b of el.abBtns || []) {
    const a = b.dataset.ab, ab = D.MM_ABILITIES[a], cd = S.mmCd[a], have = unlocked(a);
    setHtml(b.querySelector('.bn'), have ? esc(ab.name) : '<span class="lock">🔒</span> ' + esc(ab.name));
    b.disabled = have ? (S.edit || !!S.win || cd > 0 || S.gold < ab.cost) : S.up < 1;
    b.classList.toggle('locked', !have);
    b.classList.toggle('sel', have && toolKind === 'aim' && toolType === a);
    b.querySelector('.cost').textContent = !have ? (S.up > 0 ? 'UNLOCK' : '1 pt')
      : cd > 0 ? (cd / 1000).toFixed(1) + 's' : ab.cost;
  }
  for (const b of el.mmUpBtns || []) {
    const k = b.dataset.mmup, u = D.MM_UPGRADES[k], lv = (UL.up && UL.up[k]) || 0;
    const cost = RULES.mmUpCost(SET, u, lv);
    b.querySelector('.lv').textContent = 'lv ' + lv;
    b.querySelector('.cost').textContent = cost;
    b.disabled = S.gold < cost;
  }
  updateTowerPanel();
}

/* The selected-building panel.
 *
 * The DOM here is built once per selected building and then only its text and
 * disabled flags change. It used to be rebuilt from innerHTML on every snapshot
 * because the signature included the gold total, which ticks constantly -- so
 * the button you were clicking was routinely destroyed between mousedown and
 * click, and roughly half of all upgrade clicks were swallowed. */
function updateTowerPanel() {
  const panel = el.towerPanel;
  if (!panel) return;
  const tw = selTower && towers.find(t => t.gx + ',' + t.gy === selTower);
  if (!tw) { selTower = null; panel.style.display = 'none'; panelFor = null; return; }
  const def = defOf(tw.ty);
  if (panelFor !== tw.id) buildTowerPanel(tw, def);
  refreshTowerPanel(tw, def);
}

function buildTowerPanel(tw, def) {
  const panel = el.towerPanel;
  panel.style.display = '';
  panel.innerHTML = '';
  panelFor = tw.id;
  for (const k in panelEls) delete panelEls[k];
  const gx = tw.gx, gy = tw.gy, type = tw.ty;

  const head = document.createElement('div');
  head.innerHTML =
    '<b><span class="sw" style="background:' + def.color + '"></span> <span class="fname"></span></b>' +
    '<span class="emp warn"></span><div class="hint sub"></div><div class="hint stats"></div>';
  panel.appendChild(head);
  panelEls.fname = head.querySelector('.fname');
  panelEls.emp = head.querySelector('.emp');
  panelEls.sub = head.querySelector('.sub');
  panelEls.stats = head.querySelector('.stats');

  panelEls.tracks = [];
  for (const tr of def.tracks) {
    const r = document.createElement('div');
    r.className = 'trk';
    r.innerHTML = '<button class="one"></button><span class="gold c1"></span>' +
                  '<button class="all"></button><span class="gold c2"></span>';
    panel.appendChild(r);
    const one = r.querySelector('.one'), all = r.querySelector('.all');
    one.onclick = () => send({ t: 'tup', x: gx, y: gy, track: tr });
    all.onclick = () => send({ t: 'massUp', type, track: tr, area: areaBox() });
    panelEls.tracks.push({ tr, one, all, c1: r.querySelector('.c1'), c2: r.querySelector('.c2') });
  }
  if (!def.tracks.length) {
    const none = document.createElement('div');
    none.className = 'hint';
    none.textContent = 'Nothing to upgrade on this one.';
    panel.appendChild(none);
  }
  const sellRow = document.createElement('div');
  sellRow.className = 'trk';
  sellRow.innerHTML = '<button class="sell">Sell</button><span class="gold sv"></span>';
  panel.appendChild(sellRow);
  sellRow.querySelector('.sell').onclick = () => { send({ t: 'sell', x: gx, y: gy }); selTower = null; };
  panelEls.sell = sellRow.querySelector('.sv');
}

function refreshTowerPanel(tw, def) {
  const dyn = twDyn.get(tw.id) || {};
  const form = RULES.form(tw.up), left = RULES.toNextForm(tw.up);
  const next = form < RULES.MAX_FORM ? def.forms[form + 1] : null;
  panelEls.fname.textContent = RULES.formName(def, tw.up);
  panelEls.emp.textContent = dyn.d ? '  EMP’d' : '';
  setHtml(panelEls.sub, esc(def.name) + ' · form ' + (form + 1) + ' of ' + (RULES.MAX_FORM + 1) + ' · ' +
    (next ? left + ' more upgrade' + (left === 1 ? '' : 's') + ' &rarr; <b>' + esc(next) + '</b>'
          : '<b class="gold">final form</b>'));
  panelEls.stats.textContent = RULES.statLine(def, tw.up, setWithSiege());

  const total = RULES.upgrades(tw.up), n = def.tracks.length;
  const group = towers.filter(t => t.ty === tw.ty && inArea(t));
  const where = area ? 'in the selected area' : 'on the board';
  for (const r of panelEls.tracks) {
    const name = D.TRACKS[r.tr].name;
    const lv = tw.up[r.tr] || 0;
    const cost = RULES.trackCost(SET, def, total, lv, n);
    let massCost = 0;
    for (const t of group) massCost += RULES.trackCost(SET, def, RULES.upgrades(t.up), t.up[r.tr] || 0, n);
    r.one.textContent = name + ' +' + (lv + 1);
    r.one.disabled = S.gold < cost;
    /* Neglected tracks are cheap and over-fed ones are dear, so the price is
       worth explaining on the button rather than leaving as a surprise. */
    r.one.title = D.TRACKS[r.tr].desc + ' — priced against this building\'s average track (' +
      (total / n).toFixed(1) + '); a track you have left alone is cheaper.';
    r.c1.textContent = cost;
    r.all.textContent = 'all ' + group.length;
    r.all.disabled = group.length < 2 || S.gold < cost;
    r.all.title = name + ' +1 on every ' + def.name + ' ' + where +
      '. The whole bill is ' + massCost + ' gold; cheapest first if you cannot cover it all.';
    r.c2.textContent = massCost;
  }
  panelEls.sell.textContent = '+' + RULES.sellValue(tw.sp);
}

/* ================================================================== gear */
/* Three worn slots and a bag. The bag's DOM is rebuilt only when the bag
   actually changes -- never on a snapshot -- so the button you are pressing is
   still there when you let go. */
function itemLine(it) {
  const parts = [];
  for (const k in it.stats) parts.push('+' + it.stats[k] + ' ' + D.UPGRADES[k].name);
  return parts.join(', ');
}
function bagSig() {
  return INV.bag.map(i => i.id).join(',') + '|' +
    RULES.EQUIP_SLOTS.map(sl => INV.equip[sl] || 0).join(',');
}

function buildBag() {
  if (!el.bagList || !D) return;
  const sig = bagSig();
  if (sig === bagFor) return;
  bagFor = sig;

  /* the three worn slots */
  el.gearBox.innerHTML = '';
  el.gearEls = [];
  for (const sl of RULES.EQUIP_SLOTS) {
    const it = INV.bag.find(i => i.id === INV.equip[sl]);
    const row = document.createElement('div');
    row.className = 'gearslot' + (it ? ' worn' : '');
    if (it) row.style.borderColor = rarityOf(it.r).color;
    row.innerHTML = '<span class="gs">' + RULES.SLOT_NAME[sl] + '</span>' +
      (it ? '<span class="gn" style="color:' + rarityOf(it.r).color + '">' + esc(it.name) + '</span>' +
            '<small>' + esc(itemLine(it)) + '</small>'
          : '<span class="gn muted">empty</span><small>nothing equipped</small>');
    el.gearBox.appendChild(row);
    if (it) {
      const off = document.createElement('button');
      off.className = 'drop';
      off.textContent = '✕';
      off.title = 'Take off ' + it.name;
      off.onclick = () => send({ t: 'unequip', slot: sl });
      row.appendChild(off);
      el.gearEls.push(off);
    }
  }

  /* the bag itself, best first within each slot. Equipping rebuilds this list,
     so hold the scroll position or the row you just clicked jumps away. */
  const scroll = el.bagList.scrollTop;
  el.bagList.innerHTML = '';
  el.bagBtns = [];
  const order = RULES.EQUIP_SLOTS;
  const sorted = INV.bag.slice().sort((a, b) =>
    order.indexOf(a.slot) - order.indexOf(b.slot) || b.r - a.r ||
    RULES.itemPower(b) - RULES.itemPower(a));
  for (const it of sorted) {
    const wrap = document.createElement('div');
    wrap.className = 'abrow';
    const b = document.createElement('button');
    b.dataset.item = it.id;
    b.style.borderLeft = '3px solid ' + rarityOf(it.r).color;
    b.innerHTML = '<span class="name"><span style="color:' + rarityOf(it.r).color + '">' +
      esc(it.name) + '</span><small>' + RULES.SLOT_NAME[it.slot] + ' · ' + esc(itemLine(it)) +
      '</small></span><span class="cost muted"></span>';
    b.onclick = () => send({ t: 'equip', id: it.id });
    const kill = document.createElement('button');
    kill.className = 'drop';
    kill.textContent = '✕';
    kill.title = 'Discard ' + it.name;
    kill.onclick = () => {
      if (confirm('Discard ' + it.name + '? It is gone for good.')) send({ t: 'discard', id: it.id });
    };
    wrap.appendChild(b); wrap.appendChild(kill);
    el.bagList.appendChild(wrap);
    el.bagBtns.push({ it, b });
  }
  el.bagList.scrollTop = scroll;
}

function updateGear(r) {
  if (!el.gearHint) return;
  const canSwap = !!r.st0 && !r.d;
  const odds = RULES.RARITY.map(x => x.odds + '% ' + x.name.toLowerCase()).join(' · ');
  setHtml(el.gearHint,
    'Every escape drops one item: ' + odds + '. ' +
    (canSwap ? '<b class="good">You are on a START tile — swap freely.</b>'
             : '<b class="warn">Walk back to a START tile to change your gear.</b>') +
    ' Bag ' + INV.bag.length + ' / ' + RULES.BAG_MAX + '.');
  for (const g of el.gearEls || []) g.disabled = !canSwap;
  for (const e of el.bagBtns || []) {
    const worn = INV.equip[e.it.slot] === e.it.id;
    e.b.disabled = worn || !canSwap;
    e.b.classList.toggle('owned', worn);
    e.b.querySelector('.cost').textContent = worn ? 'worn' : canSwap ? 'equip' : '';
  }
}

/* ------------------------------------------------------------ runner update */
/* A level and what that level is actually worth, which past the soft cap are
   two different numbers. */
function lvLabel(key, kind, lv, gear) {
  const tot = lv + (gear || 0);
  const worn = gear ? ' <span class="gearlv">+' + gear + '</span>' : '';
  if (!tot) return 'lv 0';
  const e = RULES.effOf(key, kind, tot);
  if (!RULES.softCapped(key, kind, tot)) return 'lv ' + lv + worn;
  return 'lv ' + lv + worn + ' <span class="warn">→ eff ' + e.toFixed(1) + '</span>';
}

function updateRunner() {
  const r = myRunner();
  if (!r || !el.hpTxt) return;
  const tot = totOf(r);
  updateGear(r);
  setHtml($('statPill'), 'Finishes <b>' + r.fin + '</b> &nbsp; Points <span class="gold">' + r.pt + '</span>');
  el.hpTxt.textContent = Math.ceil(r.hp) + ' / ' + r.mh;
  el.hpBar.style.width = (100 * r.hp / r.mh) + '%';
  el.hpBar.style.background = r.hp / r.mh > 0.4 ? 'var(--good)' : 'var(--warn)';
  el.baWrap.style.display = r.bm > 0 ? '' : 'none';
  if (r.bm > 0) { el.baTxt.textContent = r.ba + ' / ' + r.bm; el.baBar.style.width = (100 * r.ba / r.bm) + '%'; }
  el.shWrap.style.display = r.sh > 0 ? '' : 'none';
  if (r.sh > 0) { el.shTxt.textContent = r.sh; el.shBar.style.width = Math.min(100, r.sh / 2) + '%'; }
  el.ptsTxt.textContent = r.pt;
  el.lapTxt.textContent = r.lap ? '  ·  ' + r.lap + ' lap' + (r.lap === 1 ? '' : 's') + ' banked' : '';

  const hold = RULES.escapeMs(SET, r.lap, (UL.up && UL.up.lockdown) || 0) / 1000;
  setHtml(el.rewardHint, 'Reaching an END is not enough: <b class="gold">hold it for ' + hold.toFixed(2) + 's</b> ' +
    '(it resets if you step off, and grows by ' + SET.escapeLap + 's every time you win). ' +
    'You take <b class="good">' + SET.endResist + '% less damage</b> while standing on it. ' +
    'Each escape: <b class="good">+' + SET.vpFinish + ' VP</b>, +' + (SET.ptsFinish + (tot.scholar || 0)) +
    ' points, a full heal, <b>an item</b>, and a permanent +' + SET.lapBonus + '% speed.');

  /* live numbers, so a curve is never something you have to take on trust */
  const spd = RULES.speed(SET, tot, r.lap);
  const st = [
    ['Speed', Math.round(spd) + ' px/s',
      'lv ' + tot.speed + ' · eff ' + RULES.speedEff(tot.speed).toFixed(1)],
    ['Max HP', r.mh, '+' + Math.round(26 * RULES.eff(tot.hp)) + ' from levels'],
    ['Regen', RULES.regenPerSec(tot).toFixed(1) + '/s', 'always'],
    ['Out of combat', '+' + RULES.oocPerSec(tot).toFixed(1) + '/s', 'after ' + (RULES.OOC_MS / 1000) + 's'],
    ['Barrier', Math.round(r.bm), '+' + RULES.barrierRegen(tot).toFixed(1) + '/s out of combat'],
    ['Healing power', '×' + RULES.healPow(tot).toFixed(2), 'all sources'],
    ['Resist · bullet', Math.round(100 * RULES.resistPct(tot, 'bullet')) + '%', 'armor + bullet'],
    ['Resist · fire', Math.round(100 * RULES.resistPct(tot, 'fire')) + '%', 'armor + fire'],
    ['Resist · energy', Math.round(100 * RULES.resistPct(tot, 'energy')) + '%', 'armor + energy'],
    ['Trap resist', Math.round(100 * (1 - RULES.trapMul(tot))) + '%', 'damage traps only'],
    ['Dodge', Math.round(100 * RULES.dodgeChance(tot)) + '%',
      'ceiling ' + Math.round(100 * RULES.DODGE_MAX) + '%'],
    ['Deflection', Math.round(100 * RULES.deflectChance(tot)) + '%',
      'ceiling ' + Math.round(100 * RULES.DODGE_MAX) + '%'],
    ['Bullets missed', Math.round(100 * RULES.evadeChance(tot)) + '%', 'the two together'],
    ['Cooldowns', '×' + RULES.hasteMul(tot).toFixed(2), 'haste'],
  ];
  setHtml(el.statBox, st.map(s =>
    '<div class="strow"><span>' + s[0] + '</span><b>' + s[1] + '</b><small>' + s[2] + '</small></div>').join(''));

  /* ultimate */
  const ultLv = r.up.ultimate || 0;
  const ultCost = RULES.ultCost(SET, ultLv);
  const buy = $('ultBuy');
  setHtml(buy, (ultLv ? 'Ultimate level ' + ultLv + ' &rarr; ' + (ultLv + 1) : 'Unlock the ultimate slot') +
    ' <span class="gold">' + ultCost + ' pt</span>');
  buy.disabled = r.pt < ultCost;
  const chosen = r.ul && RULES.ULTS[r.ul];
  setHtml($('ultHint'), !ultLv
    ? 'One slot. One SUPER BUFF. A ' + (RULES.ULT_CD / 1000) + 's cooldown and ' + (RULES.ULT_DUR / 1000) +
      's of the chosen stat raised to the power of <b>' + RULES.ULT_EXP + '</b>.'
    : (chosen ? '<b style="color:' + chosen.color + '">' + chosen.icon + ' ' + esc(chosen.name) + '</b> · ×' +
        RULES.ultMul(r.ul, ultLv).toFixed(1) + ' for ' + (RULES.ULT_DUR / 1000) + 's, every ' +
        Math.round(RULES.ultCd(tot) / 1000) + 's. Press <span class="kbd">G</span>.'
      : '<span class="warn">Pick which SUPER BUFF goes in the slot.</span>'));
  for (const b of el.ultBtns || []) {
    const k = b.dataset.ult;
    b.classList.toggle('sel', r.ul === k);
    b.disabled = !ultLv || r.uu > 0;
    b.querySelector('.cost').textContent = ultLv ? '×' + RULES.ultMul(k, ultLv).toFixed(1) : '';
  }

  /* ability slots */
  let owned = 0;
  for (const k of D.ABILITY_KEYS) if (r.up[k] > 0) owned++;
  const slotCost = RULES.slotCost(SET, r.sx);
  const full = r.sx >= D.ABILITY_KEYS.length;
  let pips = '';
  for (let i = 0; i < r.sx; i++) pips += '<i class="' + (i < owned ? 'on' : '') + '"></i>';
  setHtml($('slotLine'), pips + '<span class="muted">' + owned + ' / ' + r.sx + ' used</span>');
  const sb = $('slotBuy');
  setHtml(sb, full ? 'Every ability fits already'
    : 'Buy an ability slot <span class="gold">' + slotCost + ' pt</span>');
  sb.disabled = full || r.pt < slotCost;

  for (const b of el.upBtns || []) {
    const k = b.dataset.up, lv = r.up[k], u = D.UPGRADES[k];
    const cost = RULES.upgradeCost(SET, u, lv);
    const blocked = u.kind === 'ability' && lv === 0 && owned >= r.sx;
    setHtml(b.querySelector('.lv'), lvLabel(k, u.kind, lv, (r.gu && r.gu[k]) || 0));
    b.querySelector('.cost').textContent = blocked ? 'no slot' : cost + ' pt';
    b.querySelector('.cost').style.color = blocked ? 'var(--warn)' : '';
    b.disabled = blocked || r.pt < cost;
    b.classList.toggle('owned', lv > 0);
  }
  for (const d of el.dropBtns || []) {
    d.el.style.display = r.up[d.k] > 0 ? '' : 'none';
    d.el.textContent = '✕ ' + RULES.refundFor(SET, D.UPGRADES[d.k], r.up[d.k]);
    d.el.title = 'Drop ' + D.UPGRADES[d.k].name + ', free the slot, and take ' +
      RULES.refundFor(SET, D.UPGRADES[d.k], r.up[d.k]) + ' points back';
  }
}

function setTool(kind, type) {
  if (toolKind === kind && toolType === (type || null)) { toolKind = null; toolType = null; }
  else { toolKind = kind; toolType = type || null; }
  if (toolKind) selTower = null;
  if (toolKind !== 'tower') bucket = false;
  updateSide();
}

/* ================================================================ the HUD */
/* One row of slots under the board, the same for both roles: icon, key, cost,
   and a dark wedge that sweeps away as the cooldown runs down. The Mastermind
   sees their abilities and what they cost; a runner sees theirs plus the one
   ultimate slot on the end. */
const hud = $('hud');
let hudSlots = [];
const ULT_SLOT = '__ult';

function buildHud() {
  hud.innerHTML = '';
  hudSlots = [];
  if (!me || !D) return;
  const list = isMM() ? Object.keys(D.MM_ABILITIES) : D.ABILITY_KEYS.concat([ULT_SLOT]);
  for (const k of list) {
    const ult = k === ULT_SLOT;
    const def = ult ? { name: 'Ultimate', icon: '★', desc: 'Your SUPER BUFF. Long cooldown, enormous payoff.' }
      : isMM() ? D.MM_ABILITIES[k] : D.UPGRADES[k];
    const slot = document.createElement('div');
    slot.className = 'slot' + (ult ? ' ult' : '');
    slot.dataset.ab = k;
    slot.title = def.name + ' — ' + def.desc;
    slot.innerHTML =
      '<span class="key"></span><span class="cost"></span>' +
      '<span class="ico">' + (def.icon || '') + '</span>' +
      '<span class="nm">' + esc(def.name) + '</span>' +
      '<span class="sweep"></span><span class="secs"></span>';
    slot.onclick = () => hudClick(k);
    hud.appendChild(slot);
    hudSlots.push({
      k, def, ult, el: slot,
      key: slot.querySelector('.key'), cost: slot.querySelector('.cost'), ico: slot.querySelector('.ico'),
      nm: slot.querySelector('.nm'), sweep: slot.querySelector('.sweep'), secs: slot.querySelector('.secs'),
    });
  }
  const note = document.createElement('span');
  note.className = 'hudnote';
  note.id = 'hudNote';
  hud.appendChild(note);
  fitCanvas();                       /* the row just took height off the stage */
}

function hudClick(k) {
  if (isMM()) {
    const ab = D.MM_ABILITIES[k];
    if (!unlocked(k)) { send({ t: 'unlock', key: k }); return; }
    if (ab.aim) setTool('aim', k);
    else send({ t: 'ability', a: k });
    return;
  }
  const r = myRunner();
  if (!r) return;
  if (k === ULT_SLOT) {
    if (!r.up.ultimate) send({ t: 'upgrade', key: 'ultimate' });
    else if (!r.ul) toast('Pick a SUPER BUFF in the sidebar first.', 'warn');
    else send({ t: 'ult' });
    return;
  }
  if (!r.up[k]) send({ t: 'upgrade', key: k });   /* the slot shows the price */
  else send({ t: 'act', a: k });
}

function updateHud() {
  if (!S || !SET || !hudSlots.length) return;
  const r = myRunner();
  let owned = 0;
  if (r) for (const k of D.ABILITY_KEYS) if (r.up[k] > 0) owned++;
  for (const s of hudSlots) {
    if (isMM()) {
      const ab = D.MM_ABILITIES[s.k], cd = S.mmCd[s.k] || 0, have = unlocked(s.k);
      const broke = S.gold < ab.cost, blocked = S.edit || !!S.win;
      s.key.textContent = '';
      s.cost.textContent = have ? ab.cost : '🔒';
      s.cost.style.color = !have ? 'var(--muted)' : broke ? 'var(--warn)' : 'var(--gold)';
      s.sweep.style.setProperty('--deg', (cd > 0 ? 360 * cd / (ab.cd * 1000) : 0) + 'deg');
      s.secs.textContent = cd > 0 ? Math.ceil(cd / 1000) : '';
      s.el.classList.toggle('ready', have && cd <= 0 && !broke && !blocked);
      s.el.classList.toggle('locked', !have);
      s.el.classList.toggle('broke', have && (broke || blocked));
      s.el.classList.toggle('armed', toolKind === 'aim' && toolType === s.k);
    } else if (r && s.ult) {
      const lv = r.up.ultimate || 0, chosen = r.ul && RULES.ULTS[r.ul];
      const full = r.uf || RULES.ultCd(totOf(r));
      s.key.textContent = 'G';
      s.ico.textContent = chosen ? chosen.icon : '★';
      s.nm.textContent = chosen ? chosen.name : 'Ultimate';
      if (!lv) {
        s.cost.textContent = RULES.ultCost(SET, 0) + 'p';
        s.cost.style.color = r.pt >= RULES.ultCost(SET, 0) ? 'var(--good)' : 'var(--warn)';
        s.secs.textContent = '';
        s.sweep.style.setProperty('--deg', '0deg');
      } else {
        s.cost.textContent = 'L' + lv;
        s.cost.style.color = 'var(--muted)';
        s.sweep.style.setProperty('--deg', (r.uc > 0 ? 360 * Math.min(1, r.uc / full) : 0) + 'deg');
        s.secs.textContent = r.uu > 0 ? '★' : r.uc > 0 ? Math.ceil(r.uc / 1000) : '';
      }
      s.el.classList.toggle('locked', !lv);
      s.el.classList.toggle('ready', !!lv && !!chosen && r.uc <= 0 && !S.edit && !S.win && !S.bo && !r.d);
      s.el.classList.toggle('firing', r.uu > 0);
      s.el.style.setProperty('--ultc', chosen ? chosen.color : '#fbbf24');
    } else if (r) {
      const u = D.UPGRADES[s.k], lv = r.up[s.k], cd = r.cd[s.k] || 0;
      const locked = !lv;
      const noSlot = locked && owned >= r.sx;
      s.key.textContent = u.key === 'Space' ? 'SPC' : u.key;
      if (locked) {
        const cost = RULES.upgradeCost(SET, u, 0);
        s.cost.textContent = noSlot ? '⛔' : cost + 'p';
        s.cost.style.color = noSlot ? 'var(--warn)' : r.pt >= cost ? 'var(--good)' : 'var(--warn)';
        s.secs.textContent = '';
        s.sweep.style.setProperty('--deg', '0deg');
      } else {
        /* The length this cooldown actually started at, straight from the
           server -- not recomputed from the current Haste, which made the
           wedge jump if you bought Haste while something was cooling down. */
        const full = (r.cf && r.cf[s.k]) || RULES.ability[s.k](lv).cd * RULES.hasteMul(totOf(r));
        s.cost.textContent = 'L' + lv + (lv > RULES.AB_CAP ? '▾' : '');
        s.cost.style.color = lv > RULES.AB_CAP ? 'var(--warn)' : 'var(--muted)';
        s.sweep.style.setProperty('--deg', (cd > 0 ? 360 * Math.min(1, cd / full) : 0) + 'deg');
        s.secs.textContent = cd > 0 ? (cd >= 1000 ? Math.ceil(cd / 1000) : (cd / 1000).toFixed(1)) : '';
      }
      s.el.classList.toggle('locked', locked);
      s.el.classList.toggle('noslot', noSlot);
      s.el.classList.toggle('ready', !locked && cd <= 0 && !S.edit && !S.win && !S.bo && !r.d);
      s.el.classList.toggle('broke', false);
    }
  }
  const note = $('hudNote');
  if (!note) return;
  if (isMM()) {
    setHtml(note, 'Gold <b class="gold">' + S.gold + '</b> · Unlock <b class="gold">' + S.up + '</b>' +
      ' <span class="muted">(' + S.upr + '/' + S.upn + ')</span>' +
      (S.edit ? ' <span class="warn">· editing</span>' : ''));
  } else if (r) {
    setHtml(note, 'Points <b class="gold">' + r.pt + '</b> · slots <b>' + owned + '/' + r.sx + '</b>' +
      (S.bo > 0 ? ' <b class="warn">· BLACKOUT</b>' : '') +
      (r.uu > 0 ? ' <b class="gold">· ULTIMATE</b>' : '') +
      (r.d ? ' <b class="warn">· down</b>' : ''));
  }
}

/* ================================================================ canvas io */
const cv = $('cv'), ctx = cv.getContext('2d');
let scale = 1;
let terrain = document.createElement('canvas'), terrainDirty = true;

function fitCanvas() {
  if (!grid || !D) return;
  const w = grid.gw * D.CELL, h = grid.gh * D.CELL;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; terrainDirty = true; }
  VFX.setBoard(w, h);
  SFX.setBoard(w);
  const st = $('stage');
  scale = Math.min(st.clientWidth / w, st.clientHeight / h, 1.7);
  cv.style.width = Math.floor(w * scale) + 'px';
  cv.style.height = Math.floor(h * scale) + 'px';
}
window.addEventListener('resize', fitCanvas);

function cellFromEvent(e) {
  const r = cv.getBoundingClientRect();
  const x = (e.clientX - r.left) / scale, y = (e.clientY - r.top) / scale;
  return { px: x, py: y, x: Math.floor(x / D.CELL), y: Math.floor(y / D.CELL) };
}
function inGrid(c) { return grid && c.x >= 0 && c.y >= 0 && c.x < grid.gw && c.y < grid.gh; }

/* --------------------------------------------------------------- pointer */
/* One stroke machine drives every drag: painting track, laying towers, selling,
   and dragging out an area. Holding Shift turns a click into a stroke for the
   tools that would otherwise be one-shot, which is the "speed painting" bit. */
cv.addEventListener('contextmenu', e => e.preventDefault());

function cellsAlong(a, b, fn) {
  let x0 = a.x, y0 = a.y;
  const dx = Math.abs(b.x - x0), dy = Math.abs(b.y - y0);
  const sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1;
  let err = dx - dy;
  for (let guard = 0; guard < 500; guard++) {
    fn(x0, y0);
    if (x0 === b.x && y0 === b.y) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

function applyCell(x, y) {
  if (!grid || x < 0 || y < 0 || x >= grid.gw || y >= grid.gh) return;
  if (stroke.kind === 'paint') {
    send({ t: 'paint', x, y, tile: stroke.tile });
    SFX.play('paint');
  } else if (stroke.kind === 'place') {
    if (!towerAt(x, y)) send({ t: 'tower', type: stroke.type, x, y });
  } else if (stroke.kind === 'sell') {
    if (towerAt(x, y)) {
      send({ t: 'sell', x, y });
      if (selTower === x + ',' + y) selTower = null;
    }
  }
}

function strokeTo(c) {
  if (!stroke) return;
  const from = stroke.last || { x: c.x, y: c.y };
  cellsAlong(from, c, applyCell);
  stroke.last = { x: c.x, y: c.y };
}

/* Built from the server's own tile table rather than hardcoded, so renumbering
   a tile there can never leave the brushes painting the wrong thing here. */
let TILE_FOR_TOOL = {};
function buildTileMap() {
  TILE_FOR_TOOL = { path: D.T.PATH, erase: D.T.EMPTY, start: D.T.START,
                    end: D.T.END, steep: D.T.STEEP, tunnel: D.T.TUNNEL };
}

cv.addEventListener('mousemove', e => {
  if (!D) return;
  hover = cellFromEvent(e);
  if (!inGrid(hover)) return;
  if (stroke) strokeTo(hover);
  else if (areaDrag) area = { x0: areaDrag.x, y0: areaDrag.y, x1: hover.x, y1: hover.y };
});
cv.addEventListener('mouseleave', () => { hover = null; endStroke(); });

cv.addEventListener('mousedown', e => {
  if (!D || !isMM() || !S) return;
  const c = cellFromEvent(e);
  if (!inGrid(c)) return;
  const fast = e.shiftKey;

  if (e.button === 2) {                                  /* right: sell */
    stroke = { kind: 'sell', drag: fast };
    strokeTo(c);
    if (!fast) endStroke();
    return;
  }
  if (toolKind === 'area') {
    areaDrag = { x: c.x, y: c.y };
    area = { x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    return;
  }
  if (toolKind === 'path' || toolKind === 'erase' || toolKind === 'steep' || toolKind === 'tunnel') {
    if (!S.edit) return;
    stroke = { kind: 'paint', tile: TILE_FOR_TOOL[toolKind], drag: true };
    strokeTo(c);
  } else if (toolKind === 'start' || toolKind === 'end') {
    if (!S.edit) return;
    /* Several of these are allowed when the room asks for them, so painting
       them gets the stroke machine too. */
    stroke = { kind: 'paint', tile: TILE_FOR_TOOL[toolKind], drag: fast && !!SET.multiEnds };
    strokeTo(c);
    if (!stroke.drag) endStroke();
  } else if (toolKind === 'tower') {
    if (bucket) { send({ t: 'fill', type: toolType, x: c.x, y: c.y }); return; }
    if (towerAt(c.x, c.y) && !fast) {
      selTower = c.x + ',' + c.y; toolKind = null; toolType = null; updateSide();
      return;
    }
    stroke = { kind: 'place', type: toolType, drag: fast };
    strokeTo(c);
    if (!fast) endStroke();
  } else if (toolKind === 'aim') {
    send({ t: 'ability', a: toolType, x: c.px, y: c.py });
    toolKind = null; toolType = null; updateSide();
  } else {
    selTower = towerAt(c.x, c.y) ? c.x + ',' + c.y : null;
    updateSide();
  }
});

function endStroke() {
  stroke = null;
  if (areaDrag) {
    areaDrag = null;
    if (area && area.x0 === area.x1 && area.y0 === area.y1) area = null;   /* a click clears it */
    updateSide();
  }
}
cv.addEventListener('mouseup', e => {
  if (stroke && stroke.drag && D) { const c = cellFromEvent(e); if (inGrid(c)) strokeTo(c); }
  endStroke();
});
window.addEventListener('mouseup', endStroke);

/* ------------------------------------------------------------------ keyboard */
function sendInput() {
  const dx = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  const dy = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
  send({ t: 'input', dx, dy });
}
const KEY_TO_ABILITY = {};   /* filled once defs arrive */
function buildKeyMap() {
  for (const k of D.ABILITY_KEYS) {
    const key = D.UPGRADES[k].key;
    KEY_TO_ABILITY[key === 'Space' ? 'Space' : 'Key' + key] = k;
  }
}

window.addEventListener('keydown', e => {
  if (!me || !D || e.target.tagName === 'INPUT') return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  SFX.init();
  if (e.code === 'KeyM') { toggleSound(); return; }
  if (me.role === 'runner') {
    if (e.code === 'KeyG') { send({ t: 'ult' }); return; }
    if (!Object.keys(KEY_TO_ABILITY).length) buildKeyMap();
    const ab = KEY_TO_ABILITY[e.code];
    if (ab) { send({ t: 'act', a: ab }); return; }
    keys[e.code] = true; sendInput();
  } else {
    const types = Object.keys(D.TOWERS).concat(Object.keys(D.TRAPS));
    if (e.code.startsWith('Digit')) {
      const i = +e.code.slice(5) - 1;
      if (!types[i]) return;
      if (unlocked(types[i])) setTool('tower', types[i]);
      else toast(defOf(types[i]).name + ' is still locked. Spend an unlock point on it first.', 'warn');
    } else if (e.code === 'Escape') {
      toolKind = null; toolType = null; selTower = null; bucket = false; area = null; updateSide();
    } else if (e.code === 'KeyX' && selTower) {
      const [x, y] = selTower.split(',').map(Number);
      send({ t: 'sell', x, y }); selTower = null;
    }
  }
});
window.addEventListener('keyup', e => {
  if (!me || me.role !== 'runner') return;
  if (keys[e.code]) { keys[e.code] = false; sendInput(); }
});
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  if (me && me.role === 'runner') sendInput();
});

/* ----------------------------------------------------------------- controls */
$('joinMM').onclick = () => connect('mm');
$('joinRun').onclick = () => connect('runner');
$('switchRole').onclick = () => send({ t: 'role', role: isMM() ? 'runner' : 'mm' });
$('copyLink').onclick = () => {
  const link = location.origin + '/?room=' + me.room;
  navigator.clipboard.writeText(link).then(() => toast('Link copied: ' + link, 'good'),
    () => prompt('Copy this link', link));
};
document.addEventListener('click', e => { SFX.init(); if (e.target.closest('button')) SFX.play('ui'); });

function updateSoundUI() {
  $('soundBtn').innerHTML = SFX.isEnabled() && SFX.getVolume() > 0 ? '&#128266;' : '&#128263;';
  $('soundBtn').classList.toggle('sel', SFX.isEnabled() && SFX.getVolume() > 0);
  $('volSlider').value = Math.round(SFX.getVolume() * 100);
}
function toggleSound() { SFX.setEnabled(!SFX.isEnabled()); updateSoundUI(); if (SFX.isEnabled()) SFX.play('good'); }
$('soundBtn').onclick = toggleSound;
$('volSlider').oninput = e => { SFX.setVolume(e.target.value / 100); updateSoundUI(); };
updateSoundUI();
$('room').value = new URLSearchParams(location.search).get('room') || '';
try { $('name').value = localStorage.getItem('tm_name') || ''; } catch (e) {}
for (const id of ['name', 'room']) {
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') connect('runner'); });
}

/* ================================================================== drawing */
const COLORS = ['#f472b6', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#2dd4bf', '#f87171'];
const runnerColor = id => COLORS[id % COLORS.length];
let lastFrame = performance.now();

function drawTerrain() {
  const C = D.CELL, T = D.T;
  /* A fresh canvas element is 300x150 until something sets it, and setting the
     size also clears it -- so the cache is sized here, where it is about to be
     redrawn anyway, rather than anywhere that might skip it. */
  if (terrain.width !== cv.width || terrain.height !== cv.height) {
    terrain.width = cv.width; terrain.height = cv.height;
  }
  const g = terrain.getContext('2d');
  g.fillStyle = '#132018'; g.fillRect(0, 0, terrain.width, terrain.height);
  /* Mouths pair up in reading order, so an odd number of them leaves the last
     one with nobody to link to. Count first so that one can be drawn as the
     dud it is instead of silently doing nothing when a runner steps in. */
  let tunnelTotal = 0;
  for (let i = 0; i < grid.tiles.length; i++) if (grid.tiles[i] === T.TUNNEL) tunnelTotal++;
  let tunnelNo = 0;
  for (let y = 0; y < grid.gh; y++) {
    for (let x = 0; x < grid.gw; x++) {
      const t = grid.tiles[y * grid.gw + x];
      if (t === T.EMPTY) g.fillStyle = (x + y) % 2 ? '#16281c' : '#1a2e21';
      else if (t === T.PATH) g.fillStyle = (x + y) % 2 ? '#c6b088' : '#cfba92';
      else if (t === T.START) g.fillStyle = '#22c55e';
      else if (t === T.END) g.fillStyle = '#eab308';
      else if (t === T.STEEP) g.fillStyle = (x + y) % 2 ? '#8a7a5c' : '#948364';
      else g.fillStyle = '#241a3a';
      g.fillRect(x * C, y * C, C, C);
      if (t === T.PATH) {
        g.fillStyle = 'rgba(120,90,50,.12)';
        for (let i = 0; i < 3; i++) {
          const hx = ((x * 37 + y * 17 + i * 53) % 31) + 4, hy = ((x * 11 + y * 29 + i * 19) % 31) + 4;
          g.fillRect(x * C + hx, y * C + hy, 3, 2);
        }
      } else if (t === T.STEEP) {
        /* chevrons, so "this bit is a climb" reads instantly */
        g.strokeStyle = 'rgba(40,28,10,.45)'; g.lineWidth = 2.5; g.lineCap = 'round';
        for (let i = 0; i < 3; i++) {
          const yy = y * C + 9 + i * 11;
          g.beginPath();
          g.moveTo(x * C + 9, yy + 5); g.lineTo(x * C + C / 2, yy); g.lineTo(x * C + C - 9, yy + 5);
          g.stroke();
        }
      } else if (t === T.TUNNEL) {
        tunnelNo++;
        const odd = tunnelNo === tunnelTotal && tunnelTotal % 2 === 1;
        const cx = x * C + C / 2, cy = y * C + C / 2;
        const grd = g.createRadialGradient(cx, cy, 2, cx, cy, C / 2);
        grd.addColorStop(0, '#000'); grd.addColorStop(1, odd ? '#4c1d24' : '#3b2a63');
        g.fillStyle = grd;
        g.beginPath(); g.arc(cx, cy, C / 2 - 3, 0, Math.PI * 2); g.fill();
        g.strokeStyle = odd ? '#f87171' : '#a78bfa'; g.lineWidth = 2;
        if (odd) g.setLineDash([4, 4]);
        g.beginPath(); g.arc(cx, cy, C / 2 - 4, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
        /* the pair number: mouths link 1-2, 3-4, 5-6 in reading order */
        g.fillStyle = odd ? '#fecaca' : '#e9d5ff';
        g.font = 'bold 13px system-ui'; g.textAlign = 'center';
        g.fillText(odd ? '?' : String(Math.ceil(tunnelNo / 2)), cx, cy + 5);
      }
    }
  }
  g.strokeStyle = 'rgba(0,0,0,.16)'; g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= grid.gw; x++) { g.moveTo(x * C + 0.5, 0); g.lineTo(x * C + 0.5, terrain.height); }
  for (let y = 0; y <= grid.gh; y++) { g.moveTo(0, y * C + 0.5); g.lineTo(terrain.width, y * C + 0.5); }
  g.stroke();
  terrainDirty = false;
}

/* A building's platform grows with its form: bigger, then armoured, then
   ringed, then orbited, then lit from inside, then spiked, then haloed. The
   weapon on top gets its own treatment per type, so all seven shapes read
   differently at a glance. */
function drawPlatform(cx, cy, form, color, now, dis) {
  const r = 15 + form * 1.5;
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  if (form >= 6) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.globalAlpha = 0.35 + 0.2 * Math.sin(now / 260);
    ctx.beginPath(); ctx.arc(cx, cy, r + 7, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  if (form >= 5) {
    ctx.fillStyle = dis ? '#4b5563' : color;
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3 + now / 2600;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a + 0.16) * (r + 6), cy + Math.sin(a + 0.16) * (r + 6));
      ctx.lineTo(cx + Math.cos(a + 0.32) * r, cy + Math.sin(a + 0.32) * r);
      ctx.fill();
    }
  }
  if (form >= 1) {
    ctx.strokeStyle = dis ? '#4b5563' : color; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4 + Math.PI / 8;
      const px = cx + Math.cos(a) * (r - 1.5), py = cy + Math.sin(a) * (r - 1.5);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.stroke();
  }
  if (form >= 2) {
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r - 5, 0, Math.PI * 2); ctx.stroke();
  }
  if (form >= 3) {
    ctx.fillStyle = dis ? '#4b5563' : color;
    for (let i = 0; i < 3; i++) {
      const a = now / 900 + i * Math.PI * 2 / 3;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * (r + 4), cy + Math.sin(a) * (r + 4), 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (form >= 4 && !dis) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
    g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.3 + 0.15 * Math.sin(now / 200);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

/* How many barrels, blades or coils a shape has grown. */
function parts(form) { return form >= 6 ? 4 : form >= 4 ? 3 : form >= 2 ? 2 : 1; }

function drawTower(tw, now) {
  const C = D.CELL, def = defOf(tw.ty), dyn = twDyn.get(tw.id) || {};
  const cx = (tw.gx + 0.5) * C, cy = (tw.gy + 0.5) * C;
  const dis = !!dyn.d;
  const col = dis ? '#4b5563' : def.color;
  const form = RULES.form(tw.up);
  const range = RULES.range(def, tw.up);
  const grow = 1 + form * 0.07;

  if (def.onPath) {
    drawTrap(tw, def, dyn, cx, cy, col, now, form);
  } else {
    /* aura footprints go under the body */
    if (tw.ty === 'frost') {
      ctx.fillStyle = 'rgba(165,243,252,.09)';
      ctx.beginPath(); ctx.arc(cx, cy, range, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(165,243,252,.3)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, range, 0, Math.PI * 2); ctx.stroke();
    }
    if (tw.ty === 'flame' && dyn.f && !dis) {
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, range);
      g.addColorStop(0, 'rgba(251,146,60,.45)'); g.addColorStop(1, 'rgba(251,113,133,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, range, 0, Math.PI * 2); ctx.fill();
    }

    drawPlatform(cx, cy, form, def.color, now, dis);
    const a = dyn.a || 0, n = parts(form);
    ctx.fillStyle = col;

    if (tw.ty === 'sniper') {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a); ctx.scale(grow, grow);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(-10, -9); ctx.lineTo(9, -7); ctx.lineTo(9, 7); ctx.lineTo(-10, 9);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#0b1020';
      for (let i = 0; i < n; i++) ctx.fillRect(8, -1.5 - (n - 1) * 2.5 + i * 5, 18 + form * 3, 3);
      if (form >= 4) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-4, 0, 2.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    } else if (tw.ty === 'mortar') {
      ctx.beginPath(); ctx.arc(cx, cy, 12 * grow, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      ctx.fillStyle = '#0b1020';
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 7;
        ctx.fillRect(0, off - 3, 15 + form * 2, 6);
      }
      ctx.restore();
    } else if (tw.ty === 'tesla') {
      ctx.beginPath(); ctx.arc(cx, cy, 10 * grow, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = dis ? '#4b5563' : '#e9d5ff'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 3 + form; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, 5 + i * 3, now / 300 + i, now / 300 + i + 2.2);
        ctx.stroke();
      }
    } else if (tw.ty === 'pulse') {
      ctx.beginPath(); ctx.arc(cx, cy, 11 * grow, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(34,211,238,.5)'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 1 + Math.floor(form / 2); i++) {
        const p = ((now + i * 470) % 1400) / 1400;
        ctx.globalAlpha = 1 - p;
        ctx.beginPath(); ctx.arc(cx, cy, 12 + p * (range - 12), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (tw.ty === 'laser') {
      ctx.beginPath(); ctx.arc(cx, cy, 11 * grow, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      ctx.fillStyle = '#0b1020'; ctx.fillRect(4, -4 - form * 0.4, 16 + form * 2, 8 + form * 0.8);
      ctx.fillStyle = dyn.f ? '#fff' : '#7f1d1d';
      ctx.beginPath(); ctx.arc(19 + form * 2, 0, 3.5 + form * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (dyn.f && dyn.bx !== undefined) {
        const heat = Math.min(1, (dyn.bt || 0) / (def.rampTime || 1));
        const w = (2 + heat * 3) * (1 + form * 0.18);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = def.color; ctx.lineCap = 'round';
        ctx.globalAlpha = 0.25; ctx.lineWidth = w * 3.5;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(dyn.bx, dyn.by); ctx.stroke();
        ctx.globalAlpha = 1; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(dyn.bx, dyn.by); ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1, w * 0.4);
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(dyn.bx, dyn.by); ctx.stroke();
        ctx.restore();
      }
    } else if (tw.ty === 'flame') {
      ctx.beginPath(); ctx.arc(cx, cy, 11 * grow, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      ctx.fillStyle = '#0b1020';
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 6;
        ctx.fillRect(6, off - 2.5, 12 + form, 5);
      }
      ctx.restore();
    } else if (tw.ty === 'frost') {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(now / 1600);
      ctx.fillStyle = col;
      const arms = 3 + Math.floor(form / 2);
      for (let i = 0; i < arms; i++) {
        ctx.rotate(Math.PI / arms);
        ctx.fillRect(-11 * grow, -2, 22 * grow, 4);
      }
      ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(cx, cy, 11 * grow, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      ctx.strokeStyle = '#0b1020'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 6;
        ctx.beginPath(); ctx.moveTo(0, off); ctx.lineTo(17 + form * 1.5, off); ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* Progress toward the next shape: one dot per upgrade since the last one. */
  const since = RULES.upgrades(tw.up) % RULES.FORM_STEP;
  const maxed = form >= RULES.MAX_FORM;
  if (maxed) {
    ctx.fillStyle = '#fbbf24'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'left';
    ctx.fillText('MAX', tw.gx * C + 4, tw.gy * C + 10);
  } else if (since > 0) {
    ctx.fillStyle = '#fbbf24';
    for (let i = 0; i < since; i++) {
      ctx.beginPath(); ctx.arc(tw.gx * C + 7 + i * 5, tw.gy * C + 5, 1.8, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (dis) {
    ctx.save(); ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 90);
    ctx.fillStyle = '#facc15'; ctx.font = 'bold 15px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('⚡', cx, cy + 5); ctx.restore();
  }
  const isSel = selTower === tw.gx + ',' + tw.gy;
  if (isMM() && range && (isSel || (hover && hover.x === tw.gx && hover.y === tw.gy))) {
    ctx.strokeStyle = isSel ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, range, 0, Math.PI * 2); ctx.stroke();
    if (def.minRange) { ctx.beginPath(); ctx.arc(cx, cy, def.minRange, 0, Math.PI * 2); ctx.stroke(); }
  }
  if (isSel) {
    ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 2;
    ctx.strokeRect(tw.gx * C + 1, tw.gy * C + 1, C - 2, C - 2);
  }
}

function drawTrap(tw, def, dyn, cx, cy, col, now, form) {
  const C = D.CELL, dis = !!dyn.d, ready = !dyn.c;
  const grow = 1 + form * 0.06;
  switch (tw.ty) {
    case 'spikes': {
      const n = 3 + Math.floor(form / 2);
      const step = (C - 10) / n;
      ctx.fillStyle = dis ? '#555' : '#e5e7eb';
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const px = tw.gx * C + 5 + step * (i + 0.5), py = tw.gy * C + 5 + step * (j + 0.5);
        const h = 5 * grow;
        ctx.beginPath();
        ctx.moveTo(px - h * 0.8, py + h * 0.8); ctx.lineTo(px, py - h); ctx.lineTo(px + h * 0.8, py + h * 0.8);
        ctx.fill();
      }
      break;
    }
    case 'glue':
      ctx.fillStyle = dis ? 'rgba(120,120,120,.6)' : 'rgba(163,230,53,' + (0.6 + form * 0.06) + ')';
      ctx.beginPath(); ctx.ellipse(cx, cy, 16 * grow, 13 * grow, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx + 9, cy - 8, 6, 5, 0, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < form; i++) {
        const a = i * 1.7 + now / 1800;
        ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 13, cy + Math.sin(a) * 10, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'saw': {
      const teeth = 8 + form * 2, rad = 16 * grow;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(now / (90 - form * 8));
      ctx.fillStyle = dis ? '#4b5563' : '#cbd5e1';
      for (let i = 0; i < teeth; i++) {
        ctx.rotate(Math.PI * 2 / teeth);
        ctx.beginPath(); ctx.moveTo(0, -rad); ctx.lineTo(4.5, -rad + 7); ctx.lineTo(-4.5, -rad + 7);
        ctx.closePath(); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(0, 0, 9 * grow, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0b1020'; ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      break;
    }
    case 'mine': {
      const prongs = 6 + form;
      ctx.fillStyle = '#1f2937';
      ctx.beginPath(); ctx.arc(cx, cy, 11 * grow, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4b5563';
      for (let i = 0; i < prongs; i++) {
        const a = i * Math.PI * 2 / prongs;
        ctx.fillRect(cx + Math.cos(a) * 11 * grow - 1.5, cy + Math.sin(a) * 11 * grow - 1.5, 3, 3);
      }
      ctx.fillStyle = (now % Math.max(220, 900 - form * 110) < 450) ? '#ef4444' : '#7f1d1d';
      ctx.beginPath(); ctx.arc(cx, cy, 4 + form * 0.4, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'snare': {
      const teeth = 8 + form * 2;
      ctx.strokeStyle = dis ? '#4b5563' : ready ? col : 'rgba(252,211,77,.25)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(cx, cy, 13 * grow, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      for (let i = 0; i < teeth; i++) {
        const a = i * Math.PI * 2 / teeth;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * 13 * grow, cy + Math.sin(a) * 13 * grow);
        ctx.lineTo(cx + Math.cos(a + 0.18) * 6, cy + Math.sin(a + 0.18) * 6);
        ctx.lineTo(cx + Math.cos(a - 0.18) * 6, cy + Math.sin(a - 0.18) * 6);
        ctx.fill();
      }
      break;
    }
    case 'tar': {
      /* A column of fire. Plain translucent discs under additive blending
         rather than a gradient per lick: a board full of braziers was building
         a new CanvasGradient object dozens of times every frame. */
      const licks = 4 + form;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < licks; i++) {
        const t = now / 220 + i * 1.7;
        const h = (10 + form * 1.6) * (0.65 + 0.35 * Math.sin(t));
        const ox = Math.sin(t * 0.7 + i) * 7, oy = cy - h * 0.3;
        ctx.fillStyle = dis ? 'rgba(120,120,120,.10)' : 'rgba(245,158,11,.16)';
        ctx.beginPath(); ctx.arc(cx + ox, oy, h, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = dis ? 'rgba(160,160,160,.12)' : 'rgba(255,237,160,.22)';
        ctx.beginPath(); ctx.arc(cx + ox, oy, h * 0.45, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = dis ? '#4b5563' : '#78350f';
      ctx.beginPath(); ctx.ellipse(cx, cy + 10, 12 * grow, 4.5, 0, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'jolt': {
      ctx.fillStyle = dis ? '#374151' : ready ? '#312e81' : '#1f1b45';
      ctx.fillRect(tw.gx * C + 5, tw.gy * C + 5, C - 10, C - 10);
      ctx.strokeStyle = dis ? '#4b5563' : ready ? col : 'rgba(129,140,248,.3)';
      ctx.lineWidth = 2;
      ctx.strokeRect(tw.gx * C + 5, tw.gy * C + 5, C - 10, C - 10);
      if (ready && !dis) {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = '#c7d2fe'; ctx.lineWidth = 1.4;
        for (let i = 0; i < 2 + form; i++) {
          const a = now / 160 + i * 2.1;
          ctx.beginPath();
          ctx.moveTo(cx - 9, cy + Math.sin(a) * 6);
          ctx.lineTo(cx - 3, cy + Math.sin(a + 1) * 6);
          ctx.lineTo(cx + 3, cy + Math.sin(a + 2) * 6);
          ctx.lineTo(cx + 9, cy + Math.sin(a + 3) * 6);
          ctx.stroke();
        }
        ctx.restore();
      }
      break;
    }
    case 'portal': {
      const t = now / 420, rings = 3 + form;
      ctx.save();
      ctx.globalAlpha = ready ? 1 : 0.3;
      for (let i = 0; i < rings; i++) {
        ctx.strokeStyle = i ? 'rgba(192,132,252,.7)' : '#e9d5ff';
        ctx.lineWidth = Math.max(0.8, 2.5 - i * 0.35);
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(2, (15 - i * 2.2) * grow), Math.max(1, (7 - i) * grow), t + i * 1.1, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (form >= 4 && ready) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(192,132,252,.25)';
        ctx.beginPath(); ctx.arc(cx, cy, 8 * grow, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      break;
    }
  }
  if (dyn.c && tw.ty !== 'portal' && tw.ty !== 'snare' && tw.ty !== 'jolt') {
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.fillRect(tw.gx * C, tw.gy * C, C, C);
  }
}

/* What a runner is wearing, drawn on the blob itself: a dome for the helmet,
   a band for the chestplate, a pair of pads for the boots, each in its rarity
   colour. A legendary piece gets a light bloom so it reads across the board. */
function drawGear(r, d, now, alpha) {
  if (!r.eq) return;
  const R = D.RUNNER_R;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    /* second pass is the legendary bloom, drawn additively over the top */
    if (pass === 1) {
      if (!r.eq.some(x => x === 3)) break;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * (0.35 + 0.25 * Math.sin(now / 200));
    }
    const wide = pass === 1 ? 3 : 0;
    if (r.eq[2] >= 0 && (pass === 0 || r.eq[2] === 3)) {          /* boots */
      ctx.fillStyle = rarityOf(r.eq[2]).color;
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(d.x + sx * R * 0.5, d.y + R * 0.8, 4.4 + wide, 2.6 + wide * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (r.eq[1] >= 0 && (pass === 0 || r.eq[1] === 3)) {          /* chestplate */
      ctx.fillStyle = rarityOf(r.eq[1]).color;
      const w = R * 1.55 + wide, h = 4.5 + wide;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(d.x - w / 2, d.y + 1 - h / 2, w, h, h / 2);
      else ctx.rect(d.x - w / 2, d.y + 1 - h / 2, w, h);
      ctx.fill();
    }
    if (r.eq[0] >= 0 && (pass === 0 || r.eq[0] === 3)) {          /* helmet */
      ctx.strokeStyle = rarityOf(r.eq[0]).color;
      ctx.lineWidth = 4 + wide;
      ctx.beginPath();
      ctx.arc(d.x, d.y - 0.5, R + 1, Math.PI * 1.13, Math.PI * 1.87);
      ctx.stroke();
      if (r.eq[0] >= 2) {                                          /* epic and up: a crest */
        ctx.beginPath();
        ctx.moveTo(d.x, d.y - R - 2);
        ctx.lineTo(d.x, d.y - R - 6 - (r.eq[0] === 3 ? 2 : 0));
        ctx.lineWidth = 2.5 + wide;
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function drawRunner(r, d, now, dt) {
  const R = D.RUNNER_R, col = runnerColor(r.id);
  if (r.d) {
    ctx.strokeStyle = 'rgba(248,113,113,.7)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(d.x - 8, d.y - 8); ctx.lineTo(d.x + 8, d.y + 8);
    ctx.moveTo(d.x + 8, d.y - 8); ctx.lineTo(d.x - 8, d.y + 8);
    ctx.stroke();
    if (r.rs > 0) {
      ctx.fillStyle = '#fca5a5'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText((r.rs / 1000).toFixed(1) + 's', d.x, d.y + 24);
    }
    return;
  }
  /* trails while moving fast */
  if ((r.ds || r.su || r.uu > 0) && Math.random() < 0.8) {
    VFX.part({ x: d.x, y: d.y, vx: 0, vy: 0, life: 0.3, size: R * 0.8,
      c: r.uu > 0 ? '#000000' : r.ds ? '#e2e8f0' : '#34d399', drag: 1 });
  }
  /* Ghost is a flicker now, not a cloak: while a trap has your position the
     outline snaps back to solid so everyone can see it happen. */
  ctx.globalAlpha = r.gh ? 0.4 : r.fk ? 0.85 : 1;
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(d.x, d.y, R + 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = r.fr ? '#93c5fd' : col;
  ctx.beginPath(); ctx.arc(d.x, d.y, R, 0, Math.PI * 2); ctx.fill();
  /* eyes point where you are facing */
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(d.x + r.fx * 4 - r.fy * 4, d.y + r.fy * 4 + r.fx * 4, 2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(d.x + r.fx * 4 + r.fy * 4, d.y + r.fy * 4 - r.fx * 4, 2, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  drawGear(r, d, now, r.gh ? 0.4 : r.fk ? 0.85 : 1);

  if (r.ba > 0) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 3;
    ctx.globalAlpha = 0.25 + 0.4 * (r.ba / Math.max(1, r.bm));
    ctx.beginPath(); ctx.arc(d.x, d.y, R + 3.5, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  if (r.sh > 0) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2;
    ctx.globalAlpha = 0.55 + 0.25 * Math.sin(now / 160);
    ctx.beginPath(); ctx.arc(d.x, d.y, R + 6, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  if (r.uu > 0) {
    /* the ultimate: a black corona with a coloured edge */
    const u = r.ul && RULES.ULTS[r.ul];
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = u ? u.color : '#fbbf24'; ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.5 - i * 0.13;
      ctx.beginPath(); ctx.arc(d.x, d.y, R + 8 + i * 6 + Math.sin(now / 90 + i) * 2, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
  if (r.rt) {
    ctx.strokeStyle = '#fcd34d'; ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5 + now / 500;
      ctx.beginPath();
      ctx.moveTo(d.x + Math.cos(a) * (R + 8), d.y + Math.sin(a) * (R + 8) * 0.5);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
    }
  }
  if (r.gh) {
    ctx.strokeStyle = 'rgba(233,213,255,.8)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(d.x, d.y, R + 4 + Math.sin(now / 130) * 2, 0, Math.PI * 2); ctx.stroke();
  }
  if (r.fk) {
    /* flickering: the cloak is failing */
    ctx.save(); ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 45);
    ctx.strokeStyle = '#fca5a5'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(d.x, d.y, R + 7, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  /* holding the END: a ring that closes as the escape clock runs */
  if (r.esc > 0) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(8,12,24,.75)'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(d.x, d.y, R + 13, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(d.x, d.y, R + 13, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * r.esc);
    ctx.stroke();
    ctx.restore();
    if (r.id === me.id) {
      ctx.fillStyle = '#fde68a'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('HOLD ' + ((r.en * (1 - r.esc)) / 1000).toFixed(1) + 's', d.x, d.y + R + 30);
    }
  }

  /* Health, then barrier, then shield, stacked upwards -- and the name sits
     above whatever the stack ended up being, so a runner carrying both extra
     bars does not have them drawn through their own name. */
  let top = d.y - 17;
  ctx.fillStyle = '#0b1020'; ctx.fillRect(d.x - 15, top, 30, 4);
  ctx.fillStyle = r.hp / r.mh > 0.4 ? '#4ade80' : '#f87171';
  ctx.fillRect(d.x - 15, top, 30 * Math.max(0, r.hp / r.mh), 4);
  if (r.ba > 0) {
    top -= 3.5;
    ctx.fillStyle = '#0b1020'; ctx.fillRect(d.x - 15, top, 30, 2.5);
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(d.x - 15, top, 30 * Math.min(1, r.ba / Math.max(1, r.bm)), 2.5);
  }
  if (r.sh > 0) {
    top -= 3.5;
    ctx.fillStyle = '#0b1020'; ctx.fillRect(d.x - 15, top, 30, 2.5);
    ctx.fillStyle = '#60a5fa';
    ctx.fillRect(d.x - 15, top, 30 * Math.min(1, r.sh / 120), 2.5);
  }
  ctx.font = (r.id === me.id ? 'bold ' : '') + '11px system-ui';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(3,6,16,.9)';
  ctx.strokeText(r.n, d.x, top - 3);
  ctx.fillStyle = r.id === me.id ? '#fff' : '#d1d5db';
  ctx.fillText(r.n, d.x, top - 3);
  if (r.id === me.id) {
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(d.x, d.y, R + 5, 0, Math.PI * 2); ctx.stroke();
  }
}

function draw() {
  requestAnimationFrame(draw);
  const now = performance.now();
  const raw = (now - lastFrame) / 1000;
  const dt = Math.min(0.1, raw);
  lastFrame = now;
  if (!D || !grid) return;
  const C = D.CELL, T = D.T, W = cv.width, H = cv.height;

  if (terrainDirty) drawTerrain();
  VFX.update(dt, raw);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const sh = VFX.shakeOffset();
  ctx.save();
  if (sh) ctx.translate(sh.x, sh.y);
  ctx.drawImage(terrain, 0, 0);

  /* every start and end breathes, so they are findable on a big map and it is
     obvious when a room has several of them */
  for (let i = 0; i < grid.tiles.length; i++) {
    const t = grid.tiles[i];
    if (t !== T.START && t !== T.END) continue;
    const color = t === T.START ? '#4ade80' : '#fbbf24';
    const x = (i % grid.gw) * C, y = Math.floor(i / grid.gw) * C;
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.25 * Math.sin(now / 400);
    ctx.strokeStyle = color; ctx.lineWidth = 3;
    ctx.strokeRect(x + 2, y + 2, C - 4, C - 4);
    ctx.restore();
    ctx.fillStyle = '#0b1020'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(t === T.START ? 'START' : 'END', x + C / 2, y + C / 2 + 4);
  }

  if (S) {
    for (const tw of towers) drawTower(tw, now);

    /* meteors telegraph where they will land */
    for (const m of S.mt) {
      const total = D.MM_ABILITIES.meteor.delay * 1000;
      const f = 1 - Math.min(1, m.in / total);
      ctx.save();
      ctx.fillStyle = 'rgba(249,115,22,.18)';
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(249,115,22,.95)'; ctx.lineWidth = 2 + f * 2;
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r * (1 - f * 0.75) + 3, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(249,115,22,.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(m.x - m.r, m.y); ctx.lineTo(m.x + m.r, m.y);
      ctx.moveTo(m.x, m.y - m.r); ctx.lineTo(m.x, m.y + m.r); ctx.stroke();
      ctx.restore();
    }

    for (const d of S.dc) {
      ctx.save();
      ctx.globalAlpha = 0.45 + 0.12 * Math.sin(now / 180);
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath(); ctx.arc(d.x, d.y, D.RUNNER_R, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#0b1020'; ctx.fillRect(d.x - 13, d.y - 17, 26, 3);
      ctx.fillStyle = '#fbbf24'; ctx.fillRect(d.x - 13, d.y - 17, 26 * Math.max(0, d.hp / d.mh), 3);
      ctx.fillStyle = 'rgba(251,191,36,.9)'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('decoy', d.x, d.y + 24);
    }

    for (const p of S.pj) {
      if (p.k === 'lob') {
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
      }
      if (Math.random() < 0.5) {
        VFX.part({ x: p.x, y: p.y - (p.h || 0), vx: 0, vy: 0, life: 0.22, size: 2.2, c: p.c, drag: 1 });
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = p.c;
      if (p.k === 'bolt') {
        /* a tracer, pointed the way it is travelling, so you can judge whether
           it is going to reach you */
        ctx.translate(p.x, p.y); ctx.rotate(p.a || 0);
        ctx.beginPath(); ctx.ellipse(0, 0, 8, 2.6, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(2.5, 0, 3.2, 1.3, 0, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y - (p.h || 0), 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    const seen = new Set();
    for (const r of S.r) {
      seen.add(r.id);
      let d = disp.get(r.id);
      if (!d) { d = { x: r.x, y: r.y }; disp.set(r.id, d); }
      if (Math.hypot(r.x - d.x, r.y - d.y) > 150 || r.d) { d.x = r.x; d.y = r.y; }
      else { const k = 1 - Math.exp(-dt * 18); d.x += (r.x - d.x) * k; d.y += (r.y - d.y) * k; }
      drawRunner(r, d, now, dt);
    }
    for (const id of disp.keys()) if (!seen.has(id)) disp.delete(id);
  }

  VFX.draw(ctx);

  /* the rectangle the bulk actions are aimed at */
  if (isMM() && area) {
    const x0 = Math.min(area.x0, area.x1) * C, y0 = Math.min(area.y0, area.y1) * C;
    const w = (Math.abs(area.x1 - area.x0) + 1) * C, h = (Math.abs(area.y1 - area.y0) + 1) * C;
    ctx.save();
    ctx.fillStyle = 'rgba(125,211,252,.08)';
    ctx.fillRect(x0, y0, w, h);
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -(now / 45) % 12;
    ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 1, y0 + 1, w - 2, h - 2);
    ctx.restore();
  }

  /* the mastermind's placement preview */
  if (isMM() && hover && inGrid(hover) && S) {
    const hx = hover.x * C, hy = hover.y * C;
    if (toolKind === 'tower') {
      const def = defOf(toolType), t = grid.tiles[hover.y * grid.gw + hover.x];
      const room = def.onPath ? (t === T.PATH || t === T.STEEP) : t === T.EMPTY;
      const ok = !towerAt(hover.x, hover.y) && room && S.gold >= RULES.buildCost(SET, def);
      ctx.fillStyle = bucket ? 'rgba(251,191,36,.35)' : ok ? 'rgba(125,211,252,.3)' : 'rgba(248,113,113,.35)';
      ctx.fillRect(hx, hy, C, C);
      if (bucket) {
        /* how many of these the current gold would buy */
        const n = Math.floor(S.gold / Math.max(1, RULES.buildCost(SET, def)));
        ctx.fillStyle = '#fbbf24'; ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(3,6,16,.85)';
        ctx.strokeText('FILL x' + n, hx + C / 2, hy - 5);
        ctx.fillText('FILL x' + n, hx + C / 2, hy - 5);
      }
      const range = RULES.range(def, {});
      if (range) {
        ctx.strokeStyle = ok ? 'rgba(255,255,255,.55)' : 'rgba(248,113,113,.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(hx + C / 2, hy + C / 2, range, 0, Math.PI * 2); ctx.stroke();
        if (def.minRange) { ctx.beginPath(); ctx.arc(hx + C / 2, hy + C / 2, def.minRange, 0, Math.PI * 2); ctx.stroke(); }
      }
    } else if (toolKind === 'aim') {
      const ab = D.MM_ABILITIES[toolType];
      ctx.strokeStyle = 'rgba(249,115,22,.95)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hover.px, hover.py, ab.radius, 0, Math.PI * 2); ctx.stroke();
      if (toolType === 'barrage') {
        ctx.strokeStyle = 'rgba(249,115,22,.4)';
        ctx.beginPath(); ctx.arc(hover.px, hover.py, 90 + ab.radius, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (toolKind) {
      ctx.fillStyle = S.edit ? 'rgba(255,255,255,.22)' : 'rgba(248,113,113,.3)';
      ctx.fillRect(hx, hy, C, C);
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1;
      ctx.strokeRect(hx + 0.5, hy + 0.5, C - 1, C - 1);
    }
  }
  ctx.restore();

  VFX.drawFlash(ctx, W, H);
  drawHud(now, W, H);
}

function drawHud(now, W, H) {
  if (!S) { banner('Connecting...', '#fde68a', W, H); return; }
  /* Several of these can be true at once -- frozen, blacked out and holding
     the END is a real moment -- so they stack upwards instead of being drawn
     on top of one another. */
  let dy = -44;
  const stack = (text, color) => { banner(text, color, W, H, dy); dy -= 38; };
  if (S.frz > 0) {
    ctx.fillStyle = 'rgba(147,197,253,.16)'; ctx.fillRect(0, 0, W, H);
    stack('FROZEN  ' + (S.frz / 1000).toFixed(1) + 's', '#bfdbfe');
  }
  if (S.bo > 0) {
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(0, 0, W, H);
    stack('BLACKOUT  ' + (S.bo / 1000).toFixed(1) + 's', '#fca5a5');
  }
  if (S.od > 0) stack('OVERDRIVE  ' + (S.od / 1000).toFixed(1) + 's', '#fdba74');

  if (S.win) {
    VFX.winFireworks(now);
    const runnersWin = S.win === 'runners';
    ctx.save();
    ctx.fillStyle = 'rgba(8,12,24,.7)'; ctx.fillRect(0, H / 2 - 70, W, 140);
    ctx.textAlign = 'center';
    ctx.font = 'bold 44px system-ui';
    ctx.fillStyle = runnersWin ? '#4ade80' : '#f87171';
    ctx.fillText(runnersWin ? 'RUNNERS WIN' : 'MASTERMIND WINS', W / 2, H / 2 + 6);
    ctx.font = '16px system-ui'; ctx.fillStyle = '#e6e9f5';
    ctx.fillText('Runners ' + S.vpRun + '  ·  Mastermind ' + S.vpMM +
      '   —   next round in ' + Math.ceil(S.winIn / 1000) + 's', W / 2, H / 2 + 38);
    ctx.restore();
    return;
  }
  if (S.edit) {
    banner(isMM() ? 'EDITING — press GO LIVE once every START reaches an END'
                  : 'The Mastermind is rebuilding the track...', '#fca5a5', W, H);
  } else if (!S.mm) {
    banner('No Mastermind! Someone take the seat.', '#fde68a', W, H);
  } else if (me.role === 'runner') {
    const r = myRunner();
    if (r && r.d) banner('You died. Respawning in ' + (r.rs / 1000).toFixed(1) + 's', '#fca5a5', W, H);
    else if (r && r.esc > 0) {
      stack('HOLD THE END — ' + ((r.en * (1 - r.esc)) / 1000).toFixed(1) + 's to escape', '#fbbf24');
    }
  }
  if (performance.now() - lastStateAt > 2000) banner('Waiting for the server...', '#fde68a', W, H, -40);
}

function banner(text, color, W, H, dy) {
  ctx.save();
  ctx.font = 'bold 20px system-ui'; ctx.textAlign = 'center';
  const w = ctx.measureText(text).width + 30;
  ctx.fillStyle = 'rgba(8,12,24,.82)';
  ctx.fillRect(W / 2 - w / 2, H - 50 + (dy || 0), w, 34);
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2, H - 26 + (dy || 0));
  ctx.restore();
}
requestAnimationFrame(draw);
