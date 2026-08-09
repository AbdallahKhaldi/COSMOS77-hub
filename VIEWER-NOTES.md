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
static/fixtures/demo-live.json    115 contract envelopes, one 20-move window, BOTH perspectives (see schema below)
static/fixtures/demo-replay.json  contract replay doc: 2 windows, 42 frames, 71% ghost hit-rate, 1 TAMPERED step in window 2
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
- `/replay/anything?demo=1` (and `/replay/<id>` when the fetch 404s → shows a
  hint) loads `static/fixtures/demo-replay.json`. Window 2 frame index 30
  (step 9) flips the badge to TAMPERED (verified live). The scent overlay
  defaults OFF in replay (toggle stays); ▶ ENDING (next to the verdict panel)
  seeks to 3 frames before the window end and plays at 1×.
- `?debug=1` on either page prints the draw-call ledger to the console every
  ~2 s and mirrors the last line to the canvas' `data-arena-debug` attribute.

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
  score:{us,them}|us/them, verdict, settled}]`. V2: a run is folded into the
  collapsed "pre-arena runs (no replay)" details when `has_replay|replay|
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
- Fixture `view` payloads carry the optional `commit` field (documented above)
  so the commit ticker demos; contract events.jsonl does not yet include it.
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
