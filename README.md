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
  │   ├─ / /replay/{id} /docs /league /admin  (templates, Track C)    │
  │   ├─ /api/status /api/runs /api/challenge /api/pair /api/replays  │
  │   ├─ /api/admin/run|stop|logs|report-dry-run  (cookie-auth)       │
  │   ├─ /ws/live?perspective=police|thief  (snapshot then stream)    │
  │   └─ manager: spawns/stops ▼ and tails their runs/<stamp>/ files  │
  │  COSMOS77-cop  subprocess  (uv venv, port 8801)                   │
  │  COSMOS77-thief subprocess (uv venv, port 8802)                   │
  └───────────────────────────────────────────────────────────────────┘
```

- **Standing posture** — when no run is active both agents run the transport-only ASGI
  app (`uvicorn <pkg>.net.asgi:app`), so the published endpoints answer 406 to a bare
  GET around the clock. A configured run swaps in `serve --peer-url ... --events`.
- **Proxy contract** (non-negotiable): no redirects at the published paths, methods
  GET/POST/DELETE, `Accept` / `Content-Type` / `mcp-session-id` /
  `mcp-protocol-version` preserved both directions, `Host` rewritten to the upstream
  bind, SSE streamed unbuffered, plain 502 while an agent is down, no auth/cookies.
- **Event pipeline** — each side appends its own local truth to
  `runs/<stamp>/events.jsonl`; the hub tails both repos, assigns the only `seq`, and
  fans out per-perspective envelopes (`view|window_end|series_end|status|snapshot`).
  The live channel never contains opponent truth (rules 8–9).
- **Replay** — when a series settles the hub rebuilds the bird's-eye timeline from the
  window logs (positions are mutually revealed post-audit), re-verifies every
  commit (`SHA256(canonical_json(payload)+"|"+nonce)`) and stores
  `data/replays/<run_id>.json` (`verify.verdict`: `Verified OK` / `TAMPERED`).
- **Counted rail** — every web-reachable run path refuses `kind=counted` and any
  `--counted` argv with 403 (pinned by tests). Counted runs exist only through the
  SSH-only `cosmos-hub-counted` CLI below.

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
| `HUB_PUBLIC_URL` | no | published base URL; defaults to `https://$RAILWAY_PUBLIC_DOMAIN` |
| `HUB_DATA_DIR` | no (default `./data`) | volume mount point (`/data` on Railway) |
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
   `COP_REPO_URL` / `THIEF_REPO_URL` point at the two GitHub repos.
3. Attach a volume at `/data` and set `HUB_DATA_DIR=/data`.
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
# The CLI sets data/control/counted.hold → the hub manager releases ports 8801/8802,
# the armed serves run in the foreground, and the hold clears when they exit.
# 3) after settlement, send BOTH reports (printed by the CLI):
#    uv run cosmos-cop  report runs/<stamp>/result_<gid>.json --counted --send
#    uv run cosmos-thief report runs/<stamp>/result_<gid>.json --counted --send
```

`cosmos-hub-counted` refuses when stdin is not a TTY, so no web process, cron job or
CI step can ever invoke it. Admin `/api/admin/run` additionally 403s `kind=counted`
and any argv containing `--counted` — both rails are covered by tests.

## Layout

`src/cosmos_hub/` — `config` (env), `manager` (subprocess lifecycle), `proxy` (MCP
reverse proxy), `events`/`envelopes`/`broadcast`/`ws` (live pipeline), `replay`/
`frames` (settled replays + seal verification), `challenge` (public rate-limited
runs), `pair` (pairing packets via the cop repo), `admin` (HMAC-cookie ops),
`status_api`, `pages`, `counted_cli`. Templates and `static/` are Track C property;
the hub serves them by exact filename. All artifacts under `runs/` are read-only
bytes to the hub — never rewritten, never pretty-printed.
