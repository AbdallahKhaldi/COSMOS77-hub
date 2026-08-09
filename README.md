# COSMOS77-hub

The always-on arena for the COSMOS77 cops-and-robbers league (course 203.3763 final
project). One Railway container runs three processes: this FastAPI hub plus the two
agent repos (`COSMOS77-cop`, `COSMOS77-thief`) spawned as subprocesses — never
imported, never mounted in-process (two-process constitutional rule).

## Architecture

```
                        Railway container (one service)
  ┌───────────────────────────────────────────────────────────────────┐
  │  cosmos_hub (FastAPI, 0.0.0.0:$PORT)                              │
  │   ├─ /cop/mcp    ──strict reverse proxy──▶ 127.0.0.1:8801/mcp     │
  │   ├─ /thief/mcp  ──strict reverse proxy──▶ 127.0.0.1:8802/mcp     │
  │   ├─ /mcp        ──strict reverse proxy──▶ 127.0.0.1:8803/mcp     │
  │   ├─ / /replay/{id} /docs /league /admin  (templates, Track C)    │
  │   ├─ /api/status /api/runs /api/challenge /api/doctor /api/pair   │
  │   ├─ /api/replays/{id}                                            │
  │   ├─ /api/admin/run|stop|logs|report-dry-run  (cookie-auth)       │
  │   ├─ /ws/live?perspective=police|thief  (snapshot then stream)    │
  │   └─ manager: spawns/stops ▼ and tails /data/runs/<stamp>/ files  │
  │  COSMOS77-cop  subprocess  (uv venv, port 8801)                   │
  │  COSMOS77-thief subprocess (uv venv, port 8802)                   │
  │  sparring relay subprocess (cop repo script, port 8803):          │
  │    window parity per run from the sorted gid pair (first-sorted   │
  │    gid = cop on odds) ──▶ :8801/mcp or :8802/mcp per window       │
  └───────────────────────────────────────────────────────────────────┘
```

- **Standing posture** — when no run is active both agents run the transport-only ASGI
  app (`uvicorn <pkg>.net.asgi:app`), so the published endpoints answer 406 to a bare
  GET around the clock. Standing endpoints are **handshake-ready, not auto-playing**: a
  game plays only while a configured run is active, and either side may start one (the
  public challenge form dials the opponent immediately; a dial-back at an agreed time
  needs our operator to bring the run up first). A configured run swaps in
  `serve --peer-url ... --events`.
- **Proxy contract** (non-negotiable): no redirects at the published paths, methods
  GET/POST/DELETE, `Accept` / `Content-Type` / `mcp-session-id` /
  `mcp-protocol-version` preserved both directions, `Host` rewritten to the upstream
  bind, SSE streamed unbuffered, plain 502 while an agent is down, no auth/cookies.
- **Series topology (playbook §1, FIXED)** — roles alternate each sub-game and the
  alphabetically-first gid plays COP on the odds (ASCII sort: uppercase opponent gids
  sort before `cosmos77`). Against a REAL opponent (f1/f2/counted) the hub splits the
  windows between our two fixed-role processes with `--windows-spec 1,3,5`/`2,4,6`
  derived from `sorted([our_gid, opponent_gid])`, hands BOTH the same absolute
  `--out` on the data volume (window N sequences on the sibling's window N−1 log) and
  lets exactly one process — the owner of the last window — close; the other gets
  `--no-close`. An f1 involves only the window-1 owner. Selfplay alone keeps
  per-role dirs, full windows and `--alternate-labels`.
- **Event pipeline** — each side appends its own local truth to
  `events.jsonl` under the run's volume directory (`data/runs/shared/<stamp>` for
  real opponents, `data/runs/<role>/<stamp>` for selfplay); the hub tails every
  candidate dir, assigns the only `seq`, and fans out per-perspective envelopes
  (`view|window_end|series_end|status|snapshot`). The live channel never contains
  opponent truth (rules 8–9). When a run ends the standing snapshot is reset —
  late visitors never receive a dead run's `view`.
- **Replay** — when a series settles the hub rebuilds the bird's-eye timeline from the
  window logs (positions are mutually revealed post-audit), re-verifies every
  commit (`SHA256(canonical_json(payload)+"|"+nonce)`) and stores
  `data/replays/<run_id>.json` (`verify.verdict`: `Verified OK` / `TAMPERED`).
  `belief_trace` carries EXACTLY one entry per frame — the police events tape logs
  ~2 lines per step (YOUR TURN + LOCKED), deduped by `(window, step)`, last line
  wins — so `belief_trace[i]` belongs to `frames[i]` and both carry `window`/`step`.
