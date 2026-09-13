# Track Master

Asymmetric multiplayer tower defense for a few friends in a browser.

- **The Mastermind** (one player) draws the track, then buys towers, traps and
  abilities to stop the runners. They score a **victory point** every time a
  runner dies.
- **The Runners** (everyone else) control a blob with WASD and try to get from
  START to END alive. Every finish scores a **victory point** for their side.

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

## Game setup

The Mastermind's **Game setup** panel has a slider for every knob, including a
**map size slider** (12x10 up to 48x32 tiles). Map size only changes while the
track is in edit mode; everything else can change mid-round.

| Group | What it controls |
|---|---|
| Map | Board width and height in tiles. |
| Balance | **Tower damage %** and **Runner health %**, the two dials to reach for first if a round feels one-sided, plus base runner speed and respawn time. |
| Victory | Points needed to win, and how many a finish or a kill is worth. |
| Income | Mastermind starting gold, gold per second, how fast income grows per minute, and the bonus per kill and per runner finish. |
| Runners | Upgrade points per finish and per death, and the lap bonus each finish banks. |
| Scaling | How fast runner upgrades, tower upgrades and tower build costs climb. |

A building's Nth upgrade costs 18% more than its N-1th, whichever track it goes
on. Pricing by the building's total rather than per track keeps every building
the same distance from its final form: a one-track trap would otherwise need
thirty levels on that single track and could never realistically get there.
Growing one turret all the way is roughly 24,000 gold at default settings, so a
final form is a whole-game goal rather than a purchase.

The cost formulas live in `public/rules.js`, which the server requires and the
browser loads, so a button never promises a price the server will not honour.

## Balance

The rule the numbers follow: **a weapon you cannot dodge hits softer than one
you can.** The turret has the highest damage per second of any tower and is also
the only one whose shots you can sidestep. Sniper, Tesla, Pulse, Laser and
Flamer all land automatically, and all do less.

There is a probe for checking this rather than guessing. It boots the server,
builds a defence on a straight track, and runs a point-spending runner into it
for a minute:

```bash
npm run balance
```

At the time of writing it reports, per sixty seconds:

| Defence | Runner laps | Runner deaths |
|---|---|---|
| One sniper (146g) | 21 | 0 |
| Six snipers (896g) | 4 | 7 |
| Mixed turrets, snipers and traps (566g) | 8 | 4 |
| The same mixed defence at 200% tower damage | 0 | 11 |
| The same at 50% tower damage | 19 | 0 |

So a lone tower is a nuisance, a real investment is a threat, and the Tower
damage dial swings a round decisively in either direction if your group wants it
harder or softer.

## The ability bar

Both roles get the same HUD under the board: one slot per ability, with its
icon, its key, what it costs, and a dark wedge that sweeps away as the cooldown
runs down. Click a slot or press its key.

A Mastermind sees their five abilities and the gold each needs; a slot dims when
they cannot afford it and lights up when it is ready. A runner sees all eight of
theirs, greyed out until bought with the unlock price on the slot, so clicking a
locked one buys it.

## How to play

### Mastermind

Editing the track parks the runners at the start. Going live needs a START, an
END and a connected path between them.

