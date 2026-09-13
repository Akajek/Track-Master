/* TRACK MASTER -- visual effects.
 *
 * A small particle / ring / beam / floating-text engine. Everything is drawn on
 * the same canvas as the game, after the board and before the HUD. Glowing bits
 * are drawn with additive blending, which is what makes lasers and sparks read
 * as light rather than as paint.
 *
 * VFX.event(e) turns one server event into a picture; VFX.update(dt) ages
 * everything; VFX.draw(ctx) paints it. The particle count is capped so a very
 * busy fight degrades by dropping new particles instead of by dropping frames.
 */
'use strict';
const VFX = (() => {
  const MAX_PARTS = 1400, MAX_RINGS = 220, MAX_TEXTS = 120, MAX_BEAMS = 220, MAX_GLYPHS = 40;
  const parts = [], rings = [], texts = [], beams = [], glyphs = [];
  /* Every list is capped: a busy fight should degrade by dropping the oldest
     effect, never by eating memory or dropping frames. */
  const capped = (arr, max) => { while (arr.length > max) arr.shift(); return arr; };
  let shakeMag = 0, shakeT = 0, flashA = 0, flashC = '#fff';
  let boardW = 960, boardH = 640;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[(Math.random() * arr.length) | 0];

  function setBoard(w, h) { boardW = w; boardH = h; }
  function reset() { parts.length = 0; rings.length = 0; texts.length = 0; beams.length = 0; glyphs.length = 0; shakeMag = 0; flashA = 0; }

  /* ------------------------------------------------------------ spawners */
  function part(o) {
    if (parts.length >= MAX_PARTS) return;
    parts.push({
      x: o.x, y: o.y, vx: o.vx || 0, vy: o.vy || 0,
      life: 0, max: o.life || 0.6, size: o.size || 3, c: o.c || '#fff',
      grav: o.grav || 0, drag: o.drag === undefined ? 0.92 : o.drag,
      glow: o.glow !== false, shape: o.shape || 'dot',
      rot: o.rot || 0, spin: o.spin || 0, fade: o.fade || 1, z: o.z || 0,
    });
  }
  /* A cone or full circle of particles. */
  function burst(x, y, o) {
    o = o || {};
    const n = o.n || 12, a0 = o.a0 === undefined ? 0 : o.a0, a1 = o.a1 === undefined ? Math.PI * 2 : o.a1;
    for (let i = 0; i < n; i++) {
      const a = rnd(a0, a1), s = rnd(o.spd0 || 40, o.spd1 || 200);
      part({
        x: x + rnd(-2, 2), y: y + rnd(-2, 2), vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rnd(o.life0 || 0.25, o.life1 || 0.7), size: rnd(o.size0 || 1.5, o.size1 || 4),
        c: o.c ? (Array.isArray(o.c) ? pick(o.c) : o.c) : '#fff',
        grav: o.grav || 0, drag: o.drag, glow: o.glow, shape: o.shape, spin: rnd(-8, 8), z: o.z,
      });
    }
  }
  function ring(x, y, o) {
    o = o || {};
    rings.push({
      x, y, r0: o.r0 || 0, r1: o.r1 || 60, life: 0, max: o.life || 0.45,
      c: o.c || '#fff', w: o.w || 3, glow: o.glow !== false, ease: o.ease || 'out', z: o.z || 0,
    });
    capped(rings, MAX_RINGS);
  }
  function text(x, y, str, o) {
    o = o || {};
    texts.push({
      x, y, s: String(str), life: 0, max: o.life || 0.9, c: o.c || '#fff',
      size: o.size || 12, vy: o.vy === undefined ? -26 : o.vy, vx: o.vx || 0,
      bold: o.bold !== false, z: o.z || 0,
    });
    capped(texts, MAX_TEXTS);
  }
  function beam(x1, y1, x2, y2, o) {
    o = o || {};
    beams.push({
      x1, y1, x2, y2, life: 0, max: o.life || 0.12, c: o.c || '#fff',
      w: o.w || 2, jag: o.jag || 0, glow: o.glow !== false, seed: Math.random() * 1000,
    });
    capped(beams, MAX_BEAMS);
  }
  /* A short-lived symbol drawn by a callback: shields, portals, crosshairs. */
  function glyph(x, y, kind, o) {
    o = o || {};
    glyphs.push({ x, y, kind, life: 0, max: o.life || 0.5, c: o.c || '#fff', r: o.r || 18, a: o.a || 0, id: o.id });
    capped(glyphs, MAX_GLYPHS);
  }
  function shake(mag) { shakeMag = Math.min(18, shakeMag + mag); shakeT = 1; }
  function flash(color, amount) { flashC = color; flashA = Math.min(0.6, flashA + amount); }

  /* --------------------------------------------------------- combo effects */
  function explosion(x, y, r, color) {
    ring(x, y, { r0: r * 0.2, r1: r * 1.15, life: 0.45, c: color, w: 5 });
    ring(x, y, { r0: 0, r1: r * 0.7, life: 0.25, c: '#fff', w: 2 });
    burst(x, y, { n: Math.min(34, 12 + r / 4), c: [color, '#fff7ed', '#fbbf24'], spd0: 60, spd1: 60 + r * 4,
      size0: 2, size1: 5, life0: 0.3, life1: 0.8, drag: 0.9 });
    burst(x, y, { n: 8, c: ['#4b5563', '#6b7280'], spd0: 20, spd1: 70, size0: 5, size1: 11,
      life0: 0.5, life1: 1.1, drag: 0.95, glow: false, shape: 'smoke' });
    burst(x, y, { n: 6, c: ['#78350f', '#92400e'], spd0: 80, spd1: 240, size0: 2, size1: 4,
      life0: 0.4, life1: 0.9, grav: 420, drag: 0.98, glow: false, shape: 'chip' });
    shake(Math.min(9, r / 9));
  }
  function muzzle(x, y, ang, color, power) {
    const p = power || 1;
    burst(x, y, { n: 4 + 3 * p, c: [color, '#fff'], a0: ang - 0.45, a1: ang + 0.45,
      spd0: 90 * p, spd1: 260 * p, size0: 1.2, size1: 3.2 * p, life0: 0.1, life1: 0.24 });
    ring(x + Math.cos(ang) * 10, y + Math.sin(ang) * 10, { r0: 1, r1: 9 * p, life: 0.12, c: color, w: 2 });
  }
  function confetti(x, y, n) {
    const cols = ['#fbbf24', '#4ade80', '#7dd3fc', '#f472b6', '#a78bfa', '#fb923c'];
    for (let i = 0; i < (n || 40); i++) {
      const a = rnd(-Math.PI, 0), s = rnd(120, 340);
      part({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.9, 1.8),
        size: rnd(3, 6), c: pick(cols), grav: 520, drag: 0.985, glow: false, shape: 'chip', spin: rnd(-14, 14),
      });
    }
  }
  function lightning(x1, y1, x2, y2, color) {
    beam(x1, y1, x2, y2, { c: color, w: 2.5, jag: 12, life: 0.18 });
    beam(x1, y1, x2, y2, { c: '#fff', w: 1, jag: 12, life: 0.12 });
    burst(x2, y2, { n: 7, c: [color, '#fff'], spd0: 40, spd1: 150, size0: 1, size1: 2.5, life0: 0.12, life1: 0.3 });
  }

  /* ------------------------------------------------- server event -> visual */
  function event(e, myId) {
    switch (e.k) {
      case 'fire': {
        const col = e.ty === 'mortar' ? '#fdba74' : e.ty === 'sniper' ? '#f9a8d4' : '#7dd3fc';
        muzzle(e.x, e.y, e.a || 0, col, e.ty === 'mortar' ? 1.7 : e.ty === 'sniper' ? 1.4 : 1);
        if (e.ty === 'mortar') shake(1.2);
        break;
      }
      case 'shot':
        if (e.z) lightning(e.x1, e.y1, e.x2, e.y2, e.c);
        else {
          beam(e.x1, e.y1, e.x2, e.y2, { c: e.c, w: e.w, life: 0.14 });
          beam(e.x1, e.y1, e.x2, e.y2, { c: '#fff', w: 1, life: 0.09 });
          burst(e.x2, e.y2, { n: 8, c: [e.c, '#fff'], spd0: 50, spd1: 190, size0: 1, size1: 2.6, life0: 0.12, life1: 0.34 });
        }
        break;
      case 'pulse':
        ring(e.x, e.y, { r0: 6, r1: e.r, life: 0.4, c: e.c, w: 4 });
        ring(e.x, e.y, { r0: 2, r1: e.r * 0.6, life: 0.25, c: '#fff', w: 2 });
        burst(e.x, e.y, { n: 16, c: [e.c, '#fff'], spd0: 80, spd1: 260, size0: 1.5, size1: 3.4, life0: 0.2, life1: 0.5 });
        shake(1.5);
        break;
      case 'spark':
        burst(e.x, e.y, { n: 6, c: [e.c, '#fff'], spd0: 40, spd1: 150, size0: 1, size1: 2.4, life0: 0.1, life1: 0.3 });
        break;
      case 'boom': explosion(e.x, e.y, e.r, e.c); break;
      case 'fizzle':
        /* A shot that was dodged: it should be visible that it missed. */
        burst(e.x, e.y, { n: 4, c: [e.c, '#94a3b8'], spd0: 15, spd1: 60, size0: 1, size1: 2,
          life0: 0.15, life1: 0.35, drag: 0.88 });
        break;
      case 'hit':
        text(e.x + rnd(-9, 9), e.y - 14, '-' + e.a, { c: e.id === myId ? '#fca5a5' : '#e5e7eb', size: e.id === myId ? 14 : 11 });
        burst(e.x, e.y, { n: e.id === myId ? 9 : 4, c: ['#fecaca', '#f87171'], spd0: 30, spd1: 140, size0: 1, size1: 2.6, life0: 0.15, life1: 0.4 });
        if (e.id === myId) { shake(1.6); flash('#7f1d1d', 0.12); }
        break;
      case 'burn':
        burst(e.x, e.y, { n: 3, c: ['#fb923c', '#fbbf24'], spd0: 10, spd1: 60, size0: 1, size1: 2.4,
          life0: 0.25, life1: 0.5, grav: -60 });
        break;
      case 'absorb':
        text(e.x, e.y - 20, '-' + e.a, { c: '#93c5fd', size: 11 });
        ring(e.x, e.y, { r0: 14, r1: 20, life: 0.22, c: '#93c5fd', w: 2 });
        break;
      case 'shieldpop':
        ring(e.x, e.y, { r0: 18, r1: 34, life: 0.35, c: '#60a5fa', w: 3 });
        burst(e.x, e.y, { n: 14, c: ['#93c5fd', '#dbeafe'], spd0: 80, spd1: 220, size0: 1.5, size1: 3, life0: 0.2, life1: 0.5 });
        break;
      case 'shieldup':
        ring(e.x, e.y, { r0: 34, r1: 16, life: 0.3, c: '#60a5fa', w: 3, ease: 'in' });
        text(e.x, e.y - 26, '+' + e.a + ' shield', { c: '#93c5fd', size: 11 });
        break;
      case 'die':
        explosion(e.x, e.y, 46, '#f87171');
        burst(e.x, e.y, { n: 18, c: ['#ef4444', '#b91c1c'], spd0: 60, spd1: 250, size0: 2, size1: 4.5,
          life0: 0.4, life1: 0.9, grav: 300, drag: 0.97 });
        text(e.x, e.y - 34, e.n + ' down', { c: '#fca5a5', size: 15, life: 1.3 });
        if (e.id === myId) flash('#7f1d1d', 0.4);
        break;
      case 'fin':
        confetti(e.x, e.y, 55);
        ring(e.x, e.y, { r0: 4, r1: 90, life: 0.7, c: '#fbbf24', w: 4 });
        ring(e.x, e.y, { r0: 4, r1: 60, life: 0.5, c: '#fff', w: 2 });
        text(e.x, e.y - 38, e.n + ' FINISHED', { c: '#fbbf24', size: 17, life: 1.6 });
        shake(4);
        break;
      case 'lap':
        text(e.x, e.y - 54, 'lap ' + e.n + ' bonus!', { c: '#4ade80', size: 12, life: 1.4 });
        break;
      case 'vp':
        text(e.x, e.y - 68, '+' + e.n + ' VP', { c: e.team === 'mm' ? '#f87171' : '#4ade80', size: 16, life: 1.5, vy: -34 });
        break;
      case 'emp':
        ring(e.x, e.y, { r0: 6, r1: e.r, life: 0.5, c: '#facc15', w: 4 });
        ring(e.x, e.y, { r0: 6, r1: e.r * 0.7, life: 0.32, c: '#fff', w: 2 });
        for (let i = 0; i < 10; i++) {
          const a = rnd(0, Math.PI * 2);
          lightning(e.x, e.y, e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r, '#facc15');
        }
        shake(3);
        break;
      case 'dash':
        burst(e.x, e.y, { n: 14, c: ['#fff', '#cbd5e1'], a0: Math.atan2(-e.fy, -e.fx) - 0.6, a1: Math.atan2(-e.fy, -e.fx) + 0.6,
          spd0: 80, spd1: 260, size0: 1.5, size1: 3.4, life0: 0.15, life1: 0.4 });
        ring(e.x, e.y, { r0: 4, r1: 26, life: 0.25, c: '#fff', w: 2 });
        break;
      case 'blink':
        ring(e.x1, e.y1, { r0: 20, r1: 2, life: 0.3, c: '#a78bfa', w: 3, ease: 'in' });
        ring(e.x2, e.y2, { r0: 2, r1: 24, life: 0.3, c: '#a78bfa', w: 3 });
        beam(e.x1, e.y1, e.x2, e.y2, { c: '#c4b5fd', w: 5, life: 0.22 });
        burst(e.x2, e.y2, { n: 14, c: ['#c4b5fd', '#fff'], spd0: 50, spd1: 190, size0: 1.5, size1: 3, life0: 0.2, life1: 0.5 });
        break;
      case 'ghost':
        ring(e.x, e.y, { r0: 6, r1: 30, life: 0.4, c: '#e9d5ff', w: 3 });
        break;
      case 'surge':
        ring(e.x, e.y, { r0: 4, r1: 34, life: 0.35, c: '#34d399', w: 3 });
        burst(e.x, e.y, { n: 16, c: ['#34d399', '#a7f3d0'], spd0: 60, spd1: 220, size0: 1.5, size1: 3.2, life0: 0.2, life1: 0.5 });
        break;
      case 'heal':
        text(e.x, e.y - 26, '+' + e.a, { c: '#4ade80', size: 14 });
        for (let i = 0; i < 12; i++) {
          part({ x: e.x + rnd(-14, 14), y: e.y + rnd(-6, 14), vx: rnd(-14, 14), vy: rnd(-70, -30),
            life: rnd(0.4, 0.8), size: rnd(2, 4), c: '#4ade80' });
        }
        break;
      case 'decoy':
        ring(e.x, e.y, { r0: 4, r1: 28, life: 0.35, c: '#fbbf24', w: 2 });
        break;
      case 'decoypop':
        burst(e.x, e.y, { n: 12, c: ['#fbbf24', '#fde68a'], spd0: 50, spd1: 170, size0: 1.5, size1: 3, life0: 0.2, life1: 0.45 });
        break;
      case 'snare':
        glyph(e.x, e.y, 'snare', { life: Math.max(0.4, e.d || 1), c: '#fcd34d', r: 20 });
        text(e.x, e.y - 30, 'ROOTED', { c: '#fcd34d', size: 12, life: 1 });
        burst(e.x, e.y, { n: 10, c: ['#fcd34d', '#fbbf24'], spd0: 20, spd1: 90, size0: 1.5, size1: 3, life0: 0.2, life1: 0.5 });
        break;
      case 'portal':
        glyph(e.x, e.y, 'portal', { life: 0.6, c: '#c084fc', r: 26 });
        burst(e.x, e.y, { n: 22, c: ['#c084fc', '#e9d5ff'], spd0: 40, spd1: 200, size0: 1.5, size1: 3.4, life0: 0.25, life1: 0.6 });
        text(e.x, e.y - 30, 'SENT BACK!', { c: '#c084fc', size: 14, life: 1.3 });
        shake(3);
        break;
      case 'portalout':
        ring(e.x, e.y, { r0: 30, r1: 4, life: 0.4, c: '#c084fc', w: 3, ease: 'in' });
        break;
      case 'spawn':
        ring(e.x, e.y, { r0: 28, r1: 6, life: 0.35, c: '#4ade80', w: 3, ease: 'in' });
        break;
      case 'build':
        ring(e.x, e.y, { r0: 2, r1: 26, life: 0.4, c: e.c || '#fbbf24', w: 3 });
        burst(e.x, e.y, { n: 14, c: [e.c || '#fbbf24', '#fff'], spd0: 40, spd1: 160, size0: 1.5, size1: 3,
          life0: 0.2, life1: 0.5, grav: 200 });
        break;
      case 'sell':
        burst(e.x, e.y, { n: 12, c: ['#fbbf24', '#fde68a'], spd0: 30, spd1: 130, size0: 2, size1: 4,
          life0: 0.3, life1: 0.6, grav: 260, shape: 'chip', glow: false });
        break;
      case 'levelup':
        ring(e.x, e.y, { r0: 26, r1: 6, life: 0.4, c: e.c || '#4ade80', w: 3, ease: 'in' });
        for (let i = 0; i < 10; i++) {
          part({ x: e.x + rnd(-12, 12), y: e.y + 10, vx: rnd(-16, 16), vy: rnd(-110, -60),
            life: rnd(0.4, 0.8), size: rnd(2, 3.6), c: e.c || '#4ade80' });
        }
        if (!e.tower) text(e.x, e.y - 30, 'LEVEL UP', { c: '#4ade80', size: 12, life: 1 });
        break;
      case 'morph':
        /* A shape change earns more than an upgrade sparkle. */
        ring(e.x, e.y, { r0: 60, r1: 8, life: 0.5, c: e.c || '#fbbf24', w: 4, ease: 'in' });
        ring(e.x, e.y, { r0: 4, r1: 52, life: 0.6, c: '#fff', w: 3 });
        ring(e.x, e.y, { r0: 4, r1: 76, life: 0.8, c: e.c || '#fbbf24', w: 2 });
        burst(e.x, e.y, { n: 30, c: [e.c || '#fbbf24', '#fff', '#fde68a'], spd0: 50, spd1: 240,
          size0: 1.5, size1: 4, life0: 0.35, life1: 0.9 });
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          beam(e.x, e.y, e.x + Math.cos(a) * 46, e.y + Math.sin(a) * 46, { c: '#fff', w: 2, life: 0.3 });
        }
        if (e.n) text(e.x, e.y - 34, e.n.toUpperCase(), { c: e.c || '#fbbf24', size: 15, life: 1.6, vy: -20 });
        shake(3);
        break;
      case 'win':
        flash(e.team === 'runners' ? '#065f46' : '#7f1d1d', 0.5);
        shake(10);
        break;
    }
  }

  /* Fireworks over the whole board while a win banner is up. */
  let fwAt = 0;
  function winFireworks(now) {
    if (now - fwAt < 260) return;
    fwAt = now;
    const x = rnd(60, boardW - 60), y = rnd(50, boardH * 0.6);
    const c = pick(['#fbbf24', '#4ade80', '#7dd3fc', '#f472b6', '#a78bfa']);
    ring(x, y, { r0: 2, r1: rnd(50, 90), life: 0.6, c, w: 3 });
    burst(x, y, { n: 26, c: [c, '#fff'], spd0: 60, spd1: 260, size0: 1.5, size1: 3.6,
      life0: 0.5, life1: 1.1, grav: 160, drag: 0.96 });
  }

  /* ------------------------------------------------------------- lifecycle */
  /* `raw` is the unclamped frame time. Browsers stop painting a tab that is not
     on screen, so effects queue up unaged while you are looking at something
     else. When frames resume after a long gap, everything waiting is stale:
     drop it instead of replaying a minute of explosions at once. */
  function update(dt, raw) {
    if (raw !== undefined && raw > 0.3) { reset(); return; }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life += dt;
      if (p.life >= p.max) { parts.splice(i, 1); continue; }
      p.vy += p.grav * dt;
      const d = Math.pow(p.drag, dt * 60);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
    for (let i = rings.length - 1; i >= 0; i--) { rings[i].life += dt; if (rings[i].life >= rings[i].max) rings.splice(i, 1); }
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      t.life += dt;
      if (t.life >= t.max) { texts.splice(i, 1); continue; }
      t.x += t.vx * dt; t.y += t.vy * dt; t.vy *= 0.94;
    }
    for (let i = beams.length - 1; i >= 0; i--) { beams[i].life += dt; if (beams[i].life >= beams[i].max) beams.splice(i, 1); }
    for (let i = glyphs.length - 1; i >= 0; i--) { glyphs[i].life += dt; if (glyphs[i].life >= glyphs[i].max) glyphs.splice(i, 1); }
    if (shakeMag > 0) { shakeMag = Math.max(0, shakeMag - dt * 26); shakeT += dt; }
    if (flashA > 0) flashA = Math.max(0, flashA - dt * 1.6);
  }

  function shakeOffset() {
    if (shakeMag <= 0.05) return null;
    return { x: Math.sin(shakeT * 91) * shakeMag, y: Math.cos(shakeT * 77) * shakeMag };
  }

  function drawParticle(ctx, p) {
    const f = p.life / p.max, a = Math.max(0, 1 - f * f);
    ctx.globalAlpha = a;
    if (p.shape === 'chip') {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.c; ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    } else if (p.shape === 'smoke') {
      ctx.fillStyle = p.c; ctx.globalAlpha = a * 0.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + f * 1.6), 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.4, p.size * (1 - f * 0.55)), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function jagPath(ctx, b) {
    const segs = 7;
    ctx.beginPath(); ctx.moveTo(b.x1, b.y1);
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      const off = s === segs ? 0 : (Math.sin(b.seed + s * 12.9898) * b.jag);
      const nx = -(b.y2 - b.y1), ny = (b.x2 - b.x1);
      const len = Math.hypot(nx, ny) || 1;
      ctx.lineTo(b.x1 + (b.x2 - b.x1) * t + nx / len * off, b.y1 + (b.y2 - b.y1) * t + ny / len * off);
    }
    ctx.stroke();
  }

  function draw(ctx) {
    /* additive pass: everything that should look like light */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of parts) if (p.glow) drawParticle(ctx, p);
    for (const b of beams) {
      const f = b.life / b.max;
      ctx.globalAlpha = 1 - f;
      ctx.strokeStyle = b.c; ctx.lineCap = 'round';
      if (b.glow) { ctx.lineWidth = b.w * 3; ctx.globalAlpha = (1 - f) * 0.25; b.jag ? jagPath(ctx, b) : lineTo(ctx, b); }
      ctx.globalAlpha = 1 - f; ctx.lineWidth = b.w;
      b.jag ? jagPath(ctx, b) : lineTo(ctx, b);
    }
    for (const r of rings) {
      const f = r.life / r.max;
      const e = r.ease === 'in' ? f * f : 1 - Math.pow(1 - f, 2.2);
      ctx.globalAlpha = (1 - f) * 0.9;
      ctx.strokeStyle = r.c; ctx.lineWidth = Math.max(0.5, r.w * (1 - f * 0.7));
      ctx.beginPath(); ctx.arc(r.x, r.y, Math.max(0.5, r.r0 + (r.r1 - r.r0) * e), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    /* normal pass: debris, smoke, glyphs, text */
    for (const p of parts) if (!p.glow) drawParticle(ctx, p);
    for (const g of glyphs) drawGlyph(ctx, g);
    ctx.textAlign = 'center';
    for (const t of texts) {
      const f = t.life / t.max;
      ctx.globalAlpha = f > 0.75 ? (1 - f) * 4 : 1;
      ctx.font = (t.bold ? 'bold ' : '') + t.size + 'px system-ui, sans-serif';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(3,6,16,.85)';
      ctx.strokeText(t.s, t.x, t.y);
      ctx.fillStyle = t.c; ctx.fillText(t.s, t.x, t.y);
      ctx.globalAlpha = 1;
    }
  }
  function lineTo(ctx, b) { ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke(); }

  function drawGlyph(ctx, g) {
    const f = g.life / g.max;
    ctx.globalAlpha = 1 - f;
    ctx.strokeStyle = g.c; ctx.lineWidth = 2.5;
    if (g.kind === 'snare') {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + f * 2;
        ctx.beginPath();
        ctx.moveTo(g.x + Math.cos(a) * g.r, g.y + Math.sin(a) * g.r * 0.5);
        ctx.lineTo(g.x, g.y);
        ctx.stroke();
      }
    } else if (g.kind === 'portal') {
      for (let i = 0; i < 3; i++) {
        const rr = g.r * (1 - f) * (1 - i * 0.25);
        ctx.beginPath();
        ctx.ellipse(g.x, g.y, rr, rr * 0.45, f * 6 + i, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* The red/green wash over the whole board when something big happens. */
  function drawFlash(ctx, w, h) {
    if (flashA <= 0.003) return;
    ctx.save();
    ctx.globalAlpha = flashA;
    ctx.fillStyle = flashC;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  return {
    setBoard, reset, update, draw, drawFlash, shakeOffset, event, winFireworks,
    part, burst, ring, text, beam, glyph, shake, flash, explosion, muzzle, confetti, lightning,
    count: () => parts.length + rings.length + texts.length + beams.length,
  };
})();
