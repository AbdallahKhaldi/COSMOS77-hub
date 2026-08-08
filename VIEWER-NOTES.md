# VIEWER-NOTES — the arena front-end (Track C)

The 3D bodycam viewer, replay cinema, and page shells for the COSMOS77 hub.
Everything here is static + templates: **zero runtime external requests** —
every `fetch`/`WebSocket` in the code targets `/static`, `/api`, or `/ws/live`
only (three.js is vendored, fonts are self-hosted, favicons are data URIs).

## File map

```
templates/
  index.html    THE ARENA — 3D bodycam viewer + HUD + challenge drawer (+ inline bootstrap module)
  replay.html   REPLAY CINEMA — bird's-eye of settled games (legal only here)
  docs.html     challenge-us briefing: seven agreements, endpoints, 406 note, pairing generator
  league.html   ledger scoreboard shell (reads /api/status, falls back to /api/runs)
  admin.html    ops deck: login + run controls; counted-cannot-launch-from-web notice
static/css/arena.css        the design system (HW6 "COSMOS77 CITY" DNA, one generation later)
static/js/
  timeline.js   envelope log + THE ONE shared reducer applyEvent() + grid helpers (pure, no THREE/DOM)
  net.js        WS /ws/live wrapper (backoff+jitter, hello/last_seq, ping 25s) + demo fake socket + fetch helpers
  scene.js      night-NYC arena: merged/instanced city, 4-light rig, FogExp2, wet asphalt, half-res bloom, q tiers
  entities.js   cruiser (strobe lightbar + owned PointLight), thief runner, BELIEF ghost, scent decals, 14-barrier pool, trail ring
  director.js   the single rAF: burst tiers 3/12, ~20 instant-applies/frame cap, tween pool, SNAP, speed-multiplied clock, cameras
  hud.js        DOM HUD: banner, mandated belief heatmap (doubles as the 2D minimap), scent toggle, tickers, scores, drawer
  replay.js     replay driver: frames scrubber, 0.5/1/4/16x, window selector, BELIEF-vs-TRUTH overlay, Verified/TAMPERED badge
static/vendor/three-0.185.0/   three.js r185 min pair + LICENSE + addons (OrbitControls, BufferGeometryUtils, bloom chain)
static/fonts/                  Anton, Chakra Petch 400/600, Space Mono 400/700, Inter (variable) woff2 + fonts.css + OFL-NOTICE.txt
static/fixtures/demo-live.json    115 contract envelopes, one 20-move window, BOTH perspectives (see schema below)
static/fixtures/demo-replay.json  contract replay doc: 2 windows, 42 frames, 71% ghost hit-rate, 1 TAMPERED step in window 2
```

## Legality is the design

- Live page renders **one agent's local truth only**, big label
  `LOCAL TRUTH — POLICE|THIEF PERSPECTIVE`. The perspective switcher **closes**
  the socket, resets the world, and re-opens `/ws/live?perspective=<other>` —
  never two sockets, never fused frames.
- The opponent appears **only** as the labeled **BELIEF** hologram: a diffuse
  multi-cell shimmer while `confidence=fuzzy`, snapping to one solid pulsing
  cell at `confidence=exact` (still labeled BELIEF — it is our posterior,
  "belief=1.0 cell", never "opponent position").
- Bird's-eye (both true paths) exists **only** in `replay.html`, which loads
  settled games from `/api/replays/{run_id}` and says so on the stage label.

## Quality tiers (`?q=low|med|high`, default med)

| tier | DPR cap | bloom                    | shadows              |
|------|---------|--------------------------|----------------------|
| low  | 1.0     | off (no composer at all) | off                  |
| med  | 1.5     | half-res UnrealBloom     | off                  |
| high | 1.75    | half-res UnrealBloom     | PCF 1024, moon only  |

Fixed light rig: hemisphere + directional "moon" + 2 hero points + the
cruiser's owned strobe point — lights are **never** added/removed/toggled
(intensity/color animate instead), so no shader recompiles mid-run.
Draw-call ledger lands ~33 (verify in console: `arena.info()` is exposed on
the page module scope via devtools breakpoints; renderer.info.render.calls).
`prefers-reduced-motion` kills scanlines/slams/strobe flash/camera drift and
makes tweens instant.

## Demo mode (no backend needed)

- `/?demo=1` (or opening index with `?demo=1&q=med`) feeds
  `static/fixtures/demo-live.json` through a **fake socket** into the SAME
  timeline → director → HUD path as production; the perspective switcher works
  (the fixture carries both perspectives in one hub seq space and the fake
  socket filters, exactly like the server).
- `/replay/anything?demo=1` (and `/replay/<id>` when the fetch 404s → shows a
  hint) loads `static/fixtures/demo-replay.json`. Window 2 frame index ~30
  (step 9) flips the badge to TAMPERED.

## Envelope contract consumed (hub-composed)

```json
{"seq": 1, "ts": 0.0, "run_id": "…", "perspective": "police|thief",
 "type": "view|window_end|series_end|status|snapshot", "payload": {}}
```
- `seq` monotonic per RUN across both perspectives ⇒ a one-perspective socket
  legitimately sees **gaps**; the client dedupes with a monotonic filter and
  never waits for gaps. A changed `run_id` resets the client log.
