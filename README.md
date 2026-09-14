# Track Master

Asymmetric multiplayer tower defense for a few friends in a browser.

- **The Mastermind** (one player) draws the track, then buys towers, traps and
  abilities to stop the runners. They score a **victory point** every time a
  runner dies.
- **The Runners** (everyone else) control a blob with WASD and try to get from a
  START to an END alive — and then *hold* that END long enough to escape. Every
  escape scores a **victory point** for their side.

First side to the victory target wins the round. Then the board resets and the
Mastermind builds again.

Nothing about it is balanced. That is the point.

## Run it locally

```bash
npm install
```

```bash
npm start
```

Open http://localhost:8080. The first person picks **Mastermind**, copies the
room link from the top bar and sends it to the others, who join as **Runner**.

## Deploy on Render (free tier)

1. Push this folder to a GitHub repository.
2. On https://dashboard.render.com choose **New → Blueprint**, pick the repo.
   Render reads `render.yaml` and creates the `track-master` web service.
3. Wait for the first deploy, open the service URL, share it.

The free instance sleeps after 15 minutes without traffic; the first visit after
that takes 30-60 seconds to wake up. Rooms live in memory, so a redeploy or a
sleep wipes them. Players just rejoin with the same code.

`render.yaml` pins the region to `frankfurt`. Change it before the first deploy
if the players are elsewhere; Render cannot move a service afterwards.

## The shape of a round

The two sides are deliberately pointed in opposite directions over time.

**The Mastermind starts poor and ends terrifying.** They open the game owning a
Turret, Spikes, Glue and the Meteor and nothing else — the Sniper, the Laser,
the Mine and the rest are locked behind the **armoury**. Buildings cost more
than they used to. But upgrades get *relatively* cheaper the further a building
goes, forms keep compounding, and gold buys permanent Mastermind upgrades.

**A runner starts strong and flattens out.** They begin with more health than
before and cheap early levels, but every upgrade curve bends: past level 15 each
level buys less than the one before, forever. Speed bends hardest, because
unlimited speed was not an upgrade, it was a teleport.

## Diminishing returns

Nothing is hard capped and nothing is unlimited. Levels climb forever; what they
*buy* converges.

| | Full value to | Then |
|---|---|---|
| Passive upgrades | level 15 | each level worth less than the last, approaching +12 more, never reaching it |
| Speed | level 15 | a much harsher curve of its own |
| Abilities | level 5 | barely move past it |
| Dodge, Deflection | — | **share** one **35%** ceiling: levels in either push the same curve, and together they never pass it |

The game says all of this out loud. Every upgrade button past its soft cap is
marked `diminishing` and shows its **effective** level next to its real one, the
runner sidebar has a **Your numbers** panel with the live value of every stat,
and a **How levelling works** section spells out the curves.

## The armoury

The Mastermind earns the rest of their arsenal by hurting people. Damage dealt
to runners fills a bar; each time it fills, they get one **unlock point**, which
buys any one locked tower, trap or ability. Each point costs more damage than
the last, so the armoury opens across a whole game rather than in the first
thirty seconds. Damage absorbed by a shield or a barrier still counts — a runner
who hides behind a barrier must not be able to starve the bar.

`Damage per unlock %` in game setup scales the whole schedule if you want a
faster or slower opening.

## Game setup

The **Game setup** panel has a slider for every knob (and a toggle for the
on/off ones), including a **map size slider** (12x10 up to 48x32 tiles). Map
size only changes while the track is in edit mode; everything else can change
mid-round.

| Group | What it controls |
|---|---|
| Map | Board width and height, **Several STARTs and ENDs** on or off, and how much steep ground slows a runner. |
| Balance | **Tower damage %** and **Runner health %**, the two dials to reach for first if a round feels one-sided, plus base runner speed and respawn time. |
| Escape | How long a runner must hold an END to escape, how much longer that gets per win they bank, and how much damage the END tile shrugs off for them. |
| Victory | Points needed to win, and how many a finish or a kill is worth. |
| Income | Mastermind starting gold, gold per second, how fast income grows per minute, the bonus per kill and per finish, and how much damage an unlock point costs. |
| Runners | Upgrade points per finish and per death, the lap bonus each finish banks, and how many free ability slots a runner gets. |
| Scaling | How fast runner upgrades, tower upgrades and tower build costs climb. |

### How a building upgrade is priced

Two things set the price.

The building's **total** upgrades set the base, climbing steeply at first and
then flattening off — the late game is where the Mastermind is meant to get
frightening, so the thirtieth upgrade must not cost a hundred times the first.

On top of that, each track is priced **relative to that building's average**: a
track you have never touched is cheap, and a track you have poured everything
into is dear. Relative rather than absolute, so a one-track trap — where that
one track *is* the average — is never punished for having nowhere else to spend.

The cost formulas live in `public/rules.js`, which the server requires and the
browser loads, so a button never promises a price the server will not honour.

