/* net.js — the wire layer. One job: deliver envelopes to a callback.
   Real socket: WS /ws/live?perspective=police|thief (ONE perspective per
   socket — the switcher must close this socket before opening the other; the
   live channel never fuses perspectives). Reconnect: exponential backoff
   1s..15s cap with full jitter; on open sends {type:"hello", last_seq} and
   the hub answers with one snapshot then the tail. close(1006) is routine
   (free-tier spin-down) — keep backing off, surface a pill, never throw.
   Demo socket: feeds a fixture file through the SAME callback path. */

const BACKOFF_BASE = 1000;
const BACKOFF_CAP = 15000;
const PING_EVERY = 25000;

export function connectLive({ perspective, lastSeq = 0, onEnvelope, onLink }) {
  let ws = null;
  let closed = false;
  let attempts = 0;
  let pingTimer = null;
  let retryTimer = null;
  let last = lastSeq;

  const url = () =>
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host + "/ws/live?perspective=" + encodeURIComponent(perspective);

  function link(stateName) { if (onLink) onLink(stateName, attempts); }

  function open() {
    if (closed) return;
    link(attempts === 0 ? "connecting" : "reconnecting");
    try { ws = new WebSocket(url()); } catch (_e) { retry(); return; }
    ws.onopen = () => {
      attempts = 0;
      link("open");
      try { ws.send(JSON.stringify({ type: "hello", last_seq: last })); } catch (_e) { /* noop */ }
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: "ping" })); } catch (_e) { /* noop */ }
        }
      }, PING_EVERY);
    };
    ws.onmessage = (m) => {
      let env = null;
      try { env = JSON.parse(m.data); } catch (_e) { return; }
      if (env && typeof env.seq === "number") last = Math.max(last, env.seq);
      onEnvelope(env);
    };
    ws.onclose = () => { clearInterval(pingTimer); if (!closed) retry(); };
    ws.onerror = () => { /* onclose follows; never throw */ };
  }

  function retry() {
    attempts += 1;
    link("reconnecting");
    const cap = Math.min(BACKOFF_CAP, BACKOFF_BASE * Math.pow(2, attempts - 1));
    const wait = Math.random() * cap; // full jitter
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, wait);
  }

  open();
  return {
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      if (ws) { try { ws.close(); } catch (_e) { /* noop */ } }
      link("closed");
    },
    get lastSeq() { return last; },
  };
}

/* Demo mode (?demo=1): a fake socket over static/fixtures/demo-live.json.
   The fixture is ONE run's envelope array covering BOTH perspectives in a
   single hub seq space — exactly what the hub composes — and this fake
   socket filters to the requested perspective just like the server does.
   Everything downstream (timeline/director/hud) is the identical code path. */
/* Shared demo tape position. The tape plays on ONE wall clock across perspective
   switches — switching feeds re-opens the socket but must NOT rewind the game
   (the user's cop-back-at-start bug). Only an explicit restart (the START button)
   rewinds. Position indexes the FULL unfiltered envelope array so both feeds
   stay on the same moment of the run. */
const demoTape = { url: null, all: null, pos: 0 };

export function connectDemo({ perspective, onEnvelope, onLink,
  fixtureUrl = "/static/fixtures/demo-live.json", stepMs = 650, resume = false }) {
  let closed = false;
  let timer = null;

  if (!resume || demoTape.url !== fixtureUrl) {
    demoTape.url = fixtureUrl;
    demoTape.all = null;
    demoTape.pos = 0;
  }

  const start = (all) => {
    if (closed) return;
    if (onLink) onLink("open", 0);
    // catch up instantly to the shared tape position (timeline burst-compresses),
    // exactly like the live socket's snapshot-on-connect. Catch-up deliveries are
    // MARKED (catchup:true on a copy — the shared tape stays clean) so the HUD
    // can skip slam/strip flourishes for events the viewer already lived through.
    for (let i = 0; i < demoTape.pos; i += 1) {
      const env = all[i];
      if (env && env.perspective === perspective) onEnvelope({ ...env, catchup: true });
    }
    // then keep playing the tape forward on the shared clock
    if (demoTape.pos === 0) {
      // burst the opening beat so the world isn't empty for stepMs
      const burst = Math.min(2, all.length);
      while (demoTape.pos < burst) {
        const env = all[demoTape.pos];
        demoTape.pos += 1;
        if (env && env.perspective === perspective) onEnvelope(env);
      }
    }
    timer = setInterval(() => {
      if (closed) return;
      if (demoTape.pos >= all.length) {
        clearInterval(timer);
        if (onLink) onLink("demo-done", 0);
        return;
      }
      const env = all[demoTape.pos];
      demoTape.pos += 1;
      if (env && env.perspective === perspective) onEnvelope(env);
    }, stepMs / 2); // full array holds BOTH perspectives interleaved — half-step keeps per-feed cadence
  };

  if (demoTape.all) start(demoTape.all);
  else {
    fetch(fixtureUrl, { cache: "no-store" })
      .then((r) => r.json())
      .then((all) => { demoTape.all = all; start(all); })
      .catch(() => { if (onLink) onLink("demo-error", 0); });
  }

  return {
    close() { closed = true; clearInterval(timer); if (onLink) onLink("closed", 0); },
    get lastSeq() { return 0; },
  };
}

/* Tiny fetch helpers shared by the HUD chrome (status strip, challenge). */
export async function getJSON(path) {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

export async function postJSON(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status: r.status, data });
  return data;
}
