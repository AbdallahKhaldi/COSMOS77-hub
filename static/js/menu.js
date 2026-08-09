/* menu.js — the GTA-style ESC / pause menu (ARENA V3), shared by the arena
   and replay pages. MENU button or Escape opens a full-screen overlay: the
   world stays visible, blurred + dimmed behind (the veil's backdrop-filter).
   Left-aligned vertical Anton items, fully keyboard navigable (arrows +
   enter + home/end, Tab trapped inside, Escape closes, focus returns to the
   MENU button). CHALLENGE US expands IN the menu to the engage form (same
   /api/challenge wiring as the V2 drawer + our endpoint rows with COPY);
   REPLAYS expands to the settled-run list from /api/runs (▶ WATCH →
   /replay/{id}). LEAGUE / BRIEFING / OPS navigate. This menu REPLACES the
   old top navbar on the game pages. */

import { getJSON, postJSON } from "./net.js";
import { toast, wireCopyButtons } from "./hud.js";

const $ = (id) => document.getElementById(id);

/* generic collapse wiring for the replay page's right-side glass panels */
export function wireCollapse(scope) {
  (scope || document).querySelectorAll("[data-collapse]").forEach((head) => {
    head.addEventListener("click", () => {
      const panel = $(head.getAttribute("data-collapse"));
      if (!panel) return;
      const closed = panel.classList.toggle("closed");
      head.setAttribute("aria-expanded", String(!closed));
    });
  });
}

