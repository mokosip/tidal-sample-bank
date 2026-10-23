// Sound map (digging view): one dot per sample at its UMAP (x, y), coloured by type.
// Drag pans, wheel zooms around the cursor, r resets. Hover plays (throttled in app.js),
// click selects (shared inspector + selection). Filters dim non-matching dots.
// Redraws are rAF-coalesced and happen only when something changed.
import { state, onChange, registerView, select, setFilter, matches, sampleById, play, loadSamples, toast, TYPES } from "./app.js";
import { name } from "./inspector.js";
import { fitView, toScreen, toWorld, zoomAt, buildGrid, nearest, kNearest } from "./mapmath.js";

// Similar lightness, distinct hues, warm-leaning; kick carries the UI amber, "other" recedes.
export const TYPE_COLORS = {
  kick: "#ffb347",
  snare: "#ff6f5e",
  hat: "#5fd0c0",
  perc: "#d9d35a",
  bass: "#86c25a",
  tonal: "#74a6ff",
  voice: "#ff86c0",
  texture: "#b590ff",
  loop: "#f1e2c4",
  fx: "#e46be6",
  other: "#8c7e6c",
};
const DIM_ALPHA = 0.15;
const HIT_PX = 10;          // hover/click radius in CSS pixels
const PAD = 24;
const NEIGHBOURS = 5;
const NAME_LABELS_MAX = 400; // zoomed in so far that at most this many dots show: name those that fit
const debug = new URL(location.href).searchParams.has("debug");

let wrap, canvas, ctx, legend, tools, rebuildBtn, fpsEl, neighEl, hintEl, off, ro;
let W = 0, H = 0, dpr = 1;
let view = null;            // kept across list <-> map switches
let fit = null;
let touched = false;        // user panned/zoomed: keep the view on resize
let grid = null;
let hover = -1;             // index into state.samples
let drag = null;
let raf = 0;
let draws = 0, lastDrawMs = 0;

const placed = (s) => s.x != null && s.y != null;

// ---------- drawing ----------
function requestDraw() {
  if (!raf) raf = requestAnimationFrame(draw);
}

function dotRadius() {
  return Math.min(6, 3 * (view.scale / fit.scale) ** 0.35);
}

