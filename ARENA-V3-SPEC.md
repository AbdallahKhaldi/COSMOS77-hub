# ARENA V3 — the game-shell (user verdict on v2: "fifty percent")

User's exact complaints, each binding: (1) the gameplay window is TOO SMALL; (2) there is NO BUTTON
to start actual gameplay; (3) can't start the chase from the thief or the cop; (4) top-down should
be MORE CINEMATIC; (5) third-person is good — keep it; (6) the dark website chrome doesn't fit the
world — make everything INTEGRATED INTO THE WORLD, GTA-style, with secondary UI like a game's
ESC/pause menu; (7) graphics still need a real step up.

Scope: templates/index.html + templates/replay.html + static/css/arena.css + static/js/* (front-end
only). Do NOT touch src/, tests/, fixtures, docs.html, league.html, admin.html (they stay briefing
pages). All legality rails from ARENA-CONTRACTS.md survive verbatim: LOCAL TRUTH label, BELIEF-only
opponent, one perspective per live socket, bird's-eye only in replay of settled games.

## 1. The page IS the game (kills complaints 1 + 6)

- The 3D canvas fills the ENTIRE viewport (100dvh, no page scroll on the arena and replay pages).
  Delete the card/panel page layout on these two pages. The world is the background of everything.
- All UI floats OVER the world as HUD clusters (translucent dark glass panels, backdrop-filter blur,
  thin borders — readable on the bright day world AND at night):
  · top-left: status chip (LIVE / DEMO REEL / REPLAY + run label) + the LOCAL TRUTH badge under it.
  · top-center: compact score strip (us vs them, window pips, step counter).
  · top-right: MENU button (also bound to Escape).
  · bottom-right: the control cluster — camera seg (TOP / CHASE), day/night seg, feed seg
    (POLICE / THIEF on live; CHASE COP / CHASE THIEF appear in replay), quality only via ?q=.
  · bottom-left: collapsible tactical panel — 2D belief heatmap (mandated), scent toggle,
    wanted stars; one tap collapses it to a small map chip.
  · bottom-center strip: radio ticker (one line, marquee-ish log) + commit-hash ticker interleaved
    or alternating; unobtrusive.
- Replay page same treatment: full-bleed world, scrubber as a floating bottom bar, belief-vs-truth
  and integrity as floating right-side glass panels that can collapse.

## 2. START — the missing button (complaint 2)

- Attract mode gets a centered hero block ON the world: the COSMOS77 ARENA wordmark (small), and a
  huge primary button: "▶ START PURSUIT" — starts the demo fixture immediately (same path as
  ?demo=1, no query needed), with a smaller line under it: "live feed connects automatically when a
  real game runs".
- When a REAL run is live, the hero hides and the live feed plays; when a run ends, show the
  end-slam then return to attract with the button.
- The button must be impossible to miss: Anton display face, road-yellow, subtle idle pulse
  (disabled under prefers-reduced-motion).

## 3. ESC menu — GTA pause style (complaint 6)

- MENU button / Escape opens a full-screen overlay: world stays visible but blurred+dimmed behind.
- Left-aligned vertical menu, big Anton items, keyboard navigable (arrows + enter), mouse hover
  slide: RESUME · START DEMO · CHALLENGE US · REPLAYS · LEAGUE · BRIEFING · OPS.
  · RESUME closes. START DEMO starts/restarts the demo.
  · CHALLENGE US expands IN the menu to the engage form (gid, per-role URLs, single URL, F1/F2,
    ENGAGE) — same /api/challenge wiring as the old drawer, same copy about rate limits; plus our
    three endpoint rows with COPY buttons.
  · REPLAYS expands to the settled-run list fetched from /api/runs (▶ watch → /replay/{id}).
  · LEAGUE and BRIEFING navigate to /league and /docs. OPS navigates to /admin.
- The menu replaces the old top navbar entirely on arena+replay pages (statusbar chrome deleted).

## 4. Cameras (complaints 3 + 4, keep 5)

- TOP becomes CINEMATIC TACTICAL: oblique 3/4 angle (polar ~0.95 rad), FOV 44, distance ~88, very
  slow ambient orbit (full turn ≈ 90s, ±0.35 rad clamp swing), gentle dolly-in ~4% on each new
  window, eased reframe. Never flat-overhead, never the raked skew of v2's drift.
- CHASE unchanged in feel (user approved) with one addition: slight FOV kick (55→58, 300ms) when
  the followed car starts a move — speed sensation.
- Feed/chase clarity: on LIVE, the POLICE/THIEF seg is the way to "chase from the cop or the
  thief" — switching feed while camera=CHASE must land you directly behind the newly selected car
  (no extra clicks, keep the 600ms eased transition). Label the seg "FEED" with a one-line hint in
  the menu. On REPLAY, CHASE COP / CHASE THIEF are direct buttons (both cars are legal there).

## 5. Graphics fidelity pass (complaint 7) — within the same perf budget class

- Materials: per-instance color/roughness jitter on buildings (vertex-color or instanceColor +
  roughnessMap noise); parked cars get varied Kenney palette hues; glass windows slightly
  reflective (envMap from a tiny generated gradient cubemap or scene.environment from the Sky —
  r185 Sky + PMREM is acceptable if cheap; else specular highlights only).
- Streets: add wear — manhole circles, crosswalk fade variation, oil stains (all into the road
  canvas texture, zero extra draw calls); sidewalk gets a subtle paver grid line pattern.
- Dressing: use the vendored kenney detail-awning glbs (static/vendor/kenney/buildings/ has
  building models; awnings may be embedded — if no awning file exists, skip) and add billboards on
  2-3 ring buildings (canvas textures: neutral fictional ads — "COSMOS COLA", "77 FM", "NY DONUTS";
  never real brands); 2-4 steam vents (small animated sprite puffs) at night only if cheap.
- Light/grade: keep ACES; add a subtle vignette + slight saturation/contrast lift as a final
  fullscreen pass (cheap ShaderPass in the existing composer chain; skip entirely on q=low);
  day shadow softness up (radius if PCFSoft supports, else mapSize 2048 stays).
- BELIEF ghost: upgrade to a fresnel-rim hologram (custom ShaderMaterial or emissive+rim trick),
  scanline shimmer, soft ground ring pulse; label sprite stays.
- Keep draw calls ≤ 90 day / ≤ 90 night measured via the ?debug=1 ledger; DPR cap may rise to 2.0
  ONLY at q=high.

## 6. Demo pacing

- Demo fixture playback stepMs 850 → 650 and banner flips feel snappier; burst/catch-up logic
  untouched.

## 7. Acceptance (verify yourself before reporting)

- node --check all JS; no external URLs; fixtures untouched and both pages work with ?demo=1 AND
  with the START button with no query; Escape opens/closes the menu; challenge form posts to
  /api/challenge; replays list loads from /api/runs; all legality labels present; draw-call ledger
  within budget; prefers-reduced-motion kills pulse/orbit/FOV-kick/steam; 640px mobile: HUD
  clusters stack, menu is full-screen, world stays interactive.
