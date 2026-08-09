# VIEWER-NOTES — the arena front-end (Track C, ARENA V2)

The 3D city viewer, replay cinema, and page shells for the COSMOS77 hub.
V2 is the user-directed realism overhaul: **bright golden-hour city by
default** (night preset kept as a toggle), the board reinterpreted as a real
road-grid district with Kenney CC0 buildings/vehicles, and a TOP / CHASE
third-person camera system. Everything here is static + templates: **zero
runtime external requests** — every `fetch`/`WebSocket` targets `/static`,
`/api`, or `/ws/live` only (three.js + Kenney kits vendored, fonts
self-hosted, favicons and generated palettes are data URIs).

## File map

```
templates/
  index.html    THE ARENA — 3D bodycam viewer + HUD + stage controls (TOP/CHASE, DAY/NIGHT) + challenge drawer
  replay.html   REPLAY CINEMA — bird's-eye of settled games (legal only here); cams TOP/CHASE COP/CHASE THIEF + ▶ ENDING chip
  docs.html     challenge-us briefing: seven agreements, endpoints, 406 note, pairing generator
  league.html   ledger scoreboard; legacy no-replay runs fold under a collapsed "pre-arena runs" details
  admin.html    ops deck: login + run controls; counted-cannot-launch-from-web notice
static/css/arena.css        the design system (HW6 "COSMOS77 CITY" DNA) + V2 stage-ctl segs
static/js/
  timeline.js   envelope log + THE ONE shared reducer applyEvent() + grid helpers (pure, no THREE/DOM)
  net.js        WS /ws/live wrapper (backoff+jitter, hello/last_seq, ping 25s) + demo fake socket + fetch helpers
  scene.js      orchestrator: renderer (ACES 1.1, PCFSoft), overlay layer, half-res bloom, q tiers, ?debug=1 ledger;
                wires lighting.js + world.js + cameras.js; exports CELL/GRID/cellToWorld/mulberry32 (mapping UNCHANGED)
  lighting.js   day/night presets over ONE fixed light rig (Sky.js dome + sun + hemi + 2 hero points); per-preset bloom values
  world.js      the city district: seeded PLAN (blocks/towers/props/parked) -> procedural realization -> kenney bake upgrade;
                painted road canvas (dashes/stop lines/zebras), sidewalk slabs, parks, lots, skyline ring, night neon layer
  cameras.js    TOP (clamped tactical orbit + bounded attract drift + window reframe) / CHASE (third person, damped,
                look-ahead, sway, idle orbital creep, block pullback); 600 ms eased mode transitions
  vehicles.js   police cruiser + thief muscle car: GTA-silhouette procedural builds + kenney glb hot-swap (wheels spin,
                lean/pitch, contact-shadow blob, strobing lightbar that survives the swap)
  entities.js   BELIEF ghost (cloud + volume + rim shell + pulsing ring + label), scent decals, 14 roadblock barricades
                (+ optional kenney cones), trail ring — all with per-preset day/night gains
  assets.js     ONE shared GLTFLoader: parallel boot load of every kenney glb behind a never-rejecting Promise;
                generated per-kit colormap palettes served via LoadingManager.setURLModifier (see below)
  director.js   the single rAF: burst tiers 3/12, ~20 instant-applies/frame cap, tween pool, SNAP, speed-multiplied clock;
                cameras delegated to cameras.js, TOP auto-reframe on window_end
  hud.js        DOM HUD: banner, mandated belief heatmap (doubles as the 2D minimap), scent toggle, tickers, scores, drawer
  replay.js     replay driver: frames scrubber, 0.5/1/4/16x, window selector, BELIEF-vs-TRUTH overlay, Verified/TAMPERED
                badge, car headings (so CHASE works), scent overlay OFF by default, ▶ ENDING chip
static/vendor/three-0.185.0/   three.js r185 min pair + LICENSE + addons (OrbitControls, BufferGeometryUtils, bloom chain,
                               Sky, GLTFLoader, SkeletonUtils — SkeletonUtils vendored from upstream r185: GLTFLoader
                               statically imports it)
static/vendor/kenney/          Kenney CC0 kits (Car Kit 3.1 + City Kit Commercial 2.1, see LICENSE-*.txt): police/thief,
                               buildings a-g, skyscrapers a-e, low-detail a-f, 5 parked cars, props/cone
static/fonts/                  Anton, Chakra Petch 400/600, Space Mono 400/700, Inter (variable) woff2 + fonts.css + OFL-NOTICE.txt
static/fixtures/demo-live.json    146 HUB-DIALECT envelopes from the REAL settled selfplay run
                                  selfplay-20260809-012233 (35-move window, both perspectives, one
                                  hub seq space). REGENERATE with scripts/make_demo_fixture.py —
                                  never hand-edit; one dialect exists end to end (see below)
static/fixtures/demo-replay.json  replay doc built from the same real run: 1 window, 36 frames,
                                  belief_trace keyed by step (window key optional — the viewer
                                  falls back to a step-only match)
```