function draw() {
  raf = 0;
  if (!ctx) return;
  const t0 = performance.now();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const samples = state.samples;
  if (!samples.length) {
    label("loading…", W / 2 - 30, H / 2, "#6b5539");
    return;
  }
  const r = dotRadius();
  const { scale, ox, oy } = view;
  const shown = [];
  // two passes (dimmed, then matching on top); one path + one fill per type and pass
  for (const dim of [true, false]) {
    ctx.globalAlpha = dim ? DIM_ALPHA : 1;
    for (const t of TYPES) {
      ctx.beginPath();
      let any = false;
      for (const s of samples) {
        if (s.type !== t || !placed(s)) continue;
        if (matches(s) === dim) continue;
        const sx = ox + s.x * scale, sy = oy + s.y * scale;
        if (sx < -r || sy < -r || sx > W + r || sy > H + r) continue;
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        any = true;
        if (!dim) shown.push(s);
      }
      if (any) {
        ctx.fillStyle = TYPE_COLORS[t] ?? TYPE_COLORS.other;
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
  if (shown.length <= NAME_LABELS_MAX) {
    ctx.font = '11px "IBM Plex Mono", "Berkeley Mono", ui-monospace, Menlo, monospace';
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#9a7442";
    const taken = []; // label boxes already drawn: skip any label that would overlap one
    const skip = new Set([state.selectedId, samples[hover]?.id]); // these get a boxed label
    for (const s of shown) {
      if (skip.has(s.id)) continue;
      const t = name(s);
      const x = ox + s.x * scale + r + 4, y = oy + s.y * scale;
      const w = ctx.measureText(t).width;
      if (taken.some((b) => x < b[0] + b[2] && b[0] < x + w && Math.abs(b[1] - y) < 13)) continue;
      taken.push([x, y, w]);
      ctx.fillText(t, x, y);
    }
  }

  const sel = state.selectedId ? samples.findIndex((s) => s.id === state.selectedId) : -1;
  if (sel >= 0 && placed(samples[sel])) mark(samples[sel], r, "#ffd08a", true);
  if (hover >= 0 && hover !== sel) mark(samples[hover], r, TYPE_COLORS[samples[hover].type] ?? "#e3a75f", false);

  lastDrawMs = performance.now() - t0;
  draws++;
}

function mark(s, r, color, selected) {
  const [sx, sy] = toScreen(view, s.x, s.y);
  ctx.beginPath();
  ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.shadowColor = "rgba(255, 180, 95, 0.6)";
  ctx.shadowBlur = selected ? 8 : 0;
  ctx.stroke();
  ctx.shadowBlur = 0;
  label(selected ? `▶ ${name(s)}` : name(s), sx + r + 8, sy - r - 6, selected ? "#ffd08a" : "#e3a75f");
}

function label(text, x, y, color) {
  ctx.font = '12px "IBM Plex Mono", "Berkeley Mono", ui-monospace, Menlo, monospace';
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width;
  if (x + w + 6 > W) x = Math.max(4, x - w - 30); // flip left at the right edge
  y = Math.max(10, Math.min(H - 10, y));
  ctx.fillStyle = "rgba(6, 4, 2, 0.85)";
  ctx.fillRect(x - 4, y - 9, w + 8, 18);
  ctx.strokeStyle = "#4a3a26";
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 3.5, y - 8.5, w + 7, 17);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + 0.5);
}

// ---------- geometry ----------
function resize() {
  const rect = wrap.getBoundingClientRect();
  W = Math.max(1, Math.round(rect.width));
  H = Math.max(1, Math.round(rect.height));
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  fit = fitView(W, H, PAD);
  if (!view || !touched) view = fit;
  requestDraw();
}

function resetView() {
  touched = false;
  view = fit;
  requestDraw();
}

function hitAt(sx, sy) {
  if (!grid) return -1;
  const [wx, wy] = toWorld(view, sx, sy);
  return nearest(grid, state.samples, wx, wy, HIT_PX / view.scale);
}

function rebuildGrid() {
  grid = buildGrid(state.samples, 64);
  hover = -1;
}

// keep the selection on screen when it changes from outside the canvas (neighbour links)
function reveal() {
  const s = sampleById(state.selectedId);
  if (!s || !placed(s)) return;
  const [sx, sy] = toScreen(view, s.x, s.y);
  if (sx < 40 || sy < 40 || sx > W - 40 || sy > H - 40) {
    view = { ...view, ox: view.ox + W / 2 - sx, oy: view.oy + H / 2 - sy };
    touched = true;
  }
}

// ---------- pointer ----------
function local(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function setHover(i) {
  if (i === hover) return;
  hover = i;
  canvas.style.cursor = drag ? "grabbing" : i >= 0 ? "pointer" : "crosshair";
  if (i >= 0) play(state.samples[i].id);
  requestDraw();
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const [x, y] = local(e);
  drag = { x, y, ox: view.ox, oy: view.oy, moved: false, id: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  const [x, y] = local(e);
  if (drag) {
    const dx = x - drag.x, dy = y - drag.y;
    if (!drag.moved && dx * dx + dy * dy < 9) return;
    if (!drag.moved) {
      drag.moved = true;
      canvas.style.cursor = "grabbing";
      hover = -1;
    }
    view = { ...view, ox: drag.ox + dx, oy: drag.oy + dy };
    touched = true;
    requestDraw();
    return;
  }
  setHover(hitAt(x, y));
}

function onPointerUp(e) {
  if (!drag) return;
  const wasClick = !drag.moved;
  drag = null;
  canvas.releasePointerCapture?.(e.pointerId);
  const [x, y] = local(e);
  const i = hitAt(x, y);
  if (wasClick && i >= 0) select(state.samples[i].id); // select() auditions it
  hover = i; // silently: no second preview for the dot that was just clicked or dropped on
  canvas.style.cursor = i >= 0 ? "pointer" : "crosshair";
  requestDraw();
}

function onWheel(e) {
  e.preventDefault();
  const [x, y] = local(e);
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
  const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));
  view = zoomAt(view, x, y, factor, { min: fit.scale * 0.5, max: fit.scale * 60 });
  touched = true;
  hover = -1;
  requestDraw();
}

// ---------- legend, tools, neighbours ----------
function renderLegend() {
  const counts = {};
  let pending = 0;
  for (const s of state.samples) {
    counts[s.type] = (counts[s.type] ?? 0) + 1;
    if (!placed(s)) pending++;
  }
  const active = state.filters.type;
  const items = TYPES.map((t) => {
    const b = document.createElement("button");
    b.className = "map-leg" + (active === t ? " on" : "") + (active && active !== t ? " off" : "");
    b.title = active === t ? "clear type filter" : `show only ${t}`;
    const sw = document.createElement("i");
    sw.style.background = TYPE_COLORS[t];
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = counts[t] ?? 0;
    b.append(sw, t, n);
    b.onclick = () => setFilter({ type: active === t ? null : t });
    return b;
  });
  if (pending) {
    const p = document.createElement("div");
    p.className = "map-pending";
    p.textContent = `${pending} not placed yet (analysing)`;
    items.push(p);
  }
  legend.replaceChildren(...items);
}

function renderNeighbours() {
  const i = state.selectedId ? state.samples.findIndex((s) => s.id === state.selectedId) : -1;
  const near = i >= 0 ? kNearest(state.samples, i, NEIGHBOURS) : [];
  neighEl.hidden = i < 0;
  if (i < 0) return;
  const head = document.createElement("div");
  head.className = "insp-label";
  head.textContent = "neighbours on the map";
  const list = document.createElement("div");
  list.className = "neigh-list";
  if (!near.length) list.append(Object.assign(document.createElement("span"), { className: "insp-none", textContent: "not placed yet" }));
  for (const j of near) {
    const s = state.samples[j];
    const b = document.createElement("button");
    b.className = "neigh";
    b.title = `${s.type} · ${s.id}`;
    const sw = document.createElement("i");
    sw.style.background = TYPE_COLORS[s.type] ?? TYPE_COLORS.other;
    b.append(sw, name(s));
    b.onclick = () => select(s.id);
    b.onmouseenter = () => play(s.id);
    list.append(b);
  }
  neighEl.replaceChildren(head, list);
}

const coordSig = () => state.samples.map((s) => `${s.x},${s.y}`).join(";");
let rebuilding = false;

async function rebuildMap() {
  if (rebuilding) return;
  const before = coordSig();
  let res;
  try {
    res = await fetch("/api/rebuild-map", { method: "POST" });
  } catch {
    toast("rebuild failed: server not reachable");
    return;
  }
  if (!res.ok) {
    toast(`rebuild failed: ${res.status}`);
    return;
  }
  rebuilding = true;
  renderTools();
  // the server holds its rebuild lock from the 202 on; poll the cheap status until it lets go
  const t0 = Date.now();
  let done = false;
  while (!done && Date.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      done = (await (await fetch("/api/status")).json()).rebuilding === false;
    } catch {
      // server briefly unreachable: keep polling until the cap
    }
  }
  rebuilding = false;
  renderTools();
  if (!done) {
    toast("rebuild still running after 60 s — reload later to see the new map");
    return;
  }
  if (!(await loadSamples())) {
    toast("map rebuilt, but reloading samples failed");
    return;
  }
  toast(coordSig() === before ? "map rebuilt — layout unchanged" : "map rebuilt");
}