export function initMenu({ page = "arena", onStartDemo = null } = {}) {
  const menu = $("menu");
  const btn = $("menuBtn");
  if (!menu || !btn) return null;
  const list = $("menuList");
  const items = () => [...list.querySelectorAll(".menu-item")];
  let lastFocus = null;

  function isOpen() { return !menu.hidden; }

  function openMenu() {
    if (isOpen()) return;
    lastFocus = document.activeElement;
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    const first = items()[0];
    if (first) first.focus();
  }

  function closeMenu() {
    if (!isOpen()) return;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    (lastFocus && document.contains(lastFocus) ? lastFocus : btn).focus();
  }

  function toggleSub(item) {
    const sub = $(item.getAttribute("aria-controls"));
    if (!sub) return;
    const expanded = item.getAttribute("aria-expanded") === "true";
    item.setAttribute("aria-expanded", String(!expanded));
    sub.hidden = expanded;
    if (!expanded && sub.id === "mReplays") loadRuns();
  }

  /* ------------------------------ keyboard ------------------------------ */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (isOpen()) closeMenu(); else openMenu();
      return;
    }
    if (!isOpen()) return;
    const it = items();
    const onItem = it.indexOf(document.activeElement);
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && onItem !== -1) {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      it[(onItem + d + it.length) % it.length].focus();
    } else if (e.key === "Home" && onItem !== -1) {
      e.preventDefault(); it[0].focus();
    } else if (e.key === "End" && onItem !== -1) {
      e.preventDefault(); it[it.length - 1].focus();
    } else if (e.key === "Tab") {
      // trap: cycle through everything focusable inside the menu
      const foci = [...menu.querySelectorAll("button, a[href], input, [tabindex]")]
        .filter((el) => el.offsetParent !== null && !el.disabled);
      if (!foci.length) return;
      const i = foci.indexOf(document.activeElement);
      if (e.shiftKey && (i === 0 || i === -1)) { e.preventDefault(); foci[foci.length - 1].focus(); }
      else if (!e.shiftKey && i === foci.length - 1) { e.preventDefault(); foci[0].focus(); }
    }
  });

  btn.addEventListener("click", () => (isOpen() ? closeMenu() : openMenu()));
  menu.querySelectorAll("[data-menu-close]").forEach((veil) => {
    veil.addEventListener("click", closeMenu);
  });

  /* ------------------------------- actions ------------------------------ */
  list.addEventListener("click", (e) => {
    const item = e.target.closest(".menu-item");
    if (!item) return;
    const act = item.dataset.act;
    if (act === "resume") closeMenu();
    else if (act === "demo") {
      if (page === "arena" && onStartDemo) { closeMenu(); onStartDemo(); }
      else location.href = "/?demo=1"; // replay page: the demo lives on the arena
    } else if (act === "toggle") toggleSub(item);
    // plain <a> items (LEAGUE / BRIEFING / OPS) navigate natively
  });

  /* --------------------- CHALLENGE US (the engage form) ------------------ */
  (async () => {
    const epCop = $("epCop");
    if (!epCop) return;
    try {
      const st = await getJSON("/api/status");
      const eps = (st && (st.endpoints || st.urls)) || {};
      const cop = eps.cop || eps.cop_url || "";
      const thief = eps.thief || eps.thief_url || "";
      if (cop) { epCop.textContent = cop; $("epCopBtn").setAttribute("data-copy", cop); }
      if (thief) { $("epThief").textContent = thief; $("epThiefBtn").setAttribute("data-copy", thief); }
    } catch (_e) {
      epCop.textContent = "(backend offline — endpoints unavailable)";
      $("epThief").textContent = "(backend offline — endpoints unavailable)";
    }
  })();

  const go = $("chGo");
  if (go) {
    go.addEventListener("click", async () => {
      const single = $("chSingle").value.trim();
      const body = {
        kind: document.querySelector("#chKind button[aria-pressed='true']").dataset.kind,
        opponent_gid: $("chGid").value.trim() || "challenger",
        their_cop_url: single ? null : $("chCop").value.trim() || null,
        their_thief_url: single ? null : $("chThief").value.trim() || null,
        their_single_url: single || null,
      };
      const out = $("chResult");
      go.disabled = true;
      out.innerHTML = '<span class="mono c-road">dialing…</span>';
      try {
        const res = await postJSON("/api/challenge", body);
        // only trust site-relative watch URLs from the response (no schemes)
        let watch = String(res.watch_url || "/");
        if (!watch.startsWith("/") || watch.startsWith("//")) watch = "/";
        out.textContent = "";
        const row = document.createElement("div");
        row.className = "urlrow";
        const tag = document.createElement("span");
        tag.className = "tag cop"; tag.textContent = "WATCH";
        const code = document.createElement("code");
        code.textContent = watch;
        const copy = document.createElement("button");
        copy.className = "btn btn--copy"; copy.textContent = "COPY";
        copy.setAttribute("data-copy", watch);
        row.append(tag, code, copy);
        const note = document.createElement("p");
        note.className = "sub mono";
        note.textContent = `run ${res.run_id || "?"} accepted — the bodycam goes live when the handshake lands.`;
        out.append(row, note);
        wireCopyButtons(out);
        toast("CHALLENGE ACCEPTED");
      } catch (e) {
        const msg = (e.data && (e.data.detail || e.data.error)) || e.message;
        out.textContent = "";
        const p = document.createElement("p");
        p.className = "sub c-siren mono";
        p.textContent = "refused: " + String(msg);
        out.appendChild(p);
      } finally {
        go.disabled = false;
      }
    });
    document.querySelectorAll("#chKind button").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("#chKind button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      });
    });
  }

  /* ------------------------ REPLAYS (settled runs) ------------------------ */
  function runRow({ rid, meta, watch }) {
    const row = document.createElement("div");
    row.className = "runrow";
    const ridEl = document.createElement("span");
    ridEl.className = "rid"; ridEl.textContent = rid;
    const metaEl = document.createElement("span");
    metaEl.className = "meta"; metaEl.textContent = meta;
    row.append(ridEl, metaEl);
    if (watch) { // watch URLs are self-constructed ("/replay/…"), never remote
      const a = document.createElement("a");
      a.href = watch;
      a.textContent = "▶ Watch";
      row.appendChild(a);
    }
    return row;
  }

  async function loadRuns() {
    const box = $("runsList");
    if (!box) return;
    box.innerHTML = "";
    box.appendChild(runRow({ rid: "demo-tape", meta: "fixture · 2 windows", watch: "/replay/demo?demo=1" }));
    try {
      const runs = await getJSON("/api/runs");
      const arr = Array.isArray(runs) ? runs : [];
      let shown = 0;
      for (const r of arr) {
        if (!r || !r.run_id) continue;
        if (r.settled === false) continue; // settled games only — legality
        const noReplay = r.has_replay === false || r.replay === false || r.replay_available === false;
        const sc = r.score && typeof r.score === "object" ? r.score : r;
        const scoreTxt = (sc.us ?? "—") + "–" + (sc.them ?? "—");
        const meta = [r.opponent_gid, r.kind, scoreTxt, r.verdict].filter(Boolean).join(" · ");
        box.appendChild(runRow({
          rid: r.run_id,
          meta: meta + (noReplay ? " · no replay" : ""),
          watch: noReplay ? null : "/replay/" + encodeURIComponent(r.run_id),
        }));
        shown += 1;
        if (shown >= 20) break;
      }
      if (!shown) {
        box.appendChild(runRow({ rid: "no settled runs yet", meta: "challenge us to make one", watch: null }));
      }
    } catch (_e) {
      box.appendChild(runRow({ rid: "backend offline", meta: "run list unavailable", watch: null }));
    }
  }

  wireCopyButtons(menu);
  return { open: openMenu, close: closeMenu, isOpen };
}