## The city district (V2 world model)

The game mapping is untouched — `cellToWorld` still maps the 7×7 cells, but
they now read as ROAD INTERSECTIONS: a painted road grid (asphalt grain,
white dashed center lines, solid edge lines, stop lines, zebra crosswalks at
every intersection — one 1536² canvas, one plane, one draw call) with 36 city
blocks between the roads. Each block is seeded deterministically (mulberry32
770077, consumed in fixed order at PLAN time only, so every viewer — and both
the procedural and kenney realizations — get the identical city): low-rise
buildings (height-capped at 4.3 so the chase camera's 4.6 clears them), a
park (grass + cone/sphere trees), or a parking lot (painted stalls + parked
cars). The tall skyline stays OUTSIDE the board (2–3 deep, taller with
distance); at night it carries the v1 neon-window instancing + hero signs,
which are positioned from the PLAN boxes so they fit both realizations.
Props: streetlights (pools/heads hot at night), stop-sign posts, hydrants,
parked cars along the outer streets. Barriers render as striped ROADBLOCK
barricades dropped across the intersection (two-bar sawhorse, orange/white),
with 3 kenney traffic cones scattered around each once the cone glb loads.

## Presets — day (default) & night

Segmented DAY/NIGHT toggle on the stage (persisted in localStorage
`cosmos77.arena.preset`, default day). One fixed light rig; toggling changes
colors/intensities/visibility only — zero shader recompiles, and shadows
toggle via `sun.shadow.intensity` (r185) with the map kept bound.

| thing            | day (golden hour)                             | night (the v1 look)             |
|------------------|-----------------------------------------------|---------------------------------|
| sky              | Sky.js dome: turbidity 6, rayleigh 1.2,       | dome hidden, bg 0x06070f        |
|                  | mie 0.005/0.8, sun elev 28°, azimuth 140°     |                                 |
| sun/moon light   | 0xffe0b0 @ 3.2 (physical)                     | 0x8fb4ff @ 0.55, (-70,120,-40)  |
| hemisphere       | 0xffe3c4 / 0x8a7860 @ 0.6                     | 0x2b3a67 / 0x0b0d12 @ 0.9       |
| hero points      | off                                           | 60 / 45 (v1 values)             |
| fog (FogExp2)    | 0xf3cfa5 @ 0.004                              | 0x0a0d1a @ 0.008                |
| bloom            | threshold 1.0 / strength 0.25 / radius 0.3    | 0.85 / 0.55 / 0.35 (v1)         |
| shadows          | ON for q=med/high (PCFSoft 2048, ortho ±60)   | off (shadow.intensity 0)        |
| overlay gain     | 1.6 (hazard tints on bright asphalt)          | 1.0                             |
| ground           | dry concrete (rough .95, metal .02)           | wet-asphalt trick (v1)          |
| scent decals     | deeper tint (−.015 H, +.15 S, −.08 L), ×0.62  | ×0.34 (v1)                      |
| ghost gains      | cloud ×2.6 (max 1.8), vol .3, shell .32, ring .6 | 1.8/1.15, .13, .2, .4        |
| contact blobs    | visible (cars sit ON the road)                | hidden (v1 look + draw budget)  |
| exposure         | ACES 1.1                                      | ACES 1.1                        |

## Cameras — TOP / CHASE

Stage segmented control; replay swaps CHASE for CHASE COP / CHASE THIEF.
- TOP: the tactical orbit, clamped — polar 0.35..0.95, distance 70..120;
  attract drift is a bounded ±0.28 rad azimuth sine (46 s period), and every
  window change auto-reframes to the canonical pose (0,95,55)→(0,1.5,0).
  OrbitControls are enabled ONLY in TOP.
- CHASE: desired = car − forward·9.5 + up·4.6, critically damped (k≈4/s),
  lookAt(car + forward·3.5 + up·1.2), FOV 55 (TOP 40), lateral sway follows
  yaw rate (off under reduced motion). Idle >3 s starts a slow 8 s-period
  orbital creep so the frame never dies. If the damped position enters an
  interior block's AABB it pulls up above the block (blocks are height-capped
  below the chase height, so this only catches corner-cutting).
