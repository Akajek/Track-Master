/* TRACK MASTER -- the numbers, in one place.
 *
 * Both sides need these: the server to apply them and the client to show them
 * on buttons before you click. Keeping two copies in sync by hand is how a menu
 * ends up promising 120 gold and the server charging 140, so this file is
 * loaded by the browser as a plain script and required by the server.
 *
 * Nothing here is hard-capped except where a cap is the only sane answer.
 * Everything else uses DIMINISHING RETURNS: levels keep going up forever, they
 * just buy less and less. Every curve in this file is exposed to the UI so the
 * game can show you exactly where you are on it.
 */
'use strict';
const RULES = {
  /* =================================================== diminishing returns */
  /* Passive upgrades pay full value up to level 15. Past that each level adds
     less than the one before, approaching but never reaching +12 more. A level
     40 runner is meaningfully stronger than a level 20 one and nowhere near
     twice as strong, which is the whole point. */
  DR_START: 15, DR_REACH: 12, DR_RATE: 0.92,
  eff(lv) {
    lv = lv || 0;
    if (lv <= RULES.DR_START) return lv;
    return RULES.DR_START + RULES.DR_REACH * (1 - Math.pow(RULES.DR_RATE, lv - RULES.DR_START));
  },
  /* Speed gets its own, harsher curve. Unbounded speed was not an upgrade, it
     was a teleport: you could cross the whole board between two server ticks
     and nothing ever got a shot off. It is still never hard-capped. */
  SPD_REACH: 6, SPD_RATE: 0.86,
  speedEff(lv) {
    lv = lv || 0;
    if (lv <= RULES.DR_START) return lv;
    return RULES.DR_START + RULES.SPD_REACH * (1 - Math.pow(RULES.SPD_RATE, lv - RULES.DR_START));
  },
  /* Abilities are capped at 5 and diminish past it, so a single ability cannot
     be levelled into the ground while the rest of your kit stays at one. */
  AB_CAP: 5, AB_REACH: 2, AB_RATE: 0.8,
  abEff(lv) {
    lv = lv || 0;
    if (lv <= RULES.AB_CAP) return lv;
    return RULES.AB_CAP + RULES.AB_REACH * (1 - Math.pow(RULES.AB_RATE, lv - RULES.AB_CAP));
  },
  /* Chance-based upgrades converge on their ceiling and never pass it. */
  chance(lv, max) { return max * (1 - Math.pow(0.88, lv || 0)); },
  DODGE_MAX: 0.35,

  /* Which curve a given upgrade key rides, for the UI. */
  curveOf(key, kind) {
    if (kind === 'ability') return 'ability';
    if (key === 'speed') return 'speed';
    if (key === 'dodge' || key === 'deflect') return 'chance';
    return 'passive';
  },
  effOf(key, kind, lv) {
    const c = RULES.curveOf(key, kind);
    return c === 'ability' ? RULES.abEff(lv) : c === 'speed' ? RULES.speedEff(lv) : RULES.eff(lv);
  },
  /* True once a level is buying less than a full level's worth. */
  softCapped(key, kind, lv) {
    const c = RULES.curveOf(key, kind);
    if (c === 'ability') return lv > RULES.AB_CAP;
    if (c === 'chance') return lv > 8;
    return lv > RULES.DR_START;
  },

  /* ================================================================ costs */
  upgradeCost(set, def, lv) {
    /* Cheaper to get going, so an early runner can actually buy something, and
       no cheaper past the soft cap, so levelling forever costs forever. */
    const base = (1 + lv * 0.42) * Math.pow(1.055, lv) * (def.kind === 'ability' ? 2.2 : 1) * (def.costMul || 1);
    return Math.max(1, Math.round(base * set.upGrow / 100));
  },
  /* Ability slots. You start with a few and buy the rest; the price climbs
     fast enough to be a real decision and not fast enough to be a wall. */
  slotCost(set, owned) {
    const n = Math.max(0, owned - (set.slotStart || 4));
    return Math.max(1, Math.round(25 * Math.pow(1.75, n) * set.upGrow / 100));
  },
  ultCost(set, lv) { return Math.max(1, Math.round(60 * Math.pow(2.1, lv) * set.upGrow / 100)); },
  /* Refund for dropping an ability you regret, so one bad pick in a limited
     slot is a setback and not a dead save. */
  refundFor(set, def, lv) {
    let sum = 0;
    for (let i = 0; i < lv; i++) sum += RULES.upgradeCost(set, def, i);
    return Math.floor(sum * 0.6);
  },

  buildCost(set, def) { return Math.max(1, Math.round(def.cost * set.towerCost / 100)); },

  /* Building upgrades.
   *
   * Two things shape the price. The building's TOTAL upgrades set the base and
   * climb steeply at first, then flatten out -- the late game is where the
   * Mastermind is supposed to get scary, so the thirtieth upgrade is not
   * allowed to cost a hundred times the first. And each track is priced
   * RELATIVE to the building's average: a track you have never touched is
   * cheap, a track you have poured everything into is dear. Relative, not
   * absolute, so a trap with a single track -- where that track IS the average
   * -- is never punished for having nowhere else to spend. */
  TRACK_EXP: 1.12, TRACK_EXP_LATE: 1.06, TRACK_KNEE: 10, TRACK_SPREAD: 1.16,
  growth(total) {
    const a = Math.min(total, RULES.TRACK_KNEE), b = Math.max(0, total - RULES.TRACK_KNEE);
    return Math.pow(RULES.TRACK_EXP, a) * Math.pow(RULES.TRACK_EXP_LATE, b);
  },
  trackCost(set, def, totalUpgrades, trackLv, nTracks) {
    const n = nTracks || (def.tracks ? def.tracks.length : 1) || 1;
    const rel = Math.max(-4, Math.min(8, (trackLv || 0) - totalUpgrades / n));
    const spread = Math.pow(RULES.TRACK_SPREAD, rel);
    return Math.max(1, Math.round(def.cost * 0.5 * RULES.growth(totalUpgrades) * spread * set.twGrow / 100));
  },
  sellValue(spent) { return Math.round(spent * 0.7); },

  /* Mastermind gold upgrades: global, bought once per level, never sold. */
  mmUpCost(set, def, lv) {
    return Math.max(1, Math.round(def.cost * Math.pow(def.grow || 1.6, lv) * set.twGrow / 100));
  },

  /* ============================================================= unlocking */
  /* The Mastermind starts with a handful of buildings and earns the rest by
     hurting people. Every unlock costs more damage than the last, so the
     armoury opens over a whole game instead of in the first thirty seconds. */
  UNLOCK_BASE: 120, UNLOCK_GROW: 1.18,
  unlockNeed(set, earned) {
    return Math.max(1, Math.round(RULES.UNLOCK_BASE * Math.pow(RULES.UNLOCK_GROW, earned || 0) *
      (set.unlockRate || 100) / 100));
  },

  /* ================================================================ forms */
  /* Buildings do not have a level. They have a FORM, and they change shape
     every five upgrades: at 5, 10, 15, 20, 25 and 30 total upgrades across all
     of their tracks. Past the last form the shape stops changing and further
     upgrades only feed the stats. */
  FORM_STEP: 5,
  MAX_FORM: 6,
  upgrades(up) { let n = 0; for (const k in up) n += up[k] || 0; return n; },
  form(up) { return Math.min(RULES.MAX_FORM, Math.floor(RULES.upgrades(up) / RULES.FORM_STEP)); },
  toNextForm(up) {
    const f = RULES.form(up);
    if (f >= RULES.MAX_FORM) return 0;
    return (f + 1) * RULES.FORM_STEP - RULES.upgrades(up);
  },
  formName(def, up) { return (def.forms && def.forms[RULES.form(up)]) || def.name; },

  /* ========================================================== tower stats */
  /* Each new form is worth a bonus of its own on top of the tracks, so growing
     a shape is always a real step up and not just a new coat of paint. */
  dmg(def, up, set) {
    const dial = set && set.towerPower ? set.towerPower / 100 : 1;
    return (def.dmg || def.dps || 0) * Math.pow(1.25, up.dmg || 0) * Math.pow(1.18, RULES.form(up)) * dial;
  },
  range(def, up) { return (def.range || 0) * Math.pow(1.12, up.rng || 0) * Math.pow(1.05, RULES.form(up)); },
  rate(def, up)  { return (def.rate || 0) * Math.pow(1.18, up.spd || 0) * Math.pow(1.07, RULES.form(up)); },
  MAX_SLOW: 0.9,
  slow(def, up) {
    return Math.min(RULES.MAX_SLOW, 1 - (1 - (def.slow || 0)) * Math.pow(0.88, up.pow || 0));
  },
  root(def, up)  { return (def.root || 0) * (1 + 0.12 * (up.pow || 0)); },
  splash(def, up) { return (def.splash || 0) * Math.pow(1.12, up.pow || 0); },
  proj(def, up) { return (def.proj || 0) * Math.pow(1.2, up.vel || 0); },
  cooldown(def, up) {
    return (def.cd || 0) / (Math.pow(1.18, up.spd || 0) * Math.pow(1.07, RULES.form(up)));
  },

  /* ========================================================= runner stats */
  speed(set, up, laps) {
    return set.runSpeed * Math.pow(1.065, RULES.speedEff(up.speed)) * (1 + laps * set.lapBonus / 100);
  },
  maxHp(set, up, laps) {
    const dial = set && set.runnerHp ? set.runnerHp / 100 : 1;
    return (170 + 26 * RULES.eff(up.hp) + laps * set.lapBonus) * dial;
  },

  /* ---- healing ---- */
  /* Healing Power multiplies every source of healing you have. */
  healPow(up) { return 1 + 0.12 * RULES.eff(up.healpow); },
  /* Regen races the incoming damage instead of waiting politely for it to
     stop, which is what makes it worth buying under fire. */
  regenPerSec(up) { return (4 + 2.6 * RULES.eff(up.regen)) * RULES.healPow(up); },
  /* Out of combat healing scales much harder than regen does, but only once
     nothing has touched you for a couple of seconds. */
  OOC_MS: 2500,
  oocPerSec(up) { return 7 * RULES.eff(up.oocheal) * RULES.healPow(up); },

  /* ---- barrier ---- */
  /* A second health bar that eats damage first and grows back on its own, but
     only while you are not being hit. */
  BARRIER_MS: 1800,
  barrierMax(set, up) {
    const dial = set && set.runnerHp ? set.runnerHp / 100 : 1;
    return 30 * RULES.eff(up.barrier) * dial;
  },
  barrierRegen(up) { return (6 + 3 * RULES.eff(up.barrier)) * RULES.healPow(up); },

  /* ---- taking damage ---- */
  /* Armor and the elemental resists add together as resistance POINTS before
     turning into a multiplier, which is what "additive" buys you: the second
     source is never wasted and the total can never reach immunity. */
  ELEM_KEY: { bullet: 'resBullet', fire: 'resFire', energy: 'resEnergy' },
  resistPoints(up, el) {
    let pts = 0.075 * RULES.eff(up.armor || 0);
    const k = RULES.ELEM_KEY[el];
    if (k) pts += 0.06 * RULES.eff(up[k] || 0);
    return pts;
  },
  armorMul(up, el) { return 1 / (1 + RULES.resistPoints(up, el)); },
  resistPct(up, el) { return 1 - RULES.armorMul(up, el); },
  /* Traps only. Standing on the spikes is a different problem to being shot. */
  trapMul(up) { return 1 / (1 + 0.08 * RULES.eff(up.trapres || 0)); },
  toughMul(up) { return 1 / (1 + 0.1 * RULES.eff(up.tough)); },
  dodgeChance(up) { return RULES.chance(up.dodge, RULES.DODGE_MAX); },
  deflectChance(up) { return RULES.chance(up.deflect, RULES.DODGE_MAX); },

  /* ---- everything else ---- */
  gripMul(up)  { return 1 / (1 + 0.13 * RULES.eff(up.grip)); },
  hasteMul(up) { return 1 / (1 + 0.07 * RULES.eff(up.haste)); },
  respawnMs(set, up) { return set.respawn * 1000 / (1 + 0.13 * RULES.eff(up.revive)); },
  momentumMul(up, msSinceHurt) {
    if (!up.momentum) return 1;
    const e = RULES.eff(up.momentum);
    const secs = Math.min(10, msSinceHurt / 1000);
    return 1 + Math.min(0.13 * e, 0.026 * e * secs);
  },

  /* ---- escaping ---- */
  /* Reaching the END is no longer enough: you have to hold it. The timer runs
     while you stand on an END tile and resets the moment you step off, so a
     defended END is a real fight instead of a touch. */
  escapeMs(set, laps, lockdown) {
    return Math.max(100, (set.escapeBase + (laps || 0) * set.escapeLap + 0.35 * (lockdown || 0)) * 1000);
  },

  /* ==================================================== runner abilities */
  ability: {
    dash:   lv => { const e = RULES.abEff(lv); return { cd: 4500 * Math.pow(0.9, e - 1), dur: 160 + 14 * (e - 1) }; },
    emp:    lv => { const e = RULES.abEff(lv); return { cd: 12000 * Math.pow(0.92, e - 1), radius: 120 + 36 * (e - 1), dur: 2500 + 260 * (e - 1) }; },
    /* Nerfed hard: it hides you from towers, it does not make you immune, it
       flickers when a trap bites, and it does nothing at all on the END tile. */
    ghost:  lv => { const e = RULES.abEff(lv); return { cd: 13000 * Math.pow(0.9, e - 1), dur: 1000 + 120 * (e - 1) }; },
    blink:  lv => { const e = RULES.abEff(lv); return { cd: 8000 * Math.pow(0.92, e - 1), dist: 120 + 18 * (e - 1) }; },
    shield: lv => { const e = RULES.abEff(lv); return { cd: 15000 * Math.pow(0.93, e - 1), amount: 38 * e, dur: 6000 }; },
    decoy:  lv => { const e = RULES.abEff(lv); return { cd: 18000 * Math.pow(0.93, e - 1), hp: 55 * e, dur: 5000 }; },
    surge:  lv => { const e = RULES.abEff(lv); return { cd: 14000 * Math.pow(0.92, e - 1), mul: 2.0 + 0.12 * (e - 1), dur: 2000 + 180 * (e - 1) }; },
    medkit: lv => { const e = RULES.abEff(lv); return { cd: 20000 * Math.pow(0.93, e - 1), heal: 38 * e }; },
    /* Two blocks is 80px on a 40px grid. Heals you and everyone near you. */
    nova:   lv => { const e = RULES.abEff(lv); return { cd: 17000 * Math.pow(0.92, e - 1), heal: 26 * e, radius: 80 }; },
  },

  /* =========================================================== the ultimate */
  /* One slot, one choice, one very long cooldown. The potency is the selected
     buff raised to the 2.5, which is why a level of ultimate is worth so much
     more than a level of anything else -- and why each one is capped, because
     a 30x move speed is not a super buff, it is a crash. */
  ULT_EXP: 2.5,
  ULT_DUR: 5000,
  ULT_CD: 90000,
  ULTS: {
    flash:   { name: 'Flash Step',  icon: '⚡', stat: 'speed',   cap: 4.0,  color: '#fde047',
      desc: 'Your speed explodes. Nothing in the world is aiming fast enough.' },
    iron:    { name: 'Iron Will',   icon: '🛡', stat: 'armor',   cap: 20,   color: '#93c5fd',
      desc: 'Damage taken is divided into almost nothing.' },
    wind:    { name: 'Second Wind', icon: '💚', stat: 'heal',    cap: 30,   color: '#4ade80',
      desc: 'Every drop of healing you have goes vertical.' },
    aegis:   { name: 'Aegis',       icon: '🔷', stat: 'barrier', cap: 25,   color: '#38bdf8',
      desc: 'Barrier refills instantly and multiplies.' },
    clock:   { name: 'Overclock',   icon: '⏱', stat: 'haste',   cap: 12,   color: '#c084fc',
      desc: 'Every cooldown collapses. Use everything.' },
    unstop:  { name: 'Unstoppable', icon: '🏃', stat: 'grip',    cap: 2.2,  color: '#fb923c',
      desc: 'Immune to slows and roots, and faster with it.' },
  },
  ultPotency(lv) { return Math.pow(1 + 0.6 * RULES.abEff(lv), RULES.ULT_EXP); },
  ultMul(key, lv) {
    const u = RULES.ULTS[key];
    if (!u || !lv) return 1;
    return Math.min(u.cap, RULES.ultPotency(lv));
  },
  ultCd(up) { return RULES.ULT_CD * RULES.hasteMul(up); },

  /* ================================================================== text */
  /* A one-line summary of what a building does at its current upgrades. */
  statLine(def, up, set) {
    up = up || {};
    const out = [];
    if (def.dmg) out.push('dmg ' + Math.round(RULES.dmg(def, up, set)));
    if (def.dps) out.push(Math.round(RULES.dmg(def, up, set)) + '/s');
    if (def.rate) out.push(RULES.rate(def, up).toFixed(1) + ' shots/s');
    if (def.range) out.push('range ' + Math.round(RULES.range(def, up)));
    if (def.minRange) out.push('blind under ' + def.minRange);
    if (def.slow) out.push('slow ' + Math.round(RULES.slow(def, up) * 100) + '%');
    if (def.root) out.push('root ' + RULES.root(def, up).toFixed(1) + 's');
    if (def.splash) out.push('splash ' + Math.round(RULES.splash(def, up)));
    if (def.chain) out.push('chains ' + def.chain);
    if (def.rampMax) out.push('ramps to x' + def.rampMax);
    if (def.cd) out.push('every ' + RULES.cooldown(def, up).toFixed(1) + 's');
    if (def.once) out.push('single use');
    if (def.el) out.push(def.el);
    return out.join(' · ');
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = RULES;
