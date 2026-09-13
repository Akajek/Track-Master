# Track Master

Asymmetric multiplayer tower defense for a few friends in a browser.

- **The Mastermind** (one player) draws the track, then buys towers, traps and
  abilities to stop the runners. Gold trickles in over time and every kill pays.
- **The Runners** (everyone else) control a little blob with WASD and try to get
  from START to END alive. Every finish gives upgrade points; dying gives a pity
  point. Points buy speed, health, regen, armor, a dash, an EMP that disables
  towers, and a ghost mode.

Nothing about it is balanced. That is the point.

## Run it locally

```bash
npm install
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
that takes ~30-60 seconds to wake up. Rooms live in memory, so a redeploy or a
sleep wipes them (players just rejoin with the same code and the Mastermind
rebuilds; the track is quick to draw).

`render.yaml` pins the region to `frankfurt`. Change it before the first deploy
if the players are elsewhere; Render cannot move a service afterwards.

## How to play

### Mastermind

| | |
|---|---|
| **EDIT TRACK / GO LIVE** | Editing pauses the runners at the start. Going live needs a START, an END and a connected path. |
| Path brush / Eraser | Click-drag on the grid. |
| Set START / Set END | One of each. Setting a new one turns the old one into plain path. |
| Presets | Snake, Zigzag, or clear everything. |
| Towers | Go on empty ground. Turret, Sniper, Frost (slow aura), Mortar (splash, blind up close), Tesla (chains), Flamer (short range burn). |
| Traps | Go on the path. Spikes (bite on step), Glue (very slow). |
| Click a tower | Select it: upgrade (up to level 4) or sell (70% back). Right-click sells instantly. |
| Meteor | Costs gold, click anywhere, lands after 1s with splash damage. |
| Freeze | Costs gold, every runner stops for 1.6s. |
| Hotkeys | `1`–`8` pick tower, `U` upgrade selected, `X` sell selected, `Esc` deselect. |

Gold: starts at 400, +8/s while live, +60 per kill, +30 per runner finish.

### Runner

| | |
|---|---|
| `WASD` / arrows | Move. You can only walk on the path. |
| `Space` | Dash (after buying it). |
| `E` | EMP: disables every tower nearby for 2.5s (after buying it). |
| `Q` | Ghost: 1.5s of invulnerability (after buying it). |
| Finish | +3 points, full heal, back to start. |
| Die | +1 point, respawn at start after 2.5s. |

Upgrade costs grow slowly: 1, 1, 2, 2, 3, 3... points per level.

If the Mastermind leaves, the seat opens and any runner can take it from the
top bar. The Mastermind can also step down and become a runner.

## Files

- `server.js` — serves the page and runs every room. Authoritative simulation
  at 20 ticks/s; clients only send intentions.
- `public/index.html` — the whole client: lobby, canvas renderer, both sidebars.
- `test/game.test.js` — end-to-end test that boots the server and plays a round
  with a Mastermind and a Runner over real WebSockets. Run with `npm test`.
- `render.yaml` — Render blueprint.
