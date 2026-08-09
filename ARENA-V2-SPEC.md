# ARENA V2 — the realism overhaul (user-directed, 2026-08-09)

User verdict on v1: too dark; wants an ACTUAL-CITY GTA feel, better graphics, third-person chase
cameras, and a top view — "ditch the dark mode if needed". This spec is binding; the WS/timeline/
director/HUD data logic and every legality rail from ARENA-CONTRACTS.md stay untouched. This is a
scene, lighting, world-dressing, vehicle, and camera pass over static/js + arena.css + templates.

## 1. Time of day — bright by default

- DEFAULT preset `day`: golden-hour city. Vendored `three/addons/objects/Sky.js` dome (turbidity ~6,
  rayleigh ~1.2, sun elevation ~28°, azimuth ~140°), warm DirectionalLight sun (0xffe0b0, physical
  intensity ~3.0) + HemisphereLight sky/ground fill (~0.55) — the board must read like late
  afternoon, bright and warm, ZERO murk. Exposure ~1.1, ACES. Fog: light warm haze (FogExp2
  ~0.0045) tinted to horizon color so the city fades, never blackens.
- Preset `night`: the v1 look, kept as a toggle (neon windows, streetlight pools, current bloom).
- Segmented DAY/NIGHT toggle in the HUD (persist localStorage, default day). Bloom per preset:
  day → threshold 1.0 / strength 0.25 (sun glints, lightbar); night → current values.
- Shadows ON in day preset for q=med/high: renderer PCFSoftShadowMap, sun casts, mapSize 2048,
  tight ortho frustum (±60 around board), buildings + vehicles + props cast, ground/roads receive.
  q=low: shadows off. Night: shadows off (unchanged).

## 2. The board becomes a real city district

Reinterpret the geometry (cellToWorld/game mapping UNCHANGED): the 7×7 cells are ROAD
INTERSECTIONS; agents drive ON a road grid; the 6×6 spaces BETWEEN the roads are CITY BLOCKS with
buildings inside the board. This is what makes it feel like a city instead of a game board.

- Roads: connect all neighboring intersections with asphalt strips (procedural CanvasTexture:
  asphalt grain + white dashed center line + stop lines + zebra crosswalks at every intersection).
  Sidewalk curbs (light concrete, slight height) border every block. One merged geometry for
  roadbed, one for sidewalks; texture atlas via canvas — draw calls stay low.
- Interior blocks (36): each gets one of, seeded deterministically: low-rise buildings (1–3 floors
  MAX inside the board so top/chase sightlines stay open; flat roofs, window insets, AC units,
  awning colors), a park (grass texture + 2–4 low-poly trees: cone/sphere canopies), or a parking
  lot (painted stalls + 1–2 parked cars). InstancedMesh everything; per-instance tint jitter.
- Outer ring: keep the tall skyline OUTSIDE the board (2–3 deep, taller with distance) — day
  materials (concrete/glass tints); at night it reuses the neon-window instancing.
- Props, all instanced: streetlight poles (keep, off in day / pools only at night), traffic-signal
  or stop-sign posts at a seeded subset of intersections, hydrants, and parked cars along outer
  streets (desaturated body colors, static).
- Cell overlay layer (barriers/flash/hover) stays, retuned so it reads on bright asphalt: barriers
  render as striped ROADBLOCK barricades (two-bar sawhorse geometry, orange/white stripes) dropped
  ACROSS the intersection + hazard tint on the overlay. Scent decals: keep additive quads but tone
  for daylight (deeper orange, alpha-scaled).
- The BELIEF ghost: unchanged concept, retune for daylight — holographic cyan with fresnel-ish
  rim (emissive, toneMapped:false) + soft pulsing ring on the intersection + the BELIEF label
  sprite (keep). Must stay clearly non-physical vs the real cars.

## 3. Vehicles v2 — GTA-silhouette, glb-swappable

- Procedural rebuild (BufferGeometry groups, low-poly but shaped): cop = police cruiser — body with
  hood/cabin/trunk masses, inset dark windows, black/white two-tone + "POLICE" side text via canvas
  texture, chrome-ish bumpers, 4 cylinder wheels with dark tires + light hubs, roof lightbar
  (red/blue emissive halves, strobe alternates, toneMapped:false). Thief = muscle car — vivid
  orange paint + twin black racing stripes, black spoiler, slightly wider rear wheels. This fixes
  the v1 "thief car invisible" complaint.
- Motion polish: wheels rotate proportional to distance traveled; body yaws smoothly to heading
  (slerp), leans ~2° into turns and pitches ~1.5° on accel/brake; blob contact-shadow quad under
  each car (radial-gradient canvas, multiply-ish alpha) so cars sit ON the road in day mode.
- GLB hot-swap contract: at boot, try GLTFLoader on /static/vendor/kenney/police.glb and
  /static/vendor/kenney/thief.glb; on success, replace the procedural mesh (scale to CELL*0.42
  length, pivot at ground center, +X forward) and keep the same lightbar/shadow attachments; on
  404 silently keep procedural. Document the contract in VIEWER-NOTES.md.

## 4. Camera system — TOP / CHASE (the third-person ask)

Segmented control in the HUD viewport corner: **TOP** and **CHASE** (live page); replay adds
**CHASE COP / CHASE THIEF**.
- TOP: current tactical orbit, drift CLAMPED (polar 0.35–0.95, azimuth drift ≤±0.3 rad, distance
  70–120) and auto-reframe on window change — kills the v1 raked-angle complaint. OrbitControls
  active only in TOP.
- CHASE: true third-person follow — target = the followed car: desired pos = car.pos −
  forward×9.5 + up×4.6, critically-damped lerp (k≈4/s) with look-ahead lookAt(car.pos +
  forward×3.5 + up×1.2), FOV 55, subtle lateral sway with turns. On the LIVE page chase follows
  ONLY the feed perspective's own car (the LOCAL TRUTH label stays pinned); in REPLAY either car.
  When the followed car idles, slow 8s orbital creep around it so the frame never dies.
- Smooth 600ms eased transitions between camera modes (tween position+quaternion, never a cut).

## 5. Small fixes riding along (from the pre-deploy review)

- Replay: scent overlay defaults OFF (toggle stays). Add a "▶ ENDING" chip next to the verdict
  panel that seeks to 3 frames before the window end and plays at 1× (endcard discoverability).
- League page: legacy runs with no replay data (all-dash rows) fold under a collapsed
  <details> "pre-arena runs (no replay)" — the headline table shows only replayable runs.
- Live page: keep demo-reel labeling as is.

## 6. Non-negotiables

- All vendored, zero external runtime requests (Sky.js + GLTFLoader.js already at
  static/vendor/three-0.185.0/addons/{objects,loaders}/ — add them to BOTH import-map-loading
  templates only if imported via bare specifiers; relative imports inside them resolve to 'three'
  which the map already handles).
- Perf: draw calls ≤80 in day preset (verify via renderer.info in a console log gated behind
  ?debug=1), DPR clamp 1.5, no per-frame allocations, instancing/merging as v1, pools not churn.
- prefers-reduced-motion honored by new animations (chase damping still allowed; strobes/sway off).
- Every legality element untouched: LOCAL TRUTH label, BELIEF label, one-perspective-per-socket,
  replay-only bird's-eye, no opponent-truth fields in live code paths.
- node --check all touched JS; fixtures unchanged and ?demo=1 must work identically.
- Files stay reasonably small; new modules fine (world.js, cameras.js, vehicles.js, lighting.js).