- `view` payload = the events.jsonl line verbatim (contract): `t, role,
  sub_game, step, banner("YOUR TURN"|"LOCKED"), self_pos[r,c], barriers[[r,c]…],
  barriers_left, posterior{"r,c":p}, perceived_scent{"r,c":v}, confidence
  ("exact|fuzzy|none"), hints[str…]` — plus OPTIONAL `commit` (40-hex) which,
  when present, feeds the commit-hash ticker. If Track A/B never adds it the
  ticker shows "no sealed moves yet" (graceful).
- `snapshot` payload: either a bare view, or `{view, scores{us,them}, window,
  windows_total, pips?}` — both accepted.
- `window_end` payload (assumed, composed by hub from log_*_gNN.json):
  `{window, result("capture|survival|tie"), us, them, winner?, settled}` —
  `us/them` are from the SOCKET's perspective. Reducer is defensive: also
  accepts `{scores:{us,them}}` or `sub_game` for the window number.
- `series_end` payload: `{verdict, us, them, settled, replay?}`.
- `status` payload: `{line, agents{cop,thief}, run_active}` — `line` lands in
  the radio ticker; used in attract mode.
- On WS open the client sends `{"type":"hello","last_seq":N}` and expects one
  snapshot + the tail; it also sends `{"type":"ping"}` every 25 s (server may
  ignore).

## Replay document consumed (`GET /api/replays/{run_id}`)

Contract shape, plus the meta keys the cinema uses:
```json
{"meta": {"run_id","gid_a","gid_b","role","kind","windows",
          "score":{"us","them"},
          "per_window":[{"window","result","us","them"}],
          "verdict","settled"},
 "frames":[{"step","window","cop":[r,c],"thief":[r,c],"barriers":[[r,c]…],
            "commit_ok":true,"scent":{"r,c":v},"hint":"…|null"}],
 "verify":{"per_step":[true,…],"verdict":"Verified OK|TAMPERED"},
 "belief_trace":[{"step","ghost":[r,c]|null,"confidence"}]}
```
Alignment assumption: `verify.per_step[i]` and `belief_trace[i]` align with
`frames[i]` (same length). Hit-rate = share of frames where `ghost == thief`.

## Other endpoints consumed (defensive readers)

- `GET /api/status` → `{endpoints:{cop,thief}}` (also accepts `urls` /
  `cop_url`/`thief_url`) for the copy-button rows; optional
  `{ledger:{counted,wins,friendlies,verified}, runs:[…], line}` for /league
  and the status bar. Missing keys degrade to placeholders, never crash.
- `POST /api/challenge` body
  `{kind:"f1"|"f2", opponent_gid, their_cop_url|null, their_thief_url|null,
  their_single_url|null}` → expects `{run_id, watch_url}`; non-2xx bodies with
  `{detail|error}` are surfaced verbatim in the drawer.
- `POST /api/pair` body `{opponent_gid, their_cop_url, their_thief_url,
  windows}` → response JSON rendered as the packet (docs page).
- `GET /api/runs` (league fallback) → `[{run_id, opponent_gid, kind,
  score:{us,them}|us/them, verdict, settled}]`.
- Admin (all under HMAC cookie, `credentials:same-origin`):
  `POST /api/admin/login {password}` (ASSUMED — wire or rename in Track B; the
  page treats 401/403 anywhere as "locked"), `POST /api/admin/run
  {kind:"selfplay|f1|f2", opponent_gid?, their_cop_url?, their_thief_url?}`,
  `POST /api/admin/stop`, `POST /api/admin/report-dry-run`,
  `GET /api/admin/logs` (renders `{lines:[…]}` or raw JSON). The deck shows the
  mandated notice: **counted cannot be launched from the web, by design**.

## Template serving notes for Track B

Templates are **pure static HTML** — no Jinja syntax anywhere. Serve them with
`FileResponse`/`Jinja2Templates` alike; `replay.html` reads its run id from
`location.pathname` (`/replay/{run_id}`), so one route serving the same file
for any id is enough. All asset paths are absolute under `/static/…`.
Recommended: `GZipMiddleware(minimum_size=1024)` — the min pair is ~751 KB raw,
~190 KB gzipped.

## Known deviations (with reasons)

- File cap 150 lines: the JS scene/HUD modules exceed it (three.js scene
  assembly is irreducibly verbose); the contract says "where practical" for the
  hub repo — flagged for the integrator rather than artificially split.
- `replay.js` reuses scene.js + entities.js + timeline helpers but not
  director.js: the director is an envelope-stream consumer (burst tiers,
  monotonic cursor), while the scrubber needs random access over resolved
  frames; both honor the same speed-multiplied-accumulator rule.
- Inter downloaded as one variable woff2 (Google served identical bytes for
  400 and 600) — declared `font-weight: 100 900` in fonts.css.
- Fixture `view` payloads carry the optional `commit` field (documented above)
  so the commit ticker demos; contract events.jsonl does not yet include it.
- Recipe lighting values were starting points and got a readability tune after
  headless-browser screenshots (hemi 0.55→0.9, moon 0.35→0.55, fog 0.011→0.008,
  towers emissive 0x10162a + brighter tints, windows/signs DoubleSide, scent
  gain 0.55→0.34): the skyline was invisible at the recipe values. Structure
  (merged/instanced batching, fixed rig, half-res bloom chain) is verbatim.
- `THREE.Clock` is deprecated in r185 — director/replay use `THREE.Timer`
  (`update()/getDelta()/getElapsed()`), same delta-accumulator semantics.
