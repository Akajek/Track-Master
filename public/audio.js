/* TRACK MASTER -- sound.
 *
 * Every sound here is synthesized at runtime with the Web Audio API: no files
 * to host, nothing to download, no licensing to think about. Sounds are panned
 * by where they happen on the board, and a compressor on the master bus keeps a
 * wall of turrets from turning into a wall of noise.
 *
 * Browsers refuse to start audio before the user interacts with the page, so
 * SFX.init() is called from the join buttons (and from the first click or key
 * press afterwards, in case the context was suspended again).
 */
'use strict';
const SFX = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let enabled = true, volume = 0.7;
  let flameNode = null, flameGain = null, flameActive = false;
  let lowHpAt = 0;
  const lastAt = {};

  try {
    const s = localStorage.getItem('tm_sound');
    if (s !== null) enabled = s === '1';
    const v = parseFloat(localStorage.getItem('tm_vol'));
    if (Number.isFinite(v)) volume = Math.max(0, Math.min(1, v));
  } catch (e) { /* private mode: defaults are fine */ }

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? volume * 0.5 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 20; comp.ratio.value = 6;
    comp.attack.value = 0.003; comp.release.value = 0.15;
    master.connect(comp); comp.connect(ctx.destination);
    const n = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }

  const ready = () => !!ctx && enabled && volume > 0;
  const now = () => ctx.currentTime;

  /* Board x (0..960) to a stereo position. Never fully hard-panned: a sound
     stuck in one ear is more distracting than it is informative. */
  function px(x) { return Math.max(-0.7, Math.min(0.7, (x / 960 - 0.5) * 1.3)); }

  function out(pan) {
    if (!ctx.createStereoPanner || pan === undefined || pan === null) return master;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(master);
    return p;
  }

  /* Don't let ten towers firing on the same tick stack into a clipped mess. */
  function gate(key, ms) {
    const t = performance.now();
    if (lastAt[key] && t - lastAt[key] < ms) return false;
    lastAt[key] = t;
    return true;
  }

  function env(gain, t0, attack, decay, peak) {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  /* One oscillator with a pitch sweep and a plucked envelope. */
  function tone(o) {
    if (!ready()) return;
    const t = now() + (o.delay || 0), dur = o.dur || 0.15;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t + dur);
    const g = ctx.createGain();
    env(g, t, o.a || 0.004, dur, o.v === undefined ? 0.3 : o.v);
    osc.connect(g); g.connect(out(o.pan));
    osc.start(t); osc.stop(t + dur + (o.a || 0.004) + 0.05);
  }

  /* A burst of noise through a sweeping filter: hits, booms, whooshes. */
  function noise(o) {
    if (!ready()) return;
    const t = now() + (o.delay || 0), dur = o.dur || 0.2;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = o.rate || 1;
    const f = ctx.createBiquadFilter();
    f.type = o.filter || 'lowpass';
    f.frequency.setValueAtTime(o.f, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.f2), t + dur);
    f.Q.value = o.q || 1;
    const g = ctx.createGain();
    env(g, t, o.a || 0.004, dur, o.v === undefined ? 0.25 : o.v);
    src.connect(f); f.connect(g); g.connect(out(o.pan));
    src.start(t, Math.random() * 1.1);
    src.stop(t + dur + (o.a || 0.004) + 0.05);
  }

  function chord(freqs, o) {
    freqs.forEach((f, i) => tone(Object.assign({}, o, { f, delay: (o.delay || 0) + i * (o.gap === undefined ? 0.07 : o.gap) })));
  }

  /* --------------------------------------------------------------- voices */
  const V = {
    turret: pan => { if (!gate('turret', 45)) return; tone({ f: 760, f2: 300, type: 'square', dur: 0.06, v: 0.1, pan }); noise({ f: 3000, f2: 900, dur: 0.05, v: 0.07, pan }); },
    sniper: pan => { tone({ f: 220, f2: 60, type: 'sawtooth', dur: 0.22, v: 0.22, pan }); noise({ f: 6000, f2: 500, dur: 0.18, v: 0.3, pan }); },
    mortar: pan => { tone({ f: 150, f2: 48, type: 'sine', dur: 0.3, v: 0.35, pan }); noise({ f: 700, f2: 120, dur: 0.22, v: 0.16, pan }); },
    tesla:  pan => { if (!gate('tesla', 60)) return; noise({ filter: 'bandpass', f: 2600, f2: 5200, q: 6, dur: 0.16, v: 0.3, pan }); tone({ f: 1400, f2: 2600, type: 'sawtooth', dur: 0.12, v: 0.07, pan }); },
    boom:   (pan, r) => {
      const big = (r || 70) / 70;
      noise({ f: 1400 * big, f2: 60, dur: 0.5 * big, v: 0.42, pan, rate: 0.8 });
      tone({ f: 110 * big, f2: 32, type: 'sine', dur: 0.55 * big, v: 0.5, pan });
      tone({ f: 300, f2: 70, type: 'triangle', dur: 0.2, v: 0.14, pan });
    },
    hitMe:   pan => { if (!gate('hitMe', 70)) return; tone({ f: 180, f2: 70, type: 'square', dur: 0.12, v: 0.26, pan }); noise({ f: 1800, f2: 300, dur: 0.1, v: 0.18, pan }); },
    hitThem: pan => { if (!gate('hitThem', 90)) return; noise({ f: 1600, f2: 500, dur: 0.06, v: 0.07, pan }); },
    spikes:  pan => { noise({ filter: 'bandpass', f: 3800, q: 8, dur: 0.12, v: 0.3, pan }); tone({ f: 900, f2: 400, type: 'square', dur: 0.09, v: 0.12, pan }); },
    die:     pan => { tone({ f: 400, f2: 55, type: 'sawtooth', dur: 0.7, v: 0.3, pan }); noise({ f: 900, f2: 100, dur: 0.6, v: 0.18, pan }); },
    finish:  pan => { chord([523, 659, 784, 1047], { type: 'triangle', dur: 0.28, v: 0.3, gap: 0.075, pan }); chord([262, 330, 392, 523], { type: 'sine', dur: 0.3, v: 0.14, gap: 0.075, pan }); },
    emp:     pan => { noise({ filter: 'bandpass', f: 300, f2: 5000, q: 4, dur: 0.35, v: 0.3, pan }); tone({ f: 90, f2: 1200, type: 'sawtooth', dur: 0.3, v: 0.1, pan }); tone({ f: 1800, f2: 200, type: 'sine', dur: 0.25, v: 0.1, delay: 0.28, pan }); },
    dash:    pan => { noise({ filter: 'bandpass', f: 500, f2: 2600, q: 2, dur: 0.22, v: 0.3, pan }); tone({ f: 300, f2: 800, type: 'triangle', dur: 0.16, v: 0.1, pan }); },
    build:   pan => { tone({ f: 880, type: 'square', dur: 0.05, v: 0.14, pan }); tone({ f: 1320, type: 'square', dur: 0.09, v: 0.12, delay: 0.06, pan }); },
    respawn: () => chord([392, 523, 784], { type: 'triangle', dur: 0.2, v: 0.2, gap: 0.06 }),
    freeze:  () => { chord([1568, 1175, 880, 659], { type: 'sine', dur: 0.5, v: 0.26, gap: 0.05 }); noise({ filter: 'highpass', f: 4000, dur: 0.7, v: 0.1 }); tone({ f: 200, f2: 60, type: 'sine', dur: 0.8, v: 0.2 }); },
    unfreeze: () => chord([660, 990], { type: 'sine', dur: 0.18, v: 0.13, gap: 0.05 }),
    meteor:  pan => { tone({ f: 220, f2: 1500, type: 'sawtooth', dur: 0.95, a: 0.15, v: 0.14, pan }); noise({ filter: 'bandpass', f: 400, f2: 3000, q: 3, dur: 0.95, a: 0.2, v: 0.12, pan }); },
    live:    () => chord([392, 523, 659, 1047], { type: 'square', dur: 0.22, v: 0.2, gap: 0.09 }),
    edit:    () => chord([440, 330], { type: 'triangle', dur: 0.22, v: 0.2, gap: 0.09 }),
    good:    () => chord([784, 1175], { type: 'triangle', dur: 0.16, v: 0.22, gap: 0.06 }),
    warn:    () => { tone({ f: 200, f2: 150, type: 'square', dur: 0.16, v: 0.16 }); tone({ f: 150, f2: 110, type: 'square', dur: 0.16, v: 0.12, delay: 0.1 }); },
    info:    () => tone({ f: 660, f2: 880, type: 'sine', dur: 0.1, v: 0.12 }),
    ui:      () => { if (!gate('ui', 40)) return; tone({ f: 1100, f2: 1500, type: 'square', dur: 0.03, v: 0.06 }); },
    paint:   () => { if (!gate('paint', 55)) return; noise({ filter: 'bandpass', f: 900 + Math.random() * 400, q: 3, dur: 0.05, v: 0.1 }); },
    slow:    pan => { noise({ filter: 'lowpass', f: 700, f2: 200, dur: 0.3, v: 0.16, pan }); tone({ f: 300, f2: 150, type: 'triangle', dur: 0.3, v: 0.1, pan }); },
    heart:   () => { tone({ f: 70, f2: 45, type: 'sine', dur: 0.12, v: 0.3 }); tone({ f: 60, f2: 40, type: 'sine', dur: 0.16, v: 0.22, delay: 0.17 }); },
  };

  /* ------------------------------------------------- server event -> sound */
  function event(e, myId) {
    if (!ready()) return;
    switch (e.k) {
      case 'fire': (e.ty === 'mortar' ? V.mortar : V.turret)(px(e.x)); break;
      case 'shot': (e.z ? V.tesla : V.sniper)(px(e.x1)); break;
      case 'boom': V.boom(px(e.x), e.r); break;
      case 'hit':
        if (e.s === 'spikes') V.spikes(px(e.x));
        else if (e.id === myId) V.hitMe(px(e.x));
        else V.hitThem(px(e.x));
        break;
      case 'die': V.die(px(e.x)); break;
      case 'fin': V.finish(px(e.x)); break;
      case 'emp': V.emp(px(e.x)); break;
      case 'dash': V.dash(px(e.x)); break;
      case 'build': V.build(px(e.x)); break;
    }
  }

  /* --------------------------------------------------- continuous sounds */
  /* Flamers hum while they burn, so the loop lives as long as one is firing. */
  function flame(active) {
    if (!ctx) return;
    if (active && !flameNode && ready()) {
      flameNode = ctx.createBufferSource();
      flameNode.buffer = noiseBuf; flameNode.loop = true; flameNode.playbackRate.value = 0.45;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 520; f.Q.value = 0.8;
      flameGain = ctx.createGain(); flameGain.gain.value = 0.0001;
      flameNode.connect(f); f.connect(flameGain); flameGain.connect(master);
      flameNode.start();
    }
    if (!flameNode) return;
    const target = (active && ready()) ? 0.11 : 0.0001;
    if (flameActive !== active) {
      flameActive = active;
      flameGain.gain.cancelScheduledValues(now());
      flameGain.gain.setValueAtTime(Math.max(0.0001, flameGain.gain.value), now());
      flameGain.gain.exponentialRampToValueAtTime(target, now() + 0.12);
    }
  }

  /* A heartbeat when you are nearly dead. Quiet, and it stops as soon as you
     heal past the threshold. */
  function lowHp(active) {
    if (!ready()) { lowHpAt = 0; return; }
    if (!active) { lowHpAt = 0; return; }
    const t = performance.now();
    if (t - lowHpAt < 900) return;
    lowHpAt = t;
    V.heart();
  }

  /* ------------------------------------------------------------- controls */
  function setEnabled(v) {
    enabled = !!v;
    try { localStorage.setItem('tm_sound', enabled ? '1' : '0'); } catch (e) {}
    if (enabled) init();
    if (master) {
      master.gain.cancelScheduledValues(now());
      master.gain.setTargetAtTime(enabled ? volume * 0.5 : 0, now(), 0.02);
    }
    if (!enabled) flame(false);
  }
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('tm_vol', String(volume)); } catch (e) {}
    if (master) master.gain.setTargetAtTime(enabled ? volume * 0.5 : 0, now(), 0.02);
  }

  return {
    init, event, flame, lowHp, setEnabled, setVolume,
    isEnabled: () => enabled, getVolume: () => volume,
    state: () => (ctx ? ctx.state : 'none'),
    play: (name, pan) => { if (ready() && V[name]) V[name](pan); },
    meteorIncoming: x => { if (ready()) V.meteor(px(x)); },
  };
})();
