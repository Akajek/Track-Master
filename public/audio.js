/* TRACK MASTER -- sound.
 *
 * Every sound here is synthesized at runtime with the Web Audio API: no files
 * to host, nothing to download, no licensing to think about. Sounds are panned
 * by where they happen on the board, and a compressor on the master bus keeps a
 * wall of turrets from turning into a wall of noise.
 *
 * Browsers refuse to start audio before the user interacts with the page, so
 * SFX.init() is called from the join buttons, and again from the first click or
 * key press afterwards in case the context was suspended.
 */
'use strict';
const SFX = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let enabled = true, volume = 0.7;
  let loopNode = null, loopGain = null, loopOn = false;
  let lowHpAt = 0, boardW = 960;
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
  function setBoard(w) { boardW = w || 960; }

  /* Board x to a stereo position. Never hard-panned: a sound stuck in one ear
     is more distracting than it is informative. */
  function px(x) { return Math.max(-0.7, Math.min(0.7, (x / boardW - 0.5) * 1.3)); }

  function out(pan) {
    if (!ctx.createStereoPanner || pan === undefined || pan === null) return master;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(master);
    return p;
  }

  /* Don't let ten towers firing on one tick stack into a clipped mess. */
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
    freqs.forEach((f, i) => tone(Object.assign({}, o, {
      f, delay: (o.delay || 0) + i * (o.gap === undefined ? 0.07 : o.gap),
    })));
  }

  /* --------------------------------------------------------------- voices */
  const V = {
    /* towers */
    turret: p => { if (!gate('turret', 45)) return; tone({ f: 760, f2: 300, type: 'square', dur: 0.06, v: 0.1, pan: p }); noise({ f: 3000, f2: 900, dur: 0.05, v: 0.07, pan: p }); },
    sniper: p => { tone({ f: 220, f2: 60, type: 'sawtooth', dur: 0.22, v: 0.22, pan: p }); noise({ f: 6000, f2: 500, dur: 0.18, v: 0.3, pan: p }); },
    mortar: p => { tone({ f: 150, f2: 48, type: 'sine', dur: 0.3, v: 0.35, pan: p }); noise({ f: 700, f2: 120, dur: 0.22, v: 0.16, pan: p }); },
    tesla:  p => { if (!gate('tesla', 60)) return; noise({ filter: 'bandpass', f: 2600, f2: 5200, q: 6, dur: 0.16, v: 0.3, pan: p }); tone({ f: 1400, f2: 2600, type: 'sawtooth', dur: 0.12, v: 0.07, pan: p }); },
    pulse:  p => { if (!gate('pulse', 70)) return; tone({ f: 320, f2: 90, type: 'triangle', dur: 0.35, v: 0.3, pan: p }); noise({ filter: 'bandpass', f: 900, f2: 2600, q: 2, dur: 0.3, v: 0.22, pan: p }); },
    boom:   (p, r) => {
      const big = (r || 70) / 70;
      noise({ f: 1400 * big, f2: 60, dur: 0.5 * Math.min(1.4, big), v: 0.42, pan: p, rate: 0.8 });
      tone({ f: 110 * big, f2: 32, type: 'sine', dur: 0.55 * Math.min(1.4, big), v: 0.5, pan: p });
      tone({ f: 300, f2: 70, type: 'triangle', dur: 0.2, v: 0.14, pan: p });
    },
    /* being hurt */
    hitMe:   p => { if (!gate('hitMe', 70)) return; tone({ f: 180, f2: 70, type: 'square', dur: 0.12, v: 0.26, pan: p }); noise({ f: 1800, f2: 300, dur: 0.1, v: 0.18, pan: p }); },
    hitThem: p => { if (!gate('hitThem', 90)) return; noise({ f: 1600, f2: 500, dur: 0.06, v: 0.07, pan: p }); },
    spikes:  p => { noise({ filter: 'bandpass', f: 3800, q: 8, dur: 0.12, v: 0.3, pan: p }); tone({ f: 900, f2: 400, type: 'square', dur: 0.09, v: 0.12, pan: p }); },
    saw:     p => { if (!gate('saw', 150)) return; noise({ filter: 'bandpass', f: 2200, f2: 3400, q: 9, dur: 0.18, v: 0.22, pan: p }); },
    absorb:  p => { if (!gate('absorb', 90)) return; tone({ f: 520, f2: 760, type: 'sine', dur: 0.1, v: 0.14, pan: p }); },
    shieldpop: p => { noise({ filter: 'highpass', f: 2600, dur: 0.3, v: 0.2, pan: p }); chord([880, 660], { type: 'sine', dur: 0.2, v: 0.16, gap: 0.04, pan: p }); },
    die:     p => { tone({ f: 400, f2: 55, type: 'sawtooth', dur: 0.7, v: 0.3, pan: p }); noise({ f: 900, f2: 100, dur: 0.6, v: 0.18, pan: p }); },
    /* rewards */
    finish:  p => { chord([523, 659, 784, 1047], { type: 'triangle', dur: 0.28, v: 0.3, gap: 0.075, pan: p }); chord([262, 330, 392, 523], { type: 'sine', dur: 0.3, v: 0.14, gap: 0.075, pan: p }); },
    lap:     p => chord([784, 988, 1319], { type: 'sine', dur: 0.22, v: 0.16, gap: 0.05, pan: p }),
    vpRun:   () => chord([659, 880], { type: 'triangle', dur: 0.25, v: 0.2, gap: 0.08 }),
    vpMM:    () => chord([330, 262], { type: 'sawtooth', dur: 0.25, v: 0.16, gap: 0.08 }),
    levelup: p => chord([659, 880, 1175], { type: 'triangle', dur: 0.18, v: 0.2, gap: 0.05, pan: p }),
    /* A building growing into its next shape: heavier and longer than a plain
       upgrade, because it only happens every fifth one. */
    morph:   p => {
      chord([262, 392, 523, 784, 1047], { type: 'triangle', dur: 0.4, v: 0.26, gap: 0.06, pan: p });
      tone({ f: 90, f2: 220, type: 'sawtooth', dur: 0.5, v: 0.24, pan: p });
      noise({ filter: 'bandpass', f: 600, f2: 4000, q: 3, dur: 0.5, a: 0.06, v: 0.18, pan: p });
      noise({ filter: 'highpass', f: 5000, dur: 0.6, v: 0.09, delay: 0.2, pan: p });
    },
    heal:    p => { chord([523, 784], { type: 'sine', dur: 0.25, v: 0.2, gap: 0.06, pan: p }); noise({ filter: 'highpass', f: 3000, dur: 0.3, v: 0.06, pan: p }); },
    /* runner abilities */
    emp:     p => { noise({ filter: 'bandpass', f: 300, f2: 5000, q: 4, dur: 0.35, v: 0.3, pan: p }); tone({ f: 90, f2: 1200, type: 'sawtooth', dur: 0.3, v: 0.1, pan: p }); tone({ f: 1800, f2: 200, type: 'sine', dur: 0.25, v: 0.1, delay: 0.28, pan: p }); },
    dash:    p => { noise({ filter: 'bandpass', f: 500, f2: 2600, q: 2, dur: 0.22, v: 0.3, pan: p }); tone({ f: 300, f2: 800, type: 'triangle', dur: 0.16, v: 0.1, pan: p }); },
    blink:   p => { tone({ f: 1200, f2: 200, type: 'sine', dur: 0.18, v: 0.2, pan: p }); tone({ f: 200, f2: 1600, type: 'sine', dur: 0.18, v: 0.18, delay: 0.06, pan: p }); noise({ filter: 'bandpass', f: 2000, q: 5, dur: 0.2, v: 0.12, pan: p }); },
    ghost:   p => { chord([880, 1175], { type: 'sine', dur: 0.4, v: 0.12, gap: 0.06, pan: p }); noise({ filter: 'highpass', f: 5000, dur: 0.5, v: 0.07, pan: p }); },
    shieldup: p => { chord([392, 523, 659], { type: 'sine', dur: 0.3, v: 0.18, gap: 0.05, pan: p }); noise({ filter: 'bandpass', f: 1200, f2: 400, q: 3, dur: 0.3, v: 0.1, pan: p }); },
    decoy:   p => { chord([440, 554], { type: 'square', dur: 0.16, v: 0.12, gap: 0.05, pan: p }); },
    decoypop: p => { noise({ filter: 'bandpass', f: 1400, q: 3, dur: 0.15, v: 0.14, pan: p }); },
    surge:   p => { tone({ f: 200, f2: 900, type: 'sawtooth', dur: 0.35, v: 0.2, pan: p }); noise({ filter: 'bandpass', f: 600, f2: 3200, q: 2, dur: 0.35, v: 0.16, pan: p }); },
    /* traps */
    snare:   p => { noise({ filter: 'bandpass', f: 700, f2: 200, q: 4, dur: 0.3, v: 0.26, pan: p }); tone({ f: 300, f2: 90, type: 'square', dur: 0.25, v: 0.18, pan: p }); },
    portal:  p => { tone({ f: 700, f2: 120, type: 'sine', dur: 0.6, v: 0.26, pan: p }); noise({ filter: 'bandpass', f: 2400, f2: 300, q: 3, dur: 0.6, v: 0.2, pan: p }); },
    portalout: p => tone({ f: 140, f2: 700, type: 'sine', dur: 0.35, v: 0.18, pan: p }),
    root:    p => { tone({ f: 260, f2: 100, type: 'square', dur: 0.3, v: 0.2, pan: p }); },
    slow:    p => { noise({ filter: 'lowpass', f: 700, f2: 200, dur: 0.3, v: 0.16, pan: p }); tone({ f: 300, f2: 150, type: 'triangle', dur: 0.3, v: 0.1, pan: p }); },
    /* mastermind and round flow */
    build:   p => { tone({ f: 880, type: 'square', dur: 0.05, v: 0.14, pan: p }); tone({ f: 1320, type: 'square', dur: 0.09, v: 0.12, delay: 0.06, pan: p }); },
    sell:    p => { chord([880, 587], { type: 'triangle', dur: 0.14, v: 0.16, gap: 0.06, pan: p }); },
    spawn:   () => chord([392, 523, 784], { type: 'triangle', dur: 0.2, v: 0.2, gap: 0.06 }),
    respawn: () => chord([392, 523, 784], { type: 'triangle', dur: 0.2, v: 0.2, gap: 0.06 }),
    freeze:  () => { chord([1568, 1175, 880, 659], { type: 'sine', dur: 0.5, v: 0.26, gap: 0.05 }); noise({ filter: 'highpass', f: 4000, dur: 0.7, v: 0.1 }); tone({ f: 200, f2: 60, type: 'sine', dur: 0.8, v: 0.2 }); },
    unfreeze: () => chord([660, 990], { type: 'sine', dur: 0.18, v: 0.13, gap: 0.05 }),
    meteor:  p => { tone({ f: 220, f2: 1500, type: 'sawtooth', dur: 0.95, a: 0.15, v: 0.14, pan: p }); noise({ filter: 'bandpass', f: 400, f2: 3000, q: 3, dur: 0.95, a: 0.2, v: 0.12, pan: p }); },
    live:    () => chord([392, 523, 659, 1047], { type: 'square', dur: 0.22, v: 0.2, gap: 0.09 }),
    edit:    () => chord([440, 330], { type: 'triangle', dur: 0.22, v: 0.2, gap: 0.09 }),
    winrun:  () => { chord([523, 659, 784, 1047, 1319], { type: 'triangle', dur: 0.45, v: 0.3, gap: 0.13 }); chord([262, 330, 392, 523, 659], { type: 'sine', dur: 0.5, v: 0.16, gap: 0.13 }); },
    winmm:   () => { chord([330, 262, 220, 165], { type: 'sawtooth', dur: 0.5, v: 0.28, gap: 0.15 }); tone({ f: 80, f2: 45, type: 'sine', dur: 1.4, v: 0.3, delay: 0.4 }); },
    /* interface */
    good:    () => chord([784, 1175], { type: 'triangle', dur: 0.16, v: 0.22, gap: 0.06 }),
    warn:    () => { tone({ f: 200, f2: 150, type: 'square', dur: 0.16, v: 0.16 }); tone({ f: 150, f2: 110, type: 'square', dur: 0.16, v: 0.12, delay: 0.1 }); },
    info:    () => tone({ f: 660, f2: 880, type: 'sine', dur: 0.1, v: 0.12 }),
    ui:      () => { if (!gate('ui', 40)) return; tone({ f: 1100, f2: 1500, type: 'square', dur: 0.03, v: 0.06 }); },
    paint:   () => { if (!gate('paint', 55)) return; noise({ filter: 'bandpass', f: 900 + Math.random() * 400, q: 3, dur: 0.05, v: 0.1 }); },
    heart:   () => { tone({ f: 70, f2: 45, type: 'sine', dur: 0.12, v: 0.3 }); tone({ f: 60, f2: 40, type: 'sine', dur: 0.16, v: 0.22, delay: 0.17 }); },
    /* ---- barrier: glassy, so it never sounds like losing health ---- */
    barrier:  p => { if (!gate('barrier', 80)) return; tone({ f: 1050, f2: 1400, type: 'sine', dur: 0.08, v: 0.1, pan: p }); noise({ filter: 'highpass', f: 5000, dur: 0.07, v: 0.05, pan: p }); },
    barrierbreak: p => { noise({ filter: 'highpass', f: 3200, dur: 0.45, v: 0.24, pan: p }); chord([1175, 880, 587], { type: 'sine', dur: 0.26, v: 0.18, gap: 0.045, pan: p }); },
    barrierup: p => chord([587, 880], { type: 'sine', dur: 0.2, v: 0.11, gap: 0.05, pan: p }),
    /* ---- getting out of the way ---- */
    dodge:    p => { if (!gate('dodge', 70)) return; noise({ filter: 'bandpass', f: 2600, f2: 900, q: 2, dur: 0.12, v: 0.13, pan: p }); },
    deflect:  p => { tone({ f: 1800, f2: 2600, type: 'square', dur: 0.06, v: 0.14, pan: p }); noise({ filter: 'bandpass', f: 4200, q: 9, dur: 0.14, v: 0.16, pan: p }); tone({ f: 2400, f2: 700, type: 'sine', dur: 0.16, v: 0.08, delay: 0.03, pan: p }); },
    flicker:  p => { tone({ f: 500, f2: 900, type: 'square', dur: 0.07, v: 0.12, pan: p }); tone({ f: 900, f2: 400, type: 'square', dur: 0.07, v: 0.1, delay: 0.08, pan: p }); },
    /* ---- tunnels: a swallow and a spit ---- */
    tunnelin:  p => { tone({ f: 620, f2: 90, type: 'sine', dur: 0.4, v: 0.24, pan: p }); noise({ filter: 'lowpass', f: 1800, f2: 200, dur: 0.4, v: 0.18, pan: p }); },
    tunnelout: p => { tone({ f: 110, f2: 820, type: 'sine', dur: 0.3, v: 0.22, pan: p }); noise({ filter: 'bandpass', f: 500, f2: 3000, q: 2, dur: 0.3, v: 0.14, pan: p }); },
    jolt:     p => { noise({ filter: 'bandpass', f: 1800, f2: 4800, q: 7, dur: 0.2, v: 0.28, pan: p }); tone({ f: 120, f2: 1600, type: 'sawtooth', dur: 0.16, v: 0.12, pan: p }); },
    /* ---- healing nova: a chord that blooms outwards ---- */
    nova:     p => {
      chord([523, 659, 784, 1047, 1319], { type: 'sine', dur: 0.5, v: 0.22, gap: 0.045, pan: p });
      chord([262, 392], { type: 'triangle', dur: 0.6, v: 0.14, gap: 0.06, pan: p });
      noise({ filter: 'highpass', f: 3400, dur: 0.6, a: 0.1, v: 0.08, pan: p });
    },
    /* ---- the ultimate: the loudest thing in the game, and it should be ---- */
    ult:      p => {
      tone({ f: 60, f2: 30, type: 'sine', dur: 1.6, v: 0.5, pan: p });
      noise({ filter: 'lowpass', f: 300, f2: 60, dur: 1.2, v: 0.4, rate: 0.6, pan: p });
      tone({ f: 1400, f2: 120, type: 'sawtooth', dur: 0.5, v: 0.2, pan: p });
      chord([131, 165, 196, 262, 330, 392], { type: 'sawtooth', dur: 0.7, v: 0.2, gap: 0.035, pan: p });
      noise({ filter: 'bandpass', f: 900, f2: 6000, q: 2, dur: 0.8, a: 0.12, v: 0.2, delay: 0.1, pan: p });
      tone({ f: 2200, f2: 4400, type: 'sine', dur: 0.4, v: 0.1, delay: 0.45, pan: p });
    },
    /* ---- holding the END: a clock that speeds up as the bar fills ---- */
    tick:     () => { if (!gate('tick', 90)) return; tone({ f: 1200, f2: 1500, type: 'square', dur: 0.03, v: 0.09 }); },
    /* ---- the armoury ---- */
    unlockpt: () => { chord([880, 1175, 1568], { type: 'triangle', dur: 0.22, v: 0.2, gap: 0.05 }); noise({ filter: 'highpass', f: 4000, dur: 0.3, v: 0.07 }); },
    unlocked: () => { chord([392, 523, 659, 880, 1047], { type: 'square', dur: 0.3, v: 0.22, gap: 0.07 }); tone({ f: 98, f2: 196, type: 'sawtooth', dur: 0.5, v: 0.2 }); },
    slot:     p => chord([659, 988], { type: 'triangle', dur: 0.16, v: 0.16, gap: 0.05, pan: p }),
  };

  /* ------------------------------------------------- server event -> sound */
  function event(e, myId) {
    if (!ready()) return;
    switch (e.k) {
      case 'fire':
        (e.ty === 'mortar' ? V.mortar : e.ty === 'sniper' ? V.sniper : V.turret)(px(e.x));
        break;
      case 'shot': (e.z ? V.tesla : V.sniper)(px(e.x1)); break;
      case 'pulse': V.pulse(px(e.x)); break;
      case 'boom': V.boom(px(e.x), e.r); break;
      case 'hit':
        if (e.s === 'spikes') V.spikes(px(e.x));
        else if (e.id === myId) V.hitMe(px(e.x));
        else V.hitThem(px(e.x));
        break;
      case 'burn': if (e.s === 'saw') V.saw(px(e.x)); break;
      case 'absorb': V.absorb(px(e.x)); break;
      case 'shieldpop': V.shieldpop(px(e.x)); break;
      case 'shieldup': V.shieldup(px(e.x)); break;
      case 'die': V.die(px(e.x)); break;
      case 'fin': V.finish(px(e.x)); break;
      case 'lap': V.lap(px(e.x)); break;
      case 'vp': (e.team === 'mm' ? V.vpMM : V.vpRun)(); break;
      case 'emp': V.emp(px(e.x)); break;
      case 'dash': V.dash(px(e.x)); break;
      case 'blink': V.blink(px(e.x2)); break;
      case 'ghost': V.ghost(px(e.x)); break;
      case 'surge': V.surge(px(e.x)); break;
      case 'heal': V.heal(px(e.x)); break;
      case 'decoy': V.decoy(px(e.x)); break;
      case 'decoypop': V.decoypop(px(e.x)); break;
      case 'snare': V.snare(px(e.x)); break;
      case 'portal': V.portal(px(e.x)); break;
      case 'portalout': V.portalout(px(e.x)); break;
      case 'spawn': V.spawn(); break;
      case 'build': V.build(px(e.x)); break;
      case 'sell': V.sell(px(e.x)); break;
      case 'levelup': V.levelup(px(e.x)); break;
      case 'morph': V.morph(px(e.x)); break;
      case 'barrierhit': if (e.id === myId) V.barrier(px(e.x)); break;
      case 'barrierbreak': V.barrierbreak(px(e.x)); break;
      case 'barrierup': if (e.id === myId) V.barrierup(px(e.x)); break;
      case 'dodge': V.dodge(px(e.x)); break;
      case 'deflect': V.deflect(px(e.x)); break;
      case 'flicker': V.flicker(px(e.x)); break;
      case 'tunnelin': V.tunnelin(px(e.x)); break;
      case 'tunnelout': V.tunnelout(px(e.x)); break;
      case 'jolt': V.jolt(px(e.x)); break;
      case 'nova': V.nova(px(e.x)); break;
      case 'ult': V.ult(px(e.x)); break;
      case 'unlockpt': V.unlockpt(); break;
      case 'unlocked': V.unlocked(); break;
      case 'slot': V.slot(px(e.x)); break;
    }
  }

  /* The escape clock. One tick per tenth of the bar, so holding an END sounds
     like a countdown getting more and more urgent. */
  function escape(cur, prev) {
    if (!ready() || !(cur > 0)) return;
    if (Math.floor(cur * 10) > Math.floor((prev || 0) * 10)) V.tick();
  }

  /* --------------------------------------------------- continuous sounds */
  /* Flamers, lasers and saws hum while they work, so one loop runs as long as
     at least one of them is going. */
  function flame(active) {
    if (!ctx) return;
    if (active && !loopNode && ready()) {
      loopNode = ctx.createBufferSource();
      loopNode.buffer = noiseBuf; loopNode.loop = true; loopNode.playbackRate.value = 0.45;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 520; f.Q.value = 0.8;
      loopGain = ctx.createGain(); loopGain.gain.value = 0.0001;
      loopNode.connect(f); f.connect(loopGain); loopGain.connect(master);
      loopNode.start();
    }
    if (!loopNode) return;
    if (loopOn !== active) {
      loopOn = active;
      const target = (active && ready()) ? 0.11 : 0.0001;
      loopGain.gain.cancelScheduledValues(now());
      loopGain.gain.setValueAtTime(Math.max(0.0001, loopGain.gain.value), now());
      loopGain.gain.exponentialRampToValueAtTime(target, now() + 0.12);
    }
  }

  /* A heartbeat when you are nearly dead. Quiet, and it stops as soon as you
     heal past the threshold. */
  function lowHp(active) {
    if (!ready() || !active) { lowHpAt = 0; return; }
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
    init, event, flame, lowHp, escape, setEnabled, setVolume, setBoard,
    isEnabled: () => enabled, getVolume: () => volume,
    state: () => (ctx ? ctx.state : 'none'),
    play: (name, pan) => { if (ready() && V[name]) V[name](pan); },
    meteorIncoming: x => { if (ready()) V.meteor(px(x)); },
  };
})();