## Balance

The rule the numbers follow: **a weapon you cannot dodge hits softer than one
you can.** The turret has the highest damage per second of any tower and is also
the only one whose shots you can sidestep. Sniper, Tesla, Pulse, Laser and
Flamer all land automatically, and all do less. The Sniper in particular costs
260 gold — nearly five turrets — because one of them used to end a round.

There is a probe for checking this rather than guessing. It boots the server,
opens the armoury, builds a defence on a straight track, and runs a
point-spending runner into it for a minute:

```bash
npm run balance
```

At the time of writing it reports, per sixty seconds:

| Defence | Runner laps | Runner deaths |
|---|---|---|
| One sniper (256g) | 10 | 0 |
| Six snipers (1,556g) | 6 | 4 |
| Mixed turrets, snipers and traps (816g) | 6 | 3 |
| The same mixed defence at 200% tower damage | 0 | 9 |
| The same at 50% tower damage | 9 | 0 |

So a lone tower is a nuisance, a real investment is a genuine fight, and the
Tower damage dial swings a round decisively in either direction if your group
wants it harder or softer.

## The ability bar

Both roles get the same HUD under the board: one slot per ability, with its
icon, its key, what it costs, and a dark wedge that sweeps away as the cooldown
runs down. Click a slot or press its key.

A Mastermind sees their abilities and the gold each needs; a locked one shows a
padlock and clicking it spends an unlock point. A runner sees all nine of
theirs, greyed out until bought with the unlock price on the slot, plus the one
**ultimate** slot on the end, which glows in the colour of whichever SUPER BUFF
is loaded and pulses while it is running.

## How to play

### Mastermind

Editing the track parks the runners at the start. Going live needs every START
to have a walkable route to some END.

| | |
|---|---|
| Track tools | Path brush, eraser, **steep brush**, **tunnel brush**, set START, set END, and Snake / Zigzag / Spiral presets that fit whatever map size you picked. |
| Steep ground | Path you climb slowly. Traps still go on it — it is path, just harder path. How much it slows is a slider. |
| Tunnels | Tunnel mouths pair up in reading order: the first links to the second, the third to the fourth, and the board draws the pair number on each one. Step into one and come out of the other. A tunnel fires when you walk *into* it, not for as long as you stand in it, so the far mouth is somewhere to stop and think. An odd mouth left without a partner is drawn dashed and red with a `?`. |
| Several STARTs and ENDs | Off by default, and painting a new one replaces the old. Turn it on in game setup and every START and END you paint stays: runners spawn at a random START and may escape from any END. |
| Speed painting | Hold `Shift` and drag to lay a whole line of anything in one motion, or to sell a line with the right button. The line is filled in between mouse samples, so dragging fast leaves no gaps. |
| Bucket fill | Pick a building, turn the bucket on, click the board. It spreads outwards from that tile onto every tile that will take one until the gold runs out. The cursor shows how many you can afford. |
| Select area | Drag a rectangle. While one is set, mass upgrades and Sell only touch what is inside it. `Esc` clears it. |
| Mass upgrade | Every track row in a building's panel has an **all N** button: it raises that track on every building of the same type at once and charges the whole bill in one go, cheapest first if you cannot cover all of them. |
| Towers (empty ground) | Turret, Sniper, Mortar (splash, blind up close), Tesla (chains), Pulse (hits everything around it, never misses), Laser (beam that burns hotter the longer it holds), Flamer, Frost (slow aura). |
| Traps (path or steep) | Spikes, Glue, Saw, Mine (one big blast, then gone), Snare (roots you), Portal (back to a start), **Brazier** (a column of fire), **Jolt Plate** (an energy discharge). |
| Elements | Every damaging building deals **bullet**, **fire** or **energy** damage, and runners can buy a resist for each on top of plain Armor. |
| Aim | Turret bolts and mortar shells are real objects: they take time to arrive and they lead their target. Hold one direction and a shot will meet you; change direction and it sails past. Both sell a **Velocity** track. Beams and hitscan shots land the instant they fire, so they have no Velocity track and cannot be dodged. |
| Upgrades | Click a building to open its panel. Each has its own tracks: Damage, Range, Rate, Power or Velocity. Every track is uncapped. |
| Forms | Buildings do not have a level. They have a **form**, and they grow into a new one every five upgrades: at 5, 10, 15, 20, 25 and 30. Each form looks different, has its own name, and carries a stat bonus of its own. Past 30 the shape stops changing and upgrades only feed the stats. |
| Abilities | Meteor, Barrage (six shells), Freeze, Overdrive (every tower fires double time), Blackout (runners lose every ability). |
| Mastermind upgrades | Bought with gold, kept for the round, and the late-game teeth: **Lockdown** (+0.35s on the END hold), **Siege** (+8% damage on everything you own), **Bounty** (+25% gold per kill). |
| Hotkeys | `1`-`9` pick a building, `X` sells the selected one, right-click sells, `Esc` clears the tool, the selection and the area. |