- **Counted rail** — every web-reachable run path refuses `kind=counted` and any
  `--counted` argv with 403 (pinned by tests). Counted runs exist only through the
  SSH-only `cosmos-hub-counted` CLI below.
- **Universal compatibility** — the hub pairs with every course topology in both
  directions, for any opponent gid. Inbound: per-role URLs (`/cop/mcp`, `/thief/mcp`)
  **and** one single URL (`/mcp`) backed by a third standing subprocess, the cop repo's
  `scripts/sparring_relay.py` (window parity derived per run from the sorted group-id
  pair — first-sorted gid polices the odd windows, the league convention — via
  `--odd-url`/`--even-url` at spawn; ownership then follows each greeting's
  `sub_game_number`), tracked and healed by the manager like the agents. Outbound: run
  bodies accept `their_single_url` (both our serves dial it) and an optional `scent_model`
  (`subtractive_chebyshev_v1` | `multiplicative_book_v1`, allowlisted → `serve
  --scent-model`). Diagnosis: `POST /api/doctor` probes a candidate opponent.

## Public HTTP surface

| Route | Method | Purpose |
| --- | --- | --- |
| `/cop/mcp` · `/thief/mcp` | GET/POST/DELETE | per-role MCP endpoints (strict proxy, 406 when standing) |
| `/mcp` | GET/POST/DELETE | single-URL MCP endpoint → window-parity relay (:8803); plain 502 while the relay is down |
| `/` · `/replay/{id}` · `/docs` · `/league` · `/admin` | GET | pages (Track C templates) |
| `/health` | GET | plain `ok` |
| `/api/status` | GET | posture, active run, `agents` liveness incl. `relay`, `endpoints.single` |
| `/api/runs` · `/api/replays/{id}` | GET | run index / settled replay JSON |
| `/api/challenge` | POST | public friendly run; body may add `scent_model` |
| `/api/doctor` | POST | `{url}` or `{cop_url,thief_url}` (+`gid`) → shells `cosmos-cop doctor --json` (60 s cap, argv list only, cwd = cop repo); returns the doctor JSON + `elapsed_ms`; 502 on garbage output, 503 when the subcommand is unavailable, 504 on timeout. Same SSRF rails and the SAME rate budget as `/api/challenge` (one shared 90 s cooldown + 10/day) |
| `/api/pair` | POST | pairing packet via the cop repo |
| `/ws/live` | WS | one perspective per socket |

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | Railway-injected | hub bind port |
| `GEMINI_API_KEY` | yes | inherited by the agent subprocesses |
| `HUB_ADMIN_PASSWORD` | yes | admin login (`/api/admin/*`); unset ⇒ admin disabled |
| `GMAIL_CREDENTIALS_B64` | for counted | base64 of `credentials.json`, materialized to both repos at boot, mode 0600, never logged |
| `GMAIL_TOKEN_B64` | for counted | base64 of `token.json`, same treatment |
| `HUB_HARDWARE_DESC` | yes | truthful Step-0 hardware declaration override (read by the agents) |
| `STANDING_GIDS` | no (default `cosmos77`) | our gid (`--gid-a`) |
| `HUB_PUBLIC_URL` | no | published base URL; defaults to `https://$RAILWAY_PUBLIC_DOMAIN` (https ⇒ the admin cookie is `Secure`) |
| `HUB_DATA_DIR` | **yes in production** (default `./data`) | persistent volume mount point (`/data` on Railway). Holds **everything a redeploy must not destroy**: `runs/` (all run artifacts incl. counted declaration/config/log/result), `replays/`, `logs/`, the counted hold-file and the rule-52 ledger twin `league_ledger.json`. Setting it also marks the deploy volume-backed: boot migrates any legacy `<repo>/runs` and symlinks the cop repo's ledger to the volume twin |
| `HUB_COP_REPO` / `HUB_THIEF_REPO` | no | agent repo paths; auto-detected side-by-side or `/app/...` |
| `HUB_AUTOSTART` | no (default 1) | `0` disables agent spawning (tests/CI) |
| `GITHUB_PAT` | optional | reserved for artifact push-back |

## Local dev (repos side-by-side under `workspace/`)

```sh
uv sync
uv run ruff check .
uv run pytest -q
HUB_AUTOSTART=1 uv run uvicorn cosmos_hub.app:app --port 8080
# probe: curl -i http://127.0.0.1:8080/cop/mcp   → 406 once the cop agent is up
```

