// Fast list view: dense table, j/k move and audition, click to select + play.
import { state, onChange, registerView, visibleSamples, select, matches, sampleById } from "./app.js";
import { name, fmtDuration } from "./inspector.js";

let table, tbody, off;
let ids = [];         // visible ids in row order
let cursor = 0;       // row index of the selection (kept when the selected row drops out)
const rowById = new Map();

function td(text, cls) {
  const c = document.createElement("td");
  if (cls) c.className = cls;
  c.textContent = text;
  return c;
}

function row(s) {
  const tr = document.createElement("tr");
  tr.dataset.id = s.id;
  const nm = td("", "c-name");
  nm.append(name(s), s.star ? Object.assign(document.createElement("span"), { className: "star", textContent: "★" }) : "");
  nm.title = s.id;
  const type = td("", "c-type");
  type.append(Object.assign(document.createElement("span"), { className: "chip type", textContent: s.type }));
  const tags = td("", "c-tags");
  for (const t of s.tags) tags.append(Object.assign(document.createElement("span"), { className: "chip", textContent: t }));
  tr.append(nm, td(fmtDuration(s.duration), "c-dur"), type, tags, td(s.used ? `${s.used}×` : "—", "c-used"));
  if (s.id === state.selectedId) tr.classList.add("sel");
  return tr;
}

function rebuild(keepCursor = false) {
  const list = visibleSamples();
  ids = list.map((s) => s.id);
  rowById.clear();
  const frag = document.createDocumentFragment();
  for (const s of list) {
    const tr = row(s);
    rowById.set(s.id, tr);
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
  if (!list.length) {
    const tr = document.createElement("tr");
    tr.className = "empty";
    tr.append(Object.assign(td(state.samples.length ? "no samples match the filters" : "loading…"), { colSpan: 5 }));
    tbody.append(tr);
  }
  const i = ids.indexOf(state.selectedId);
  if (i >= 0) {
    cursor = i;
    reveal();
  } else if (ids.length) {
    // nothing selected yet, or the selection was filtered out: select silently, either the
    // first row or (after an edit dropped the row) the row that took its place
    cursor = keepCursor ? Math.min(cursor, ids.length - 1) : 0;
    select(ids[cursor], { audition: false });
  }
}

function reveal() {
  rowById.get(state.selectedId)?.scrollIntoView({ block: "nearest" });
}

function move(delta) {
  if (!ids.length) return;
  const i = ids.indexOf(state.selectedId);
  cursor = i < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + delta));
  select(ids[cursor]);
}

let prevSel = null;
function onState(what, id) {
  if (what === "samples" || what === "filters") rebuild();
  else if (what === "select") {
    rowById.get(prevSel)?.classList.remove("sel");
    rowById.get(state.selectedId)?.classList.add("sel");
    const i = ids.indexOf(state.selectedId);
    if (i >= 0) cursor = i;
    reveal();
  } else if (what === "sample") {
    const s = sampleById(id);
    const old = rowById.get(id);
    if (old && s && matches(s)) {
      const tr = row(s);
      old.replaceWith(tr);
      rowById.set(id, tr);
    } else if (old || (s && matches(s))) rebuild(true);
  }
  prevSel = state.selectedId;
}

registerView("list", {
  mount(el) {
    table = document.createElement("table");
    table.className = "samples";
    table.innerHTML =
      "<colgroup><col class='w-name'><col class='w-dur'><col class='w-type'><col><col class='w-used'></colgroup>" +
      "<thead><tr><th>bank:n</th><th>dur</th><th>type</th><th>tags</th><th>used</th></tr></thead>";
    tbody = document.createElement("tbody");
    table.append(tbody);
    tbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) select(tr.dataset.id);
    });
    el.append(table);
    prevSel = state.selectedId;
    off = onChange(onState);
    rebuild();
  },
  unmount() {
    off?.();
    rowById.clear();
  },
  onKey(e) {
    if (e.key === "j") move(1);
    else if (e.key === "k") move(-1);
    else return false;
    return true;
  },
});