### Runner

Reaching an END is not enough. The escape clock starts when you step onto one
and **resets the instant you step off** — so a defended END is a fight, not a
touch. It starts at half a second, grows every time you win, and grows again
every time the Mastermind buys Lockdown. To make holding it possible at all, an
END tile gives you damage resistance while you stand on it (a slider, 40% by
default).

Every escape gives a victory point, upgrade points, a full heal, a free shield,
and a **permanent** lap bonus to speed and max HP. Dying gives you a pity point
and the Mastermind a victory point.

#### Ability slots

You start with four slots and every ability you own takes one. A fifth ability
needs a slot bought first, and each slot costs more than the last. Dropping an
ability hands most of its points back and frees the slot again, so one bad pick
is a setback and not a dead save — the ✕ beside each ability shows exactly what
it would refund, and it stays usable when you are too poor to level anything,
which is when you most want it.

| | |
|---|---|
| `WASD` / arrows | Move. You can only walk on the path, and changing direction dodges incoming bolts. |
| `Space` | Dash |
| `E` | EMP: disables nearby towers |
| `Q` | Ghost: towers cannot see you — but traps still bite, a trap makes you flicker back into view, and it does nothing at all on an END tile |
| `F` | Blink: teleport forward along the path |
| `R` | Shield: absorb a chunk of damage |
| `C` | Decoy: towers shoot your double instead |
| `V` | Surge: big speed boost |
| `X` | Medkit: heal instantly |
| `Z` | **Healing Nova**: heals you and every runner within two blocks |
| `G` | **The ultimate** |

#### The ultimate

One slot, one SUPER BUFF, one very long cooldown. Pick which stat it hits —
Flash Step (speed), Iron Will (armor), Second Wind (healing), Aegis (barrier),
Overclock (cooldowns) or Unstoppable (nothing slows or roots you) — and for five
seconds that stat is raised to the power of **2.5**. Each one is capped at its
own ceiling, because a thirty times move speed is not a super buff, it is a
crash. Levelling the ultimate raises the potency sharply, and it is priced to
match.

#### Passive upgrades

Speed, Vitality, **Regen** (which heals you while you are being shot, not only
once you are left alone), **Field Medic** (much stronger healing, but only once
nothing has touched you for 2.5s), **Healing Power** (multiplies every source of
healing you have), **Barrier** (a second bar that eats damage before your health
and grows back out of combat — a little smaller per level than Vitality,
because it repairs itself), Armor, **Bullet / Fire / Energy Resist** (which
add on top of Armor rather than multiplying with it, so the second one you buy
is never wasted), **Trap Resist** (damaging traps only), **Dodge** (a bullet
passes straight through you), **Deflection** (you bat it back the way it came),
Grip (resist slows, glue and steep ground), Haste, Momentum, Scholar, Quick
Revive and Last Stand.

Dodge and Deflection share a single 35% ceiling rather than having one each —
two independent 35% rolls come out at 58%, which is not a 35% ceiling. Levels in
either push the same curve, and which flavour you get on a miss follows whichever
you have put more into.

If the Mastermind leaves, the seat opens and any runner can take it from the top
bar. The Mastermind can also step down and become a runner.

## Sound and visual effects

Every sound is generated in the browser with the Web Audio API: no audio files
in the repo, nothing extra to download, nothing extra for Render to serve. Each
tower, trap and ability has its own voice, panned to where it happens on the
board. Holding an END ticks like a clock that speeds up as the bar fills. The
speaker button and slider in the top bar control it, `M` toggles it, and both
settings are remembered per browser.

Visual effects run on a small particle, ring, beam and floating-text engine with
additive blending, screen shake and screen flashes. Every event the server can
send has a matching effect, and the test suite checks that.

## Files

- `server.js` — serves the page and runs every room. Authoritative simulation at
  20 ticks/s; clients only send intentions.
- `public/rules.js` — every cost, stat and diminishing-returns curve, shared by
  the server and the browser so the two can never disagree.
- `public/index.html` — page shell and styles.
- `public/game.js` — networking, both sidebars, input, and the renderer.
- `public/vfx.js` — the effects engine.
- `public/audio.js` — every sound, synthesized at runtime.
- `test/game.test.js` — boots the server and plays a full game over real
  WebSockets: settings, map resizing, the armoury, steep ground, tunnels,
  several STARTs and ENDs, the END hold, victory points, diminishing returns,
  ability slots, the ultimate, the healing nova, the barrier, elemental resists,
  the ghost nerf, Mastermind upgrades, every trap, tower upgrade tracks and
  pricing, the six form changes, healing under fire, and a win. It also checks
  the client files are served, that every sound the client asks for exists, and
  that every server event has a visual effect. Run with `npm test`.
- `tools/balance-probe.js` — the balance readout above. `npm run balance`.
- `render.yaml` — Render blueprint.
