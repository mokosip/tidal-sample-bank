// Shell: shared state, API calls, throttled preview, filters, inspector, view switch,
// global keys. Views (list.js, later map.js) register themselves via registerView().
//
// Events passed to onChange listeners as (what, detail):
//   "samples"  whole sample list replaced     "filters"  filters changed
//   "select"   state.selectedId changed       "sample"   one sample updated (detail = id)
//   "status"   /api/status polled             "view"     state.view changed
import { throttle } from "./throttle.js";
import { createInspector, snippet } from "./inspector.js";

// Same order as samplebank.config.TYPES; keys 1-9, 0, - pick them.
export const TYPES = ["kick", "snare", "hat", "perc", "bass", "tonal", "voice", "texture", "loop", "fx", "other"];
export const TYPE_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-"];

export const state = {
  samples: [],
  filters: { type: null, tag: null, star: false, unused: false, q: "" },
  selectedId: null,
  view: "list",
  status: { dirt: true, samples: 0, analysing: false },
};
const byId = new Map();

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(what, detail) {
  for (const fn of listeners) fn(what, detail);
}

export const sampleById = (id) => byId.get(id) ?? null;
export const selected = () => sampleById(state.selectedId);

// ---------- API ----------
const encodeId = (id) => id.split("/").map(encodeURIComponent).join("/");

export const play = throttle((id) => {
  fetch("/api/play", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch(() => {}); // previews are best effort
}, 60);

export async function patch(id, fields) {
  let res;
  try {
    res = await fetch(`/api/samples/${encodeId(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
  } catch {
    toast("save failed: server not reachable");
    return null;
  }
  if (!res.ok) {
    toast(`save failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
    return null;
  }
  const updated = await res.json();
  const i = state.samples.findIndex((s) => s.id === id);
  if (i >= 0) state.samples[i] = updated;
  byId.set(id, updated);
  emit("sample", id);
  return updated;
}

const byBankN = (a, b) => (a.bank < b.bank ? -1 : a.bank > b.bank ? 1 : a.n - b.n || (a.source < b.source ? -1 : 1));

export async function loadSamples() {
  const res = await fetch("/api/samples");
  if (!res.ok) return;
  state.samples = (await res.json()).sort(byBankN);
  byId.clear();
  for (const s of state.samples) byId.set(s.id, s);
  emit("samples");
}

// ---------- filters ----------
export function matches(s, f = state.filters) {
  if (f.type && s.type !== f.type) return false;
  if (f.tag && !s.tags.includes(f.tag)) return false;
  if (f.star && !s.star) return false;
  if (f.unused && s.used !== 0) return false;
  if (f.q) {
    const hay = `${s.bank}:${s.n} ${s.filename} ${s.type} ${s.tags.join(" ")}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  return true;
}
export const visibleSamples = () => state.samples.filter((s) => matches(s));

export function setFilter(partial) {
  Object.assign(state.filters, partial);
  emit("filters");
}

// ---------- selection ----------
export function select(id, { audition = true } = {}) {
  if (id !== state.selectedId) {
    state.selectedId = id;
    emit("select");
  }
  if (audition && id) play(id);
}

// ---------- actions on the selected sample ----------
export async function copy(s) {
  const text = snippet(s);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(`copied  ${text}`);
}

let toastTimer;
export function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1400);
}

// ---------- views ----------
const views = new Map();
let mounted = null;
export function registerView(name, view) {
  views.set(name, view); // view: { mount(el), unmount(), onKey(e) -> bool }
}
export function setView(name) {
  if (!views.has(name)) return;
  const el = document.getElementById("view");
  if (mounted) mounted.unmount?.();
  el.replaceChildren();
  state.view = name;
  mounted = views.get(name);
  mounted.mount(el);
  const url = new URL(location.href);
  url.searchParams.set("view", name);
  history.replaceState(null, "", url);
  emit("view");
}

// ---------- shell rendering ----------
let inspector;
const $ = (id) => document.getElementById(id);

function chip(label, { on = false, key = null, title = "" } = {}) {
  const b = document.createElement("button");
  b.className = "chip filter" + (on ? " on" : "");
  if (key) {
    const k = document.createElement("kbd");
    k.textContent = key;
    b.append(k);
  }
  b.append(label);
  b.title = title;
  return b;
}

function renderFilters() {
  const f = state.filters;
  const counts = {};
  const tagCounts = {};
  for (const s of state.samples) {
    counts[s.type] = (counts[s.type] ?? 0) + 1;
    for (const t of s.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  }

  const types = $("filter-types");
  types.replaceChildren(
    ...TYPES.map((t, i) => {
      const b = chip(`${t} ${counts[t] ?? 0}`, { on: f.type === t, key: TYPE_KEYS[i], title: `filter type ${t} (key ${TYPE_KEYS[i]} sets the selected sample's type)` });
      b.onclick = () => setFilter({ type: f.type === t ? null : t });
      return b;
    }),
  );

  const tags = $("filter-tags");
  const items = [];
  if (f.tag) {
    const b = chip(`tag: ${f.tag} ✕`, { on: true, title: "clear tag filter" });
    b.onclick = () => setFilter({ tag: null });
    items.push(b);
  }
  const sel = document.createElement("select");
  sel.className = "tag-select";
  const names = Object.keys(tagCounts).sort();
  sel.append(new Option(names.length ? "tag…" : "no tags yet", ""));
  for (const t of names) sel.append(new Option(`${t} (${tagCounts[t]})`, t));
  sel.disabled = !names.length;
  sel.onchange = () => {
    sel.blur();
    if (sel.value) setFilter({ tag: sel.value });
  };
  items.push(sel);

  const star = chip("★ starred", { on: f.star });
  star.onclick = () => setFilter({ star: !f.star });
  const unused = chip("unused only", { on: f.unused, title: "banks not used in any .tidal file" });
  unused.onclick = () => setFilter({ unused: !f.unused });
  items.push(star, unused);
  if (f.type || f.tag || f.star || f.unused || f.q) {
    const clear = chip("clear all", { title: "reset filters" });
    clear.classList.add("clear");
    clear.onclick = () => {
      $("search").value = "";
      setFilter({ type: null, tag: null, star: false, unused: false, q: "" });
    };
    items.push(clear);
  }
  tags.replaceChildren(...items);
}

function renderStatus() {
  const st = state.status;
  $("banner").hidden = st.dirt;
  $("status").textContent = st.analysing ? "analysing…" : "";
  $("status").classList.toggle("busy", st.analysing);
  for (const b of document.querySelectorAll("[data-view]")) {
    b.classList.toggle("on", b.dataset.view === state.view);
    b.disabled = !views.has(b.dataset.view);
  }
}

function renderCount() {
  $("count").textContent = `${visibleSamples().length} / ${state.samples.length}`;
}

// ---------- polling ----------
async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const next = await res.json();
    const prev = state.status;
    state.status = next;
    emit("status");
    if ((prev.analysing && !next.analysing) || next.samples !== state.samples.length) await loadSamples();
  } catch {
    state.status = { ...state.status, dirt: false };
    emit("status");
  }
}