function renderTools() {
  if (!rebuildBtn) return;
  rebuildBtn.textContent = rebuilding ? "rebuilding…" : "rebuild map";
  rebuildBtn.disabled = rebuilding;
}

function startFps() {
  let frames = 0, t0 = performance.now(), d0 = draws;
  const tick = (now) => {
    if (!fpsEl) return;
    frames++;
    if (now - t0 >= 1000) {
      const secs = (now - t0) / 1000;
      fpsEl.textContent = `fps ${Math.round(frames / secs)} · draws/s ${Math.round((draws - d0) / secs)} · draw ${lastDrawMs.toFixed(1)} ms`;
      window.__mapFps = { fps: frames / secs, drawsPerSec: (draws - d0) / secs, drawMs: lastDrawMs };
      frames = 0;
      t0 = now;
      d0 = draws;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function onState(what, id) {
  if (what === "samples") {
    rebuildGrid();
    renderLegend();
    renderNeighbours();
  } else if (what === "sample") {
    renderLegend();
    if (id === state.selectedId) renderNeighbours();
  } else if (what === "filters") {
    renderLegend();
  } else if (what === "select") {
    reveal();
    renderNeighbours();
  } else return;
  requestDraw();
}

const h = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text ?? "" });

registerView("map", {
  mount(el) {
    el.classList.add("view-map");
    wrap = h("div", "map-wrap");
    canvas = h("canvas", "map-canvas");
    canvas.style.cursor = "crosshair";
    ctx = canvas.getContext("2d");
    legend = h("div", "map-legend");
    tools = h("div", "map-tools");
    const reset = h("button", "map-btn", "");
    reset.append(Object.assign(document.createElement("kbd"), { textContent: "r" }), "reset view");
    reset.onclick = resetView;
    rebuildBtn = h("button", "map-btn", "rebuild map");
    rebuildBtn.title = "recompute all positions (POST /api/rebuild-map)";
    rebuildBtn.onclick = rebuildMap;
    tools.append(reset, rebuildBtn);
    wrap.append(canvas, legend, tools);
    if (debug) {
      fpsEl = h("div", "map-fps", "fps …");
      wrap.append(fpsEl);
      startFps();
    }
    el.append(wrap);

    neighEl = h("div", "insp-neigh");
    document.getElementById("inspector").append(neighEl);
    hintEl = h("span", "map-hint", "");
    hintEl.append(Object.assign(document.createElement("kbd"), { textContent: "r" }), "reset view · drag pan · wheel zoom · hover play");
    document.querySelector("footer.keys").append(hintEl);
    document.body.dataset.view = "map";

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", () => (drag = null));
    canvas.addEventListener("pointerleave", () => !drag && setHover(-1));
    canvas.addEventListener("wheel", onWheel, { passive: false });
    ro = new ResizeObserver(resize);
    ro.observe(wrap);

    off = onChange(onState);
    rebuildGrid();
    renderLegend();
    renderTools();
    renderNeighbours();
    resize();
    if (debug) window.__map = { get view() { return view; }, get draws() { return draws; }, get drawMs() { return lastDrawMs; } };
  },
  unmount() {
    off?.();
    ro?.disconnect();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    neighEl?.remove();
    hintEl?.remove();
    delete document.body.dataset.view;
    document.getElementById("view").classList.remove("view-map");
    ctx = canvas = wrap = legend = tools = rebuildBtn = fpsEl = neighEl = hintEl = null;
    drag = null;
    hover = -1;
  },
  onKey(e) {
    if (e.key === "r") resetView();
    else return false;
    return true;
  },
});