| | |
|---|---|
| Track tools | Path brush, eraser, set START, set END, and Snake / Zigzag / Spiral presets that fit whatever map size you picked. |
| Speed painting | Hold `Shift` and drag to lay a whole line of anything in one motion, or to sell a line with the right button. The line is filled in between mouse samples, so dragging fast leaves no gaps. |
| Bucket fill | Pick a building, turn the bucket on, click the board. It spreads outwards from that tile onto every tile that will take one until the gold runs out. The cursor shows how many you can afford. |
| Select area | Drag a rectangle. While one is set, mass upgrades and Sell only touch what is inside it. `Esc` clears it. |
| Mass upgrade | Every track row in a building's panel has an **all N** button: it raises that track on every building of the same type at once and charges the whole bill in one go, cheapest first if you cannot cover all of them. |
| Towers (empty ground) | Turret, Sniper, Mortar (splash, blind up close), Tesla (chains), Pulse (hits everything around it, never misses), Laser (beam that burns hotter the longer it holds), Flamer, Frost (slow aura). |
| Aim | Turret bolts and mortar shells are real objects: they take time to arrive and they lead their target. Hold one direction and a shot will meet you; change direction and it sails past. Both sell a **Velocity** track to make them harder to dodge. Beams and hitscan shots (Laser, Sniper, Tesla, Pulse) land the instant they fire, so they have no Velocity track and cannot be dodged. |
| Traps (on the path) | Spikes, Glue, Saw (shreds anyone standing on it), Mine (one big blast, then gone), Snare (roots you in place), Portal (sends you all the way back to START). |
| Upgrades | Click a building to open its panel. Each has its own tracks: Damage, Range, Rate or Power. Every track is uncapped. |
| Forms | Buildings do not have a level. They have a **form**, and they grow into a new one every five upgrades: at 5, 10, 15, 20, 25 and 30. Each form looks different, has its own name, and carries a stat bonus of its own. Past 30 the shape stops changing and upgrades only feed the stats. |
| Abilities | Meteor, Barrage (six shells), Freeze, Overdrive (every tower fires double time), Blackout (runners lose every ability). |
| Hotkeys | `1`-`9` pick a building, `X` sells the selected one, right-click sells, `Esc` clears the tool, the selection and the area. |

### Runner

Every finish gives a victory point, upgrade points, a full heal, a free shield,
and a **permanent** lap bonus to speed and max HP. Dying gives you a pity point
and the Mastermind a victory point.

| | |
|---|---|
| `WASD` / arrows | Move. You can only walk on the path, and changing direction dodges incoming bolts. |
| `Space` | Dash |
| `E` | EMP: disables nearby towers |
| `Q` | Ghost: brief invulnerability |
| `F` | Blink: teleport forward along the path |
| `R` | Shield: absorb a chunk of damage |
| `C` | Decoy: towers shoot your double instead |
| `V` | Surge: big speed boost |
| `X` | Medkit: heal instantly |

Abilities have to be bought before their key does anything. Passive upgrades are
Speed, Vitality, **Regen** (which heals you while you are being shot, not only
once you are left alone), Armor, Grip (resist slows), Haste (shorter cooldowns),
Momentum (speeds up while you avoid damage), Scholar (more points per finish),
Quick Revive and Last Stand.

**Nothing is capped.** Levels climb forever; only the cost grows.

If the Mastermind leaves, the seat opens and any runner can take it from the top
bar. The Mastermind can also step down and become a runner.

## Sound and visual effects

Every sound is generated in the browser with the Web Audio API: no audio files
in the repo, nothing extra to download, nothing extra for Render to serve. Each
tower, trap and ability has its own voice, panned to where it happens on the
board. The speaker button and slider in the top bar control it, `M` toggles it,
and both settings are remembered per browser.

Visual effects run on a small particle, ring, beam and floating-text engine with
additive blending, screen shake and screen flashes. Every event the server can
send has a matching effect, and the test suite checks that.

## Files

- `server.js` — serves the page and runs every room. Authoritative simulation at
  20 ticks/s; clients only send intentions.
- `public/rules.js` — every cost and stat formula, shared by the server and the
  browser so the two can never disagree.
- `public/index.html` — page shell and styles.
- `public/game.js` — networking, both sidebars, input, and the renderer.
- `public/vfx.js` — the effects engine.
- `public/audio.js` — every sound, synthesized at runtime.
- `test/game.test.js` — boots the server and plays a full game over real
  WebSockets: settings, map resizing, victory points, uncapped upgrades, every
  ability, every trap, tower upgrade tracks, the six form changes, healing under
  fire, and a win. It also checks the client files are served, that every sound
  the client asks for exists, and that every server event has a visual effect.
  Run with `npm test`.
- `tools/balance-probe.js` — the balance readout above. `npm run balance`.
- `render.yaml` — Render blueprint.