// ---------- keys ----------
const isTyping = (t) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTyping(e.target)) return; // search box / tag editor handle their own keys
  if (mounted?.onKey?.(e)) {
    e.preventDefault();
    return;
  }
  const s = selected();
  const ti = TYPE_KEYS.indexOf(e.key);
  if (e.key === "/") $("search").focus();
  else if (e.key === "m") setView("map");
  else if (e.key === "l") setView("list");
  else if (e.key === " ") s && play(s.id);
  else if (e.key === "f") s && patch(s.id, { star: !s.star }).then((u) => u && toast(u.star ? "★ starred" : "☆ unstarred"));
  else if (e.key === "t") inspector.editTags();
  else if (e.key === "y") s && copy(s);
  else if (ti >= 0) s && patch(s.id, { type: TYPES[ti] }).then((u) => u && toast(`type → ${u.type}`));
  else return;
  e.preventDefault();
}

// ---------- start ----------
export async function start() {
  inspector = createInspector($("inspector"), { patch, copy, play });

  onChange((what, id) => {
    if (what === "samples" || what === "filters" || what === "sample") {
      renderFilters();
      renderCount();
    }
    if (what === "status" || what === "view") renderStatus();
    if (what === "select" || what === "samples" || (what === "sample" && id === state.selectedId)) inspector.render(selected());
  });

  const search = $("search");
  search.addEventListener("input", () => setFilter({ q: search.value }));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") search.blur();
    else if (e.key === "Escape") {
      search.value = "";
      setFilter({ q: "" });
      search.blur();
    }
  });
  for (const b of document.querySelectorAll("[data-view]")) b.onclick = () => setView(b.dataset.view);
  // buttons must not keep focus, or space would click them instead of replaying
  document.addEventListener("click", (e) => e.target.closest?.("button")?.blur());
  document.addEventListener("keydown", onKey);

  const wanted = new URL(location.href).searchParams.get("view");
  setView(views.has(wanted) ? wanted : "list");
  renderFilters();
  await loadSamples();
  await pollStatus();
  setInterval(pollStatus, 3000);
}