## Deploy (Railway)

1. Push this repo to GitHub; create a Railway service from it (Dockerfile build —
   `railway.json` pins the builder and the `/health` healthcheck).
2. Build args `COP_REF` / `THIEF_REF` pin the agent repo SHAs (default `main`);
   `COP_REPO_URL` / `THIEF_REPO_URL` point at the two GitHub repos. The image KEEPS
   the agent repos' `.git` dirs and ships the `git` binary: the agents seal the
   rule-53 `github_commit` via `git rev-parse HEAD` at serve time (the played SHAs
   are also recorded at `/app/COMMITS` for operator checks).
3. **Attach a volume at `/data` and set `HUB_DATA_DIR=/data` — required, not
   optional.** Without it every run artifact (including the committed-evidence set
   of a counted series) and the ledger twin die with the container on the next
   redeploy/restart (`restartPolicy` is `ON_FAILURE`).
4. Set the env table above in the service settings (never commit secrets).
5. Publish the endpoints: `https://<domain>/cop/mcp` and `https://<domain>/thief/mcp`.
   Opponents' `netcheck <url>` must report 406/PEER LISTENING.

## SSH counted runbook (the only counted path)

```sh
railway ssh                        # or: docker exec -it <container> sh
cd /app/COSMOS77-hub
# 1) double-arm the config side by hand (config counted=true in BOTH repos)
# 2) run the armed CLI — it prints the exact commands and demands the phrase
uv run cosmos-hub-counted --opponent-gid <gid> \
    --their-cop-url https://... --their-thief-url https://... [--windows 6]
# type: ARM COUNTED
# The CLI sets data/control/counted.hold → the hub manager releases ports
# 8801/8802/8803, then the CLI spawns the parity relay itself (so the public /mcp
# stays live for a single-URL opponent) plus the armed serves in the foreground:
# ONE role-alternating series — parity split from the sorted gid pair, ONE shared
# absolute out dir under /data/runs/shared/<stamp>, exactly one closer. The hold
# clears when they exit and the rule-52 ledger twin is synced to the volume.
# 3) REPORTING IS A SEPARATE DELIBERATE STEP — nothing sends automatically.
#    After settlement the CLI prints the ONE report command against the single
#    shared result artifact. Run it as a dry run first, then with --send:
#    uv run cosmos-cop report /data/runs/shared/<stamp>/result_<game_id>.json --counted   # dry
#    uv run cosmos-cop report /data/runs/shared/<stamp>/result_<game_id>.json --counted --send
```

`cosmos-hub-counted` refuses when stdin is not a TTY, so no web process, cron job or
CI step can ever invoke it. Admin `/api/admin/run` additionally 403s `kind=counted`
and any argv containing `--counted` — both rails are covered by tests.

While the hold file exists the manager stops its own tracked relay; the counted CLI
then owns port 8803 with a relay whose `--odd-url`/`--even-url` match the run's
gid-sort parity, so the single-URL `/mcp` keeps working for the counted opponent —
the hub's `/mcp` proxy keeps pointing at 127.0.0.1:8803 no matter who owns the
process. Opponents on per-role URLs use `/cop/mcp` + `/thief/mcp` matched to the
windows the CLI prints. If the relay ever needs a manual restart, mirror the same
parity by hand: `cd /app/COSMOS77-cop && uv run python scripts/sparring_relay.py
--port 8803 --odd-url http://127.0.0.1:<odd-owner port>/mcp --even-url
http://127.0.0.1:<other port>/mcp` (first-sorted gid is cop on odd windows).

## Layout

`src/cosmos_hub/` — `config` (env + volume layout), `persist` (run migration +
ledger sync), `argvs` (spawn command lines incl. the parity topology), `manager`
(subprocess lifecycle: agents + relay), `proxy` (MCP reverse proxy incl. `/mcp`),
`events`/`livehub`/`envelopes`/`broadcast`/`ws` (live pipeline),
`replay`/`frames`/`belief` (settled replays + seal verification + ghost trace),
`challenge` (public rate-limited runs), `doctor` (public pairing diagnosis),
`pair` (pairing packets via the cop repo), `admin` (HMAC-cookie ops), `status_api`,
`pages`, `counted_cli`. Templates and `static/` are Track C property; the hub
serves them by exact filename. All artifacts under the volume `runs/` trees are
read-only bytes to the hub — never rewritten, never pretty-printed.