- Mode switches tween position+quaternion+fov over 600 ms (easeInOutCubic),
  never a cut; instant under prefers-reduced-motion.
- LIVE page: chase follows ONLY the feed perspective's own car. REPLAY:
  either car (settled game — bird's-eye is legal there).

## Kenney glb hot-swap contract

At boot each page calls `loadKenneyAssets()` (assets.js): ONE GLTFLoader,
all files in parallel, per-file failures resolve null — on any failure the
procedural build silently stays (the city plan is identical either way).
- Vehicles: `/static/vendor/kenney/police.glb` + `thief.glb` →
  `cruiser.swapIn(scene)` / `runner.swapIn(scene)`. The model is compacted
  (non-wheel meshes merged to 1 draw; the 4 named `wheel-*` nodes stay
  separate and spin), long axis aligned to travel (+Z; kenney fronts face +Z
  already), scaled to length ≈ CELL·0.42 = 4.2, pivot at ground center. The
  strobing lightbar re-seats at the loaded roof height and the contact blob
  stays — both survive the swap. Wheel radius 0.3·scale.
- Buildings/parked: world.js re-realizes the SAME seeded plan as three merged
  static bakes (interior blocks, skyline ring, parked cars) with per-instance
  tint baked as vertex colors — the whole kenney city costs ~3 draw calls.
  Skyscrapers scale non-uniformly INTO the plan boxes so the night neon
  windows/signs stay attached.
- Cones: `barriers.attachCones(geo, mat)` — 3 per landed barricade.
- Colormap: the kits reference an external `Textures/colormap.png` that is
  not part of the drop. All models sample it as 8 vertical gradient columns
  (verified from the files' UVs: wheels col2, glass col3, paint cols 4/6/7,
  cone col5, walls cols 0/1), so assets.js serves GENERATED per-kit palettes
  (canvas → data URI) via `LoadingManager.setURLModifier`, curated to the
  arena's art direction: black/white cruiser, vivid-orange muscle car,
  yellow taxis, orange cones, warm plaster + brick + glass buildings.
  Dropping a real colormap.png at `static/vendor/kenney/Textures/` (and
  `buildings|parked|props/Textures/`) would need the modifier removed —
  keep the generated palettes unless the original art is re-vendored.
Kenney assets are CC0 (Creative Commons Zero) — credit: Kenney, www.kenney.nl
(Car Kit 3.1, City Kit Commercial 2.1; LICENSE files vendored alongside).

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

| tier | DPR cap | bloom                    | shadows (day preset only)   |
|------|---------|--------------------------|-----------------------------|
| low  | 1.0     | off (no composer at all) | off                         |
| med  | 1.5     | half-res UnrealBloom     | PCFSoft 2048, sun, ortho ±60 |
| high | 1.5     | half-res UnrealBloom     | PCFSoft 2048, sun, ortho ±60 |

(DPR is clamped 1.5 across the board per the V2 spec; med/high currently
share settings — high is headroom for future upgrades.)
Fixed light rig: hemisphere + directional sun/moon + 2 hero points + the
cruiser's owned strobe point — lights are **never** added/removed/toggled
(intensity/color/shadow.intensity animate instead), so no shader recompiles
mid-run, including on the DAY/NIGHT toggle.
Draw-call ledger (`?debug=1` logs every ~2 s, also mirrored to the canvas'
`data-arena-debug` attribute): measured with the kenney city live —
day scene ≈ 47–55 calls / whole frame ≈ 61–69 (bloom chain adds ~14);
night scene ≈ 46–55 / frame ≈ 60–69. Both presets sit well inside the ≤80
budget; the procedural fallback runs ~6–8 calls higher (still fine).
`prefers-reduced-motion` kills scanlines/slams/strobe flash/camera drift/
sway/idle creep, makes tweens and camera transitions instant.

## Demo mode (no backend needed)

- `/?demo=1` (or opening index with `?demo=1&q=med`) feeds
  `static/fixtures/demo-live.json` through a **fake socket** into the SAME
  timeline → director → HUD path as production; the perspective switcher works
  (the fixture carries both perspectives in one hub seq space and the fake
  socket filters, exactly like the server).
- **The fixture speaks the hub dialect and comes from a real run.** Rebuild it
  with `python3 scripts/make_demo_fixture.py [run-stamp]` (default
  `selfplay-20260809-012233`): the converter reads BOTH agent repos'
  `runs/<stamp>/` artifacts and composes the tape exactly like the hub's
  tailer — views from each `events.jsonl` (`_VIEW_FIELDS` subset, game order:
  step ascending, thief first, YOUR TURN before LOCKED), one `window_end` per
  `log_*_gNN.json` addressed to `summary.my_role`, one `series_end` per
  perspective from the result artifact, plus a `run_started` status and a
  composed on-connect snapshot per perspective at the head. One seq space,
  seq 1..N.
- **Perspective switches resume the shared tape** (never rewind — only START
  does) and the catch-up re-deliveries are marked `catchup:true` on copies, so
  the HUD applies their state silently: no WINDOW SEALED / SERIES COMPLETE
  slam or strip re-announcements replay for moments the viewer already lived
  through.
- `/replay/anything?demo=1` (and `/replay/<id>` when the fetch 404s → shows a
  hint) loads `static/fixtures/demo-replay.json` — the same real settled run
  as the live tape (1 window, 36 frames, every step Verified OK). The scent
  overlay defaults OFF in replay (toggle stays); ▶ ENDING (next to the verdict
  panel) seeks to 3 frames before the window end and plays at 1×.
- `?debug=1` on either page prints the draw-call ledger to the console every
  ~2 s and mirrors the last line to the canvas' `data-arena-debug` attribute.
- **Regression pins:** `node scripts/verify_viewer.mjs` (exit 0 = all hold)
  replays the shipped reducer/pairing/parse bytes against the fixture, real
  hub payload shapes, catch-up suppression, and the /api/runs envelope — run
  it after touching timeline.js, replay.js, menu.js, hud.js, net.js,
  director.js or the fixtures.

## Envelope contract consumed (hub-composed — THE HUB DIALECT)

```json
{"seq": 1, "ts": 0.0, "run_id": "…", "perspective": "police|thief",
 "type": "view|window_end|series_end|status|snapshot", "payload": {}}
```
The payload shapes below are **exactly what `src/cosmos_hub/envelopes.py`
emits** (pinned by the hub's tests); the reducer consumes them natively and
additionally tolerates the pre-V3 fixture keys (`us/them/winner/verdict/
scores/windows_total`) so old tapes still play.
- `seq` monotonic per RUN across both perspectives ⇒ a one-perspective socket
  legitimately sees **gaps**; the client dedupes with a monotonic filter and
  never waits for gaps. A changed `run_id` resets the client log.
- `view` payload = the events.jsonl line's `_VIEW_FIELDS`: `role, sub_game,
  step, banner("YOUR TURN"|"LOCKED"), self_pos[r,c], barriers[[r,c]…],
  barriers_left, posterior{"r,c":p}, perceived_scent{"r,c":v}, confidence
  ("exact|fuzzy|none"), hints[str…]` — plus OPTIONAL `commit` (40-hex) which,
  when present, feeds the commit-hash ticker (graceful when absent).
- `window_end` payload: `{sub_game, result("capture|survival|…"), my_role,
  steps, reason, settled, score:{gid:pts}, winner_group:gid|null,
  roles:{gid:role}}`. The reducer maps the gid-keyed score to per-feed
  `us/them` via `my_role`+`roles` (us = the side this feed's agent played)
  and derives the pip winner from `winner_group` (null ⇒ tie); it also learns
  `usGid` here for the series mapping.
- `series_end` payload: `{game_id, num_sub_games, final_result,
  mutual_agreement}` — `final_result.total_score{gid:pts}` is mapped through
  the learned `usGid`; the HUD verdict line derives from
  `final_result.winner_group` / `series_tie` + `mutual_agreement.confirmed`.
  NOTE `num_sub_games` is the DECLARED series length (6 even for a 1-window
  run) — never used for the pip count.
- `status` payload: `{state:"running"|"standing", run_id?, kind?, opponent?,
  windows?}` — `windows` sets the real pip count (f1 runs show 1 pip, not 6).
  A legacy `{line}` payload still lands in the radio ticker.
- `snapshot` payload: `{run_id, perspective, view?, windows?:[window_end
  payloads…], final?:series_end payload, status?}` — settled windows are
  folded through the same window_end logic, so a mid-series reconnect
  rebuilds pips/scores/usGid; `status.windows` restores the pip count.
  (A bare view, or the legacy `{view, scores, window, windows_total, pips?}`,
  is still accepted.)
- On WS open the client sends `{"type":"hello","last_seq":N}` and expects one
  snapshot + the tail; it also sends `{"type":"ping"}` every 25 s (server may
  ignore).

## Replay document consumed (`GET /api/replays/{run_id}`)

The hub's real document (replay.py `build`) plus the optional fixture-era
meta keys the cinema still honors when present:
```json
{"meta": {"run_id","game_id","game_uid","windows","final_result",
          "gid_a?","gid_b?","score?":{"us","them"},
          "per_window?":[{"window","result","us","them"}],"verdict?"},
 "frames":[{"step","window","cop":[r,c],"thief":[r,c],"barriers":[[r,c]…],
            "commit_ok":true,"scent":{"r,c":v},"hint":"…|null"}],
 "verify":{"per_step":[true,…],"verdict":"Verified OK|TAMPERED"},
 "belief_trace":[{"window","step","ghost":[r,c]|null,"confidence"}]}
```
- Group ids and totals come from `meta.final_result.total_score` (gid-keyed)
  when the fixture keys are absent; the endcard and score-table totals row
  render from it, the verdict word from `winner_group`/`series_tie`.
- **`belief_trace` pairs with frames BY (window, step), never by array
  index** — the builder emits one entry per police events line, and a raw
  tape holds YOUR TURN + LOCKED lines per step, so lengths need not match.
  The viewer indexes the trace by `"window,step"` (later entries overwrite
  earlier ones ⇒ the LOCKED post-turn view wins, same rule as the builder's
  scent index) and looks up each frame's own key, falling back to a
  step-only key for traces without a window field. Hit-rate = share of
  frames whose step-paired `ghost == thief`.
- `verify.per_step[i]` stays index-aligned with `frames[i]` (both are built
  from the same per-step records walk).

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
- `GET /api/runs` → the ENVELOPE `{"runs":[{run_id, settled, windows_logged,
  replay, mtime}]}` (status_api.py; a bare array is also accepted). The menu's
  REPLAYS list unwraps the envelope, keeps settled rows, builds meta from
  `windows_logged`+`mtime`, and upgrades to `opponent_gid/kind/score/verdict`
  if a future server adds them. V2: a run is folded into the collapsed
  "pre-arena runs (no replay)" details when `has_replay|replay|
  replay_available === false` OR its us/them/verdict are all absent (the
  legacy all-dash rows); the headline table shows replayable runs only.
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

- File cap 150 lines: the JS world/vehicles/entities modules exceed it (city
  generation and vehicle builds are irreducibly verbose); the contract says
  "where practical" for the hub repo — V2 split the v1 monolith into 6 focused
  modules instead of artificially slicing further.
- `replay.js` reuses scene.js + entities.js + vehicles.js + timeline helpers
  but not director.js: the director is an envelope-stream consumer (burst
  tiers, monotonic cursor), while the scrubber needs random access over
  resolved frames; both honor the same speed-multiplied-accumulator rule.
- Inter downloaded as one variable woff2 (Google served identical bytes for
  400 and 600) — declared `font-weight: 100 900` in fonts.css.
- Fixture `view` payloads no longer invent a `commit` field: the tape is
  regenerated verbatim from a real run's events.jsonl, which does not carry
  one. The seal ticker stays wired (documented above) and degrades gracefully
  until the agents emit commits into the event stream.
- `THREE.Clock` is deprecated in r185 — director/replay use `THREE.Timer`
  (`update()/getDelta()/getElapsed()`), same delta-accumulator semantics.
- V2 spec deltas (tuned against live screenshots): day fog density 0.004 vs
  the spec's ~0.0045 (at 0.0045 the skyline ring drowned in haze); sun
  intensity 3.2 vs ~3.0 and hemi 0.6 vs ~0.55 (ground-plane NdotL at 28°
  elevation needed the nudge to read "bright, zero murk"); night contact
  blobs hidden (v1 look + draw budget). Chase/TOP constants are spec-verbatim.
- The kenney glbs reference a `Textures/colormap.png` that was not part of
  the vendored drop — assets.js serves generated per-kit palettes through a
  URL modifier instead of failing the loads (see the hot-swap section). The
  palette columns were reverse-engineered from the files' UV data; colors are
  curated, not Kenney's originals.
- `SkeletonUtils.js` was added to the vendored three addons (unmodified
  upstream r185 file): r185's GLTFLoader statically imports it, and without
  it every glb load — and therefore assets.js — failed to resolve.
- The ≤80 draw-call budget is met on the scene pass (the metric v1's ~33 used)
  in BOTH presets with big margin (day ≈ 47–55), and even whole-frame counts
  (scene + bloom chain + output ≈ 61–69) stay under 80 on the kenney path.
  The procedural fallback's whole-frame worst case can brush ~80+ at night;
  scene-pass stays under. Fallback only runs if vendored assets fail to load.
