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
let twDyn = new Map();                     /* tower id -> {a,f,d,c,bx,by,bt} */
let lastStateAt = 0;
const disp = new Map();                    /* smoothed runner positions */

/* ------------------------------------------------------------- ui state */
let toolKind = null, toolType = null;      /* mastermind's current tool */
let selTower = null;                       /* "gx,gy" of the selected building */
let hover = null;
let painting = false, paintTile = null, lastPaint = null;
let showSettings = false;
const keys = {};
const el = {};                             /* cached sidebar nodes */
let panelSig = '';

/* transitions that make a noise or a flash the first frame they become true */
let prevEdit = null, prevFrz = 0, prevDead = false, prevSlow = false;
let prevMeteors = 0, prevWin = null, prevOd = 0, prevBo = 0, prevRoot = false;

function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function isMM() { return me && me.role === 'mm'; }
function myRunner() { return S && S.r.find(r => r.id === me.id); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function defOf(type) { return D.BUILD[type]; }
function towerAt(x, y) { return towers.find(t => t.gx === x && t.gy === y); }

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
      $('lobby').style.display = 'none'; $('game').style.display = 'flex';
      $('roomCode').textContent = m.room;
      history.replaceState(null, '', '?room=' + m.room);
      toolKind = null; selTower = null; VFX.reset();
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
    case 'g': {
      const resized = !grid || grid.gw !== m.gw || grid.gh !== m.gh;
      grid = m;
      if (resized) fitCanvas();
      terrainDirty = true;
      break;
    }
    case 'tw':
      towers = m.tw;
      panelSig = '';
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
    SFX.lowHp(!r.d && r.hp / r.mh < 0.3);
  } else { prevDead = false; prevSlow = false; prevRoot = false; SFX.lowHp(false); }

  let flaming = false;
  for (const tw of towers) {
    const d = twDyn.get(tw.id);
    if (d && d.f && !d.d && (tw.ty === 'flame' || tw.ty === 'laser' || tw.ty === 'saw')) { flaming = true; break; }
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
  panelSig = '';
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

/* ---------------------------------------------------------- mastermind side */
function buildMM() {
  const edit = grid && grid.edit;
  side.appendChild(row(
    '<button id="modeBtn" class="big"></button>' +
    '<div class="hint" id="modeHint"></div>' +
    '<button id="setToggle" style="width:100%;margin-top:8px">&#9881; Game setup</button>' +
    '<div id="setPanel" style="display:none"></div>' +
    '<h3>Track tools</h3><div class="grid2" id="trackTools">' +
      '<button data-tool="path">Path brush</button>' +
      '<button data-tool="erase">Eraser</button>' +
      '<button data-tool="start">Set START</button>' +
      '<button data-tool="end">Set END</button>' +
      '<button data-preset="snake">Preset: Snake</button>' +
      '<button data-preset="zigzag">Preset: Zigzag</button>' +
      '<button data-preset="spiral">Preset: Spiral</button>' +
      '<button data-preset="blank">Clear track</button>' +
    '</div>' +
    '<h3>Towers <span class="muted">(on empty ground)</span></h3><div class="list" id="towerList"></div>' +
    '<h3>Traps <span class="muted">(on the path)</span></h3><div class="list" id="trapList"></div>' +
    '<div id="towerPanel" style="display:none"></div>' +
    '<h3>Abilities</h3><div class="list" id="abList"></div>' +
    '<h3>Danger zone</h3><div class="grid2">' +
      '<button id="clearTowers">Sell everything</button>' +
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
  el.trackTools = [...side.querySelectorAll('[data-tool]')];
  for (const b of el.trackTools) b.onclick = () => setTool(b.dataset.tool);
  for (const b of side.querySelectorAll('[data-preset]')) b.onclick = () => send({ t: 'preset', name: b.dataset.preset });

  el.buildBtns = [];
  const mk = (type, host) => {
    const def = defOf(type);
    const b = document.createElement('button');
    b.dataset.type = type;
    b.innerHTML = '<span class="sw" style="background:' + def.color + '"></span>' +
      '<span class="name">' + def.name + '<small>' + def.desc + '</small></span>' +
      '<span class="gold cost"></span>';
    b.onclick = () => setTool('tower', type);
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
    b.innerHTML = '<span class="name">' + ab.name + '<small>' + ab.desc + '</small></span><span class="gold cost"></span>';
    b.onclick = () => { if (ab.aim) setTool('aim', a); else send({ t: 'ability', a }); };
    $('abList').appendChild(b);
    el.abBtns.push(b);
  }
  $('clearTowers').onclick = () => { if (confirm('Sell every tower and trap?')) send({ t: 'clearTowers' }); };
  $('resetVp').onclick = () => { if (confirm('Reset both victory point scores?')) send({ t: 'resetVp' }); };
  el.towerPanel = $('towerPanel');
}

/* Sliders are generated from the server's settings table, so the two can never
   describe different ranges. */
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
    d.innerHTML = '<div class="top"><span>' + s.label + '</span><span class="val"></span></div>';
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = s.min; inp.max = s.max; inp.step = s.step;
    inp.value = SET[k];
    d.appendChild(inp);
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
}
function syncSettings() {
  for (const k in el.setRows) {
    const r = el.setRows[k];
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
    '<div id="shWrap" style="margin-top:4px;display:none">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px"><span class="muted">Shield</span>' +
      '<span id="shTxt"></span></div><div class="bar"><i id="shBar" style="background:#60a5fa"></i></div></div>' +
    '<div style="margin-top:8px">Upgrade points: <span class="gold" id="ptsTxt">0</span>' +
      '<span class="muted" id="lapTxt"></span></div>' +
    '<div class="hint" id="rewardHint"></div>' +
    '<h3>Buy abilities</h3><div class="list" id="upAbil"></div>' +
    '<h3>Buy upgrades</h3><div class="list" id="upPass"></div>' +
    '<h3>Controls</h3><div class="hint"><span class="kbd">W</span><span class="kbd">A</span>' +
    '<span class="kbd">S</span><span class="kbd">D</span> or arrows to move. Abilities live in the bar under ' +
    'the board: click a slot or press its key. Levels never cap; the cost just climbs.</div>'
  ));
  el.hpTxt = $('hpTxt'); el.hpBar = $('hpBar'); el.ptsTxt = $('ptsTxt'); el.lapTxt = $('lapTxt');
  el.shWrap = $('shWrap'); el.shTxt = $('shTxt'); el.shBar = $('shBar');
  el.rewardHint = $('rewardHint');
  el.upBtns = [];
  for (const k in D.UPGRADES) {
    const u = D.UPGRADES[k];
    const b = document.createElement('button');
    b.dataset.up = k;
    b.innerHTML = '<span class="name">' + u.name + ' <span class="lv muted"></span>' +
      (u.key ? ' <span class="kbd">' + u.key + '</span>' : '') +
      '<small>' + u.desc + '</small></span><span class="gold cost"></span>';
    b.onclick = () => send({ t: 'upgrade', key: k });
    $(u.kind === 'ability' ? 'upAbil' : 'upPass').appendChild(b);
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
    el.score.innerHTML =
      '<tr><th>Runner</th><th>Fin</th><th>Died</th><th>Lv</th><th>Pts</th></tr>' +
      rows.map(r => {
        let lv = 0; for (const k in r.up) lv += r.up[k];
        return '<tr><td>' + (r.id === me.id ? '<b>' + esc(r.n) + '</b>' : esc(r.n)) + '</td><td>' +
          r.fin + '</td><td>' + r.dth + '</td><td>' + lv + '</td><td>' + r.pt + '</td></tr>';
      }).join('') +
      '<tr><td colspan="5" class="muted">Mastermind: ' +
      (S.mm ? esc(S.mm.n) : '<span class="warn">nobody — seat open</span>') + '</td></tr>';
  }
  if (isMM()) updateMM(); else updateRunner();
  updateHud();
}

function updateMM() {
  $('statPill').innerHTML = 'Gold <span class="gold">' + S.gold + '</span>';
  if (el.modeBtn) {
    el.modeBtn.textContent = S.edit ? '▶ GO LIVE' : '✎ EDIT TRACK';
    el.modeHint.textContent = S.edit
      ? 'Runners wait at the start while you edit. Go live once a path joins START to END.'
      : 'Build any time. Editing the track parks the runners at the start.';
  }
  for (const b of el.trackTools || []) {
    b.disabled = !S.edit;
    b.classList.toggle('sel', toolKind === b.dataset.tool);
  }
  for (const b of side.querySelectorAll('[data-preset]')) b.disabled = !S.edit;
  for (const b of el.buildBtns || []) {
    const type = b.dataset.type, cost = RULES.buildCost(SET, defOf(type));
    b.querySelector('.cost').textContent = cost;
    b.disabled = S.gold < cost;
    b.classList.toggle('sel', toolKind === 'tower' && toolType === type);
  }
  for (const b of el.abBtns || []) {
    const a = b.dataset.ab, ab = D.MM_ABILITIES[a], cd = S.mmCd[a];
    b.disabled = S.edit || !!S.win || cd > 0 || S.gold < ab.cost;
    b.classList.toggle('sel', toolKind === 'aim' && toolType === a);
    b.querySelector('.cost').textContent = cd > 0 ? (cd / 1000).toFixed(1) + 's' : ab.cost;
  }
  updateTowerPanel();
}

function updateTowerPanel() {
  const panel = el.towerPanel;
  if (!panel) return;
  const tw = selTower && towers.find(t => t.gx + ',' + t.gy === selTower);
  if (!tw) { selTower = null; panel.style.display = 'none'; panelSig = ''; return; }
  const def = defOf(tw.ty);
  const dyn = twDyn.get(tw.id) || {};
  const sig = tw.id + '|' + JSON.stringify(tw.up) + '|' + S.gold + '|' + (dyn.d || 0) + '|' + tw.ty;
  if (sig === panelSig) return;
  panelSig = sig;
  panel.style.display = '';
  /* A building has no level: it has a shape, and a count of upgrades until the
     next one. */
  const form = RULES.form(tw.up), left = RULES.toNextForm(tw.up);
  const nextName = form < RULES.MAX_FORM ? def.forms[form + 1] : null;
  let html = '<b><span class="sw" style="background:' + def.color + '"></span> ' +
    esc(RULES.formName(def, tw.up)) + '</b>' +
    (dyn.d ? ' <span class="warn">EMP&apos;d</span>' : '') +
    '<div class="hint">' + esc(def.name) + ' · form ' + (form + 1) + ' of ' + (RULES.MAX_FORM + 1) + ' · ' +
    (nextName ? left + ' more upgrade' + (left === 1 ? '' : 's') + ' &rarr; <b>' + esc(nextName) + '</b>'
              : '<b class="gold">final form</b>') + '</div>' +
    '<div class="hint">' + RULES.statLine(def, tw.up) + '</div>';
  const cost = RULES.trackCost(SET, def, RULES.upgrades(tw.up));
  for (const tr of def.tracks) {
    html += '<div class="trk"><button data-trk="' + tr + '"' + (S.gold < cost ? ' disabled' : '') + '>' +
      D.TRACKS[tr].name + ' +' + ((tw.up[tr] || 0) + 1) + '</button>' +
      '<span class="gold">' + cost + '</span></div>';
  }
  if (!def.tracks.length) html += '<div class="hint">No upgrades for this one.</div>';
  html += '<div class="trk"><button id="sellBtn">Sell</button>' +
    '<span class="gold">+' + RULES.sellValue(tw.sp) + '</span></div>';
  panel.innerHTML = html;
  for (const b of panel.querySelectorAll('[data-trk]')) {
    b.onclick = () => send({ t: 'tup', x: tw.gx, y: tw.gy, track: b.dataset.trk });
  }
  $('sellBtn').onclick = () => { send({ t: 'sell', x: tw.gx, y: tw.gy }); selTower = null; };
}

function updateRunner() {
  const r = myRunner();
  if (!r || !el.hpTxt) return;
  $('statPill').innerHTML = 'Finishes <b>' + r.fin + '</b> &nbsp; Points <span class="gold">' + r.pt + '</span>';
  el.hpTxt.textContent = Math.ceil(r.hp) + ' / ' + r.mh;
  el.hpBar.style.width = (100 * r.hp / r.mh) + '%';
  el.hpBar.style.background = r.hp / r.mh > 0.4 ? 'var(--good)' : 'var(--warn)';
  el.shWrap.style.display = r.sh > 0 ? '' : 'none';
  if (r.sh > 0) { el.shTxt.textContent = r.sh; el.shBar.style.width = Math.min(100, r.sh / 2) + '%'; }
  el.ptsTxt.textContent = r.pt;
  el.lapTxt.textContent = r.lap ? '  ·  ' + r.lap + ' lap' + (r.lap === 1 ? '' : 's') + ' banked' : '';
  el.rewardHint.innerHTML = 'Each finish: <b class="good">+' + SET.vpFinish + ' VP</b>, +' +
    (SET.ptsFinish + r.up.scholar) + ' points, a full heal, a free shield, and a permanent +' +
    SET.lapBonus + '% speed and +' + SET.lapBonus + ' max HP. Dying gives the Mastermind ' +
    SET.vpKill + ' VP and you ' + SET.ptsDeath + '.';

  for (const b of el.upBtns || []) {
    const k = b.dataset.up, lv = r.up[k], u = D.UPGRADES[k];
    const cost = RULES.upgradeCost(SET, u, lv);
    b.querySelector('.lv').textContent = 'lv ' + lv;
    b.querySelector('.cost').textContent = cost + ' pt';
    b.disabled = r.pt < cost;
  }
}

function setTool(kind, type) {
  if (toolKind === kind && toolType === (type || null)) { toolKind = null; toolType = null; }
  else { toolKind = kind; toolType = type || null; }
  if (toolKind) selTower = null;
  panelSig = '';
  updateSide();
}

/* ================================================================ the HUD */
/* One row of slots under the board, the same for both roles: icon, key, cost,
   and a dark wedge that sweeps away as the cooldown runs down. The Mastermind
   sees their five abilities and what they cost; a runner sees all eight of
   theirs, greyed out until bought, with the price to unlock on the slot. */
const hud = $('hud');
let hudSlots = [];

function buildHud() {
  hud.innerHTML = '';
  hudSlots = [];
  if (!me || !D) return;
  const keys = isMM() ? Object.keys(D.MM_ABILITIES) : D.ABILITY_KEYS;
  for (const k of keys) {
    const def = isMM() ? D.MM_ABILITIES[k] : D.UPGRADES[k];
    const slot = document.createElement('div');
    slot.className = 'slot';
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
      k, def, el: slot,
      key: slot.querySelector('.key'), cost: slot.querySelector('.cost'),
      sweep: slot.querySelector('.sweep'), secs: slot.querySelector('.secs'),
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
    if (ab.aim) setTool('aim', k);
    else send({ t: 'ability', a: k });
  } else {
    const r = myRunner();
    if (!r) return;
    if (!r.up[k]) send({ t: 'upgrade', key: k });   /* the slot shows the price */
    else send({ t: 'act', a: k });
  }
}

function updateHud() {
  if (!S || !SET || !hudSlots.length) return;
  const r = myRunner();
  for (const s of hudSlots) {
    if (isMM()) {
      const ab = D.MM_ABILITIES[s.k], cd = S.mmCd[s.k] || 0;
      const broke = S.gold < ab.cost, blocked = S.edit || !!S.win;
      s.key.textContent = '';
      s.cost.textContent = ab.cost;
      s.cost.style.color = broke ? 'var(--warn)' : 'var(--gold)';
      s.sweep.style.setProperty('--deg', (cd > 0 ? 360 * cd / (ab.cd * 1000) : 0) + 'deg');
      s.secs.textContent = cd > 0 ? Math.ceil(cd / 1000) : '';
      s.el.classList.toggle('ready', cd <= 0 && !broke && !blocked);
      s.el.classList.toggle('broke', broke || blocked);
      s.el.classList.toggle('armed', toolKind === 'aim' && toolType === s.k);
    } else if (r) {
      const u = D.UPGRADES[s.k], lv = r.up[s.k], cd = r.cd[s.k] || 0;
      const locked = !lv;
      s.key.textContent = u.key === 'Space' ? 'SPC' : u.key;
      if (locked) {
        const cost = RULES.upgradeCost(SET, u, 0);
        s.cost.textContent = cost + 'p';
        s.cost.style.color = r.pt >= cost ? 'var(--good)' : 'var(--warn)';
        s.secs.textContent = '';
        s.sweep.style.setProperty('--deg', '0deg');
      } else {
        const full = RULES.ability[s.k](lv).cd * RULES.hasteMul(r.up);
        s.cost.textContent = 'L' + lv;
        s.cost.style.color = 'var(--muted)';
        s.sweep.style.setProperty('--deg', (cd > 0 ? 360 * Math.min(1, cd / full) : 0) + 'deg');
        s.secs.textContent = cd > 0 ? (cd >= 1000 ? Math.ceil(cd / 1000) : (cd / 1000).toFixed(1)) : '';
      }
      s.el.classList.toggle('locked', locked);
      s.el.classList.toggle('ready', !locked && cd <= 0 && !S.edit && !S.win && !S.bo && !r.d);
      s.el.classList.toggle('broke', false);
    }
  }
  const note = $('hudNote');
  if (!note) return;
  if (isMM()) {
    note.innerHTML = 'Gold <b class="gold">' + S.gold + '</b>' +
      (S.edit ? ' <span class="warn">· editing</span>' : '');
  } else if (r) {
    note.innerHTML = 'Points <b class="gold">' + r.pt + '</b>' +
      (S.bo > 0 ? ' <b class="warn">· BLACKOUT</b>' : '') +
      (r.d ? ' <b class="warn">· down</b>' : '');
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

cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('mousemove', e => {
  if (!D) return;
  hover = cellFromEvent(e);
  if (painting && isMM() && inGrid(hover)) paintLine(hover);
});
cv.addEventListener('mouseleave', () => { hover = null; painting = false; lastPaint = null; });

/* Paint every cell between the last mouse position and this one, so a fast drag
   leaves an unbroken track instead of a dotted line. */
function paintLine(c) {
  if (!lastPaint) lastPaint = c;
  let x0 = lastPaint.x, y0 = lastPaint.y;
  const x1 = c.x, y1 = c.y;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (let guard = 0; guard < 300; guard++) {
    send({ t: 'paint', x: x0, y: y0, tile: paintTile });
    SFX.play('paint');
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  lastPaint = { x: x1, y: y1 };
}

cv.addEventListener('mousedown', e => {
  if (!D || !isMM() || !S) return;
  const c = cellFromEvent(e);
  if (!inGrid(c)) return;
  if (e.button === 2) {
    if (towerAt(c.x, c.y)) { send({ t: 'sell', x: c.x, y: c.y }); if (selTower === c.x + ',' + c.y) selTower = null; }
    return;
  }
  const T = D.T;
  if (toolKind === 'path' || toolKind === 'erase') {
    if (!S.edit) return;
    painting = true; lastPaint = null;
    paintTile = toolKind === 'path' ? T.PATH : T.EMPTY;
    paintLine(c);
  } else if (toolKind === 'start' || toolKind === 'end') {
    if (!S.edit) return;
    send({ t: 'paint', x: c.x, y: c.y, tile: toolKind === 'start' ? T.START : T.END });
  } else if (toolKind === 'tower') {
    if (towerAt(c.x, c.y)) { selTower = c.x + ',' + c.y; toolKind = null; toolType = null; updateSide(); return; }
    send({ t: 'tower', type: toolType, x: c.x, y: c.y });
  } else if (toolKind === 'aim') {
    send({ t: 'ability', a: toolType, x: c.px, y: c.py });
    toolKind = null; toolType = null; updateSide();
  } else {
    selTower = towerAt(c.x, c.y) ? c.x + ',' + c.y : null;
    panelSig = '';
    updateSide();
  }
});
cv.addEventListener('mouseup', e => {
  if (painting && isMM() && D) { const c = cellFromEvent(e); if (inGrid(c)) paintLine(c); }
});
window.addEventListener('mouseup', () => { painting = false; lastPaint = null; });

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
    if (!Object.keys(KEY_TO_ABILITY).length) buildKeyMap();
    const ab = KEY_TO_ABILITY[e.code];
    if (ab) { send({ t: 'act', a: ab }); return; }
    keys[e.code] = true; sendInput();
  } else {
    const types = Object.keys(D.TOWERS).concat(Object.keys(D.TRAPS));
    if (e.code.startsWith('Digit')) {
      const i = +e.code.slice(5) - 1;
      if (types[i]) setTool('tower', types[i]);
    } else if (e.code === 'Escape') {
      toolKind = null; toolType = null; selTower = null; panelSig = ''; updateSide();
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
  for (let y = 0; y < grid.gh; y++) {
    for (let x = 0; x < grid.gw; x++) {
      const t = grid.tiles[y * grid.gw + x];
      if (t === T.EMPTY) g.fillStyle = (x + y) % 2 ? '#16281c' : '#1a2e21';
      else if (t === T.PATH) g.fillStyle = (x + y) % 2 ? '#c6b088' : '#cfba92';
      else if (t === T.START) g.fillStyle = '#22c55e';
      else g.fillStyle = '#eab308';
      g.fillRect(x * C, y * C, C, C);
      if (t === T.PATH) {
        g.fillStyle = 'rgba(120,90,50,.12)';
        for (let i = 0; i < 3; i++) {
          const hx = ((x * 37 + y * 17 + i * 53) % 31) + 4, hy = ((x * 11 + y * 29 + i * 19) % 31) + 4;
          g.fillRect(x * C + hx, y * C + hy, 3, 2);
        }
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
  if (dyn.c && tw.ty !== 'portal' && tw.ty !== 'snare') {
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.fillRect(tw.gx * C, tw.gy * C, C, C);
  }
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
  if ((r.ds || r.su) && Math.random() < 0.8) {
    VFX.part({ x: d.x, y: d.y, vx: 0, vy: 0, life: 0.3, size: R * 0.8,
      c: r.ds ? '#e2e8f0' : '#34d399', drag: 1 });
  }
  ctx.globalAlpha = r.gh ? 0.4 : 1;
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(d.x, d.y, R + 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = r.fr ? '#93c5fd' : col;
  ctx.beginPath(); ctx.arc(d.x, d.y, R, 0, Math.PI * 2); ctx.fill();
  /* eyes point where you are facing */
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(d.x + r.fx * 4 - r.fy * 4, d.y + r.fy * 4 + r.fx * 4, 2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(d.x + r.fx * 4 + r.fy * 4, d.y + r.fy * 4 - r.fx * 4, 2, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;

  if (r.sh > 0) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2;
    ctx.globalAlpha = 0.55 + 0.25 * Math.sin(now / 160);
    ctx.beginPath(); ctx.arc(d.x, d.y, R + 6, 0, Math.PI * 2); ctx.stroke();
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

  ctx.font = (r.id === me.id ? 'bold ' : '') + '11px system-ui';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(3,6,16,.9)';
  ctx.strokeText(r.n, d.x, d.y - 19);
  ctx.fillStyle = r.id === me.id ? '#fff' : '#d1d5db';
  ctx.fillText(r.n, d.x, d.y - 19);
  ctx.fillStyle = '#0b1020'; ctx.fillRect(d.x - 15, d.y - 17, 30, 4);
  ctx.fillStyle = r.hp / r.mh > 0.4 ? '#4ade80' : '#f87171';
  ctx.fillRect(d.x - 15, d.y - 17, 30 * Math.max(0, r.hp / r.mh), 4);
  if (r.sh > 0) {
    ctx.fillStyle = '#60a5fa';
    ctx.fillRect(d.x - 15, d.y - 21, 30 * Math.min(1, r.sh / 120), 2.5);
  }
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

  /* start and end breathe so they are findable on a big map */
  const s = grid.tiles.indexOf(T.START), e = grid.tiles.indexOf(T.END);
  for (const [i, color, label] of [[s, '#4ade80', 'START'], [e, '#fbbf24', 'END']]) {
    if (i < 0) continue;
    const x = (i % grid.gw) * C, y = Math.floor(i / grid.gw) * C;
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.25 * Math.sin(now / 400);
    ctx.strokeStyle = color; ctx.lineWidth = 3;
    ctx.strokeRect(x + 2, y + 2, C - 4, C - 4);
    ctx.restore();
    ctx.fillStyle = '#0b1020'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(label, x + C / 2, y + C / 2 + 4);
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

  /* the mastermind's placement preview */
  if (isMM() && hover && inGrid(hover) && S) {
    const hx = hover.x * C, hy = hover.y * C;
    if (toolKind === 'tower') {
      const def = defOf(toolType), t = grid.tiles[hover.y * grid.gw + hover.x];
      const ok = !towerAt(hover.x, hover.y) && (def.onPath ? t === T.PATH : t === T.EMPTY) &&
                 S.gold >= RULES.buildCost(SET, def);
      ctx.fillStyle = ok ? 'rgba(125,211,252,.3)' : 'rgba(248,113,113,.35)';
      ctx.fillRect(hx, hy, C, C);
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
  if (S.frz > 0) {
    ctx.fillStyle = 'rgba(147,197,253,.16)'; ctx.fillRect(0, 0, W, H);
    banner('FROZEN  ' + (S.frz / 1000).toFixed(1) + 's', '#bfdbfe', W, H, -44);
  }
  if (S.bo > 0) {
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(0, 0, W, H);
    banner('BLACKOUT  ' + (S.bo / 1000).toFixed(1) + 's', '#fca5a5', W, H, -44);
  }
  if (S.od > 0) banner('OVERDRIVE  ' + (S.od / 1000).toFixed(1) + 's', '#fdba74', W, H, -82);

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
    banner(isMM() ? 'EDITING — press GO LIVE when the track connects'
                  : 'The Mastermind is rebuilding the track...', '#fca5a5', W, H);
  } else if (!S.mm) {
    banner('No Mastermind! Someone take the seat.', '#fde68a', W, H);
  } else if (me.role === 'runner') {
    const r = myRunner();
    if (r && r.d) banner('You died. Respawning in ' + (r.rs / 1000).toFixed(1) + 's', '#fca5a5', W, H);
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
