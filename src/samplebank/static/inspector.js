// Inspector panel for one sample. Reusable by any view:
//   const insp = createInspector(el, { patch, copy, play });
//   insp.render(sample | null); insp.editTags();
import { drawPeaks } from "./waveform.js";

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export const name = (s) => `${s.bank}:${s.n}`;
export const snippet = (s) => `s "${name(s)}"`;
export const fmtDuration = (d) => (d == null ? "…" : d < 10 ? `${d.toFixed(2)}s` : `${d.toFixed(1)}s`);

export function createInspector(el, actions) {
  el.classList.add("inspector");
  el.replaceChildren();

  const empty = h("p", "insp-empty", "nothing selected — j/k to move");
  const body = h("div", "insp-body");
  const title = h("h2", "insp-title");
  const meta = h("div", "insp-meta");
  const canvas = h("canvas", "insp-wave");
  const typeRow = h("div", "insp-row");
  const tagsLabel = h("div", "insp-label", "tags");
  const tags = h("div", "insp-tags");
  const tagInput = h("input", "insp-taginput");
  tagInput.type = "text";
  tagInput.placeholder = "comma, separated, tags";
  tagInput.spellcheck = false;
  const tagHint = h("div", "insp-hint", "t edit · enter save · esc cancel");
  const star = h("button", "insp-star");
  const snipLabel = h("div", "insp-label", "snippet");
  const snipRow = h("div", "insp-snippet");
  const code = h("code");
  const copyBtn = h("button", "copy", "copy ⧉");
  snipRow.append(code, copyBtn);
  body.append(title, meta, canvas, typeRow, tagsLabel, tags, tagInput, tagHint, star, snipLabel, snipRow);
  el.append(empty, body);

  let current = null;
  let lastPeaks;

  const saveTags = async () => {
    if (!current) return;
    const list = tagInput.value.split(",").map((t) => t.trim()).filter(Boolean);
    tagInput.blur();
    await actions.patch(current.id, { tags: list });
  };

  tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveTags(); }
    else if (e.key === "Escape") { e.preventDefault(); tagInput.value = current ? current.tags.join(", ") : ""; tagInput.blur(); }
  });
  tagInput.addEventListener("blur", () => { if (current) tagInput.value = current.tags.join(", "); });
  star.addEventListener("click", () => current && actions.patch(current.id, { star: !current.star }));
  copyBtn.addEventListener("click", () => current && actions.copy(current));
  canvas.addEventListener("click", () => current && actions.play(current.id));
  canvas.title = "click to replay";

  function render(s) {
    const switched = !current || !s || current.id !== s.id;
    current = s;
    empty.hidden = !!s;
    body.hidden = !s;
    if (!s) return;
    title.textContent = name(s);
    meta.textContent = `${s.source} · ${s.filename} · ${fmtDuration(s.duration)}${s.used ? ` · used ${s.used}×` : ""}`;
    meta.title = s.id;

    typeRow.replaceChildren(h("span", "insp-label inline", "type"), h("span", "chip type", s.type));
    if (s.type !== s.type_auto) typeRow.append(h("span", "insp-auto", `auto: ${s.type_auto}`));

    tags.replaceChildren(...(s.tags.length ? s.tags.map((t) => h("span", "chip", t)) : [h("span", "insp-none", "none")]));
    if (switched || document.activeElement !== tagInput) tagInput.value = s.tags.join(", ");

    star.textContent = s.star ? "★ favourite" : "☆ not starred";
    star.classList.toggle("on", !!s.star);
    code.textContent = snippet(s);

    if (switched || s.peaks !== lastPeaks) {
      lastPeaks = s.peaks;
      drawPeaks(canvas, s.peaks);
    }
  }

  function editTags() {
    if (!current) return;
    tagInput.focus();
    tagInput.select();
  }

  render(null);
  return { render, editTags };
}
