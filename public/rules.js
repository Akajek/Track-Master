/* TRACK MASTER -- the numbers, in one place.
 *
 * Both sides need these: the server to apply them and the client to show them
 * on buttons before you click. Keeping two copies in sync by hand is how a menu
 * ends up promising 120 gold and the server charging 140, so this file is
 * loaded by the browser as a plain script and required by the server.
 *
 * Nothing here is capped. Levels go up forever; the costs are what grow.
 */
'use strict';
const RULES = {
  /* ---------------------------------------------------------------- costs */
  upgradeCost(set, def, lv) {
    const base = (1 + lv * 0.5) * Math.pow(1.06, lv) * (def.kind === 'ability' ? 2 : 1);
    return Math.max(1, Math.round(base * set.upGrow / 100));
  },
  buildCost(set, def) { return Math.max(1, Math.round(def.cost * set.towerCost / 100)); },
  /* Upgrades are exponential: a building's Nth upgrade costs 18% more than its
     N-1th, whichever track it goes on. Pricing by the building's total rather
     than by the track keeps every building the same distance from its final
     form -- otherwise a trap with one track would need thirty levels on that
     one track and could never realistically get there. */
  TRACK_EXP: 1.18,
  trackCost(set, def, totalUpgrades) {
    return Math.max(1, Math.round(def.cost * 0.6 * Math.pow(RULES.TRACK_EXP, totalUpgrades) * set.twGrow / 100));
  },
  sellValue(spent) { return Math.round(spent * 0.7); },

  /* ---------------------------------------------------------------- forms */
  /* Buildings do not have a level. They have a FORM, and they change shape
     every five upgrades: at 5, 10, 15, 20, 25 and 30 total upgrades across all
     of their tracks. Past the last form the shape stops changing and further
     upgrades only feed the stats. */
  FORM_STEP: 5,
  MAX_FORM: 6,
  upgrades(up) { let n = 0; for (const k in up) n += up[k] || 0; return n; },
  form(up) { return Math.min(RULES.MAX_FORM, Math.floor(RULES.upgrades(up) / RULES.FORM_STEP)); },
  /* How many more upgrades until the next shape; 0 once the last form is out. */
  toNextForm(up) {
    const f = RULES.form(up);
    if (f >= RULES.MAX_FORM) return 0;
    return (f + 1) * RULES.FORM_STEP - RULES.upgrades(up);
  },
  formName(def, up) { return (def.forms && def.forms[RULES.form(up)]) || def.name; },

  /* --------------------------------------------------------- tower stats */
  /* Each new form is worth a bonus of its own on top of the tracks, so growing
     a shape is always a real step up and not just a new coat of paint. */
  dmg(def, up)   { return (def.dmg || def.dps || 0) * Math.pow(1.25, up.dmg || 0) * Math.pow(1.18, RULES.form(up)); },
  range(def, up) { return (def.range || 0) * Math.pow(1.12, up.rng || 0) * Math.pow(1.05, RULES.form(up)); },
  rate(def, up)  { return (def.rate || 0) * Math.pow(1.18, up.spd || 0) * Math.pow(1.07, RULES.form(up)); },
  slow(def, up)  { return 1 - (1 - (def.slow || 0)) * Math.pow(0.88, up.pow || 0); },
  root(def, up)  { return (def.root || 0) * Math.pow(1.15, up.pow || 0); },
  splash(def, up) { return (def.splash || 0) * Math.pow(1.12, up.pow || 0); },
  /* Projectile speed. Only the buildings that actually launch something have a
     Velocity track; beams and hitscan shots arrive the instant they are fired. */
  proj(def, up) { return (def.proj || 0) * Math.pow(1.2, up.vel || 0); },
  /* Traps that re-arm: the Rate track and each form shorten the wait. */
  cooldown(def, up) {
    return (def.cd || 0) / (Math.pow(1.18, up.spd || 0) * Math.pow(1.07, RULES.form(up)));
  },

  /* -------------------------------------------------------- runner stats */
  speed(set, up, laps) { return set.runSpeed * Math.pow(1.09, up.speed) * (1 + laps * set.lapBonus / 100); },
  maxHp(set, up, laps) { return 100 + 25 * up.hp + laps * set.lapBonus; },
  armorMul(up) { return 1 / (1 + 0.07 * up.armor); },
  gripMul(up)  { return 1 / (1 + 0.15 * up.grip); },
  hasteMul(up) { return 1 / (1 + 0.08 * up.haste); },
  toughMul(up) { return 1 / (1 + 0.12 * up.tough); },
  respawnMs(set, up) { return set.respawn * 1000 / (1 + 0.15 * up.revive); },
  momentumMul(up, msSinceHurt) {
    if (!up.momentum) return 1;
    const secs = Math.min(10, msSinceHurt / 1000);
    return 1 + Math.min(0.15 * up.momentum, 0.03 * up.momentum * secs);
  },

  /* ------------------------------------------------------ runner abilities */
  ability: {
    dash:   lv => ({ cd: 4500 * Math.pow(0.88, lv - 1), dur: 160 + 15 * (lv - 1) }),
    emp:    lv => ({ cd: 12000 * Math.pow(0.9, lv - 1), radius: 120 + 40 * (lv - 1), dur: 2500 + 300 * (lv - 1) }),
    ghost:  lv => ({ cd: 10000 * Math.pow(0.88, lv - 1), dur: 1500 + 200 * (lv - 1) }),
    blink:  lv => ({ cd: 8000 * Math.pow(0.9, lv - 1), dist: 120 + 20 * (lv - 1) }),
    shield: lv => ({ cd: 15000 * Math.pow(0.92, lv - 1), amount: 40 * lv, dur: 6000 }),
    decoy:  lv => ({ cd: 18000 * Math.pow(0.92, lv - 1), hp: 60 * lv, dur: 5000 }),
    surge:  lv => ({ cd: 14000 * Math.pow(0.9, lv - 1), mul: 2.2 + 0.15 * (lv - 1), dur: 2000 + 200 * (lv - 1) }),
    medkit: lv => ({ cd: 20000 * Math.pow(0.92, lv - 1), heal: 40 * lv }),
  },

  /* A one-line summary of what a building does at its current upgrades, used
     on the selected-tower panel and in the build menu. */
  statLine(def, up) {
    up = up || {};
    const out = [];
    if (def.dmg) out.push('dmg ' + Math.round(RULES.dmg(def, up)));
    if (def.dps) out.push(Math.round(RULES.dmg(def, up)) + '/s');
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
    return out.join(' · ');
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = RULES;
