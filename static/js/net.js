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
