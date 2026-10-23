// Upload: drop files/folders anywhere (or pick them via the "+ add" button). The files are staged on the
// server (POST /api/upload/stage), the dialog asks for the bank name, shows a trim step for every long file
// (loop a part in the browser, keep only that), then commits (POST /api/upload/commit). Afterwards:
// refetch and select the first added sample.
import { state, loadSamples, select, setFilter, matches, toast } from "./app.js";
import { normalize, VALID, hidden, grab, collect, autoTrim, commitItem, fmtDur, nextPending } from "./dropwalk.js";
import { createTrimView } from "./trimview.js";

const $ = (id) => document.getElementById(id);
const LAST_KEY = "samplebank.lastBank";

function lastBank() {
  try {
    return localStorage.getItem(LAST_KEY) ?? "";
  } catch {
    return "";
  }
}
function rememberBank(bank) {
  try {
    localStorage.setItem(LAST_KEY, bank);
  } catch {}
}
const ownBanks = () => [...new Set(state.samples.filter((s) => s.source === "own").map((s) => s.bank))].sort();

// ---------- dialog state ----------
// step: "stage" (POST /stage in flight) → "bank" ⇄ "trim" → "commit" (POST /commit in flight)
let modalOpen = false;
let session = 0; // bumped on every open/close: answers that arrive for an old dialog are dropped
let step = null;
let batch = null; // {id, files: [{token, filename, duration}], rejected: [[filename, reason]]}
let queue = []; // indexes into batch.files that get a trim step, in file order
let at = -1; // position in `queue` while step === "trim"
let view = null; // the one live trim view (browsers cap AudioContexts)
const kept = new Map(); // token -> {sel, fade}: the trim view's state when its step was left
const actions = new Map(); // token -> "range" | "whole" | "skip": what was decided in the step

const fileAt = (p) => batch.files[queue[p]];
const choiceOf = (f) => (actions.has(f.token) ? { action: actions.get(f.token), ...kept.get(f.token) } : undefined);
const pendingAt = () => queue.findIndex((i) => !actions.has(batch.files[i].token));
const bankName = () => normalize($("upload-bank").value);

function setBusy(busy, { input = busy } = {}) {
  for (const el of $("upload-box").querySelectorAll("button")) el.disabled = busy;
  $("upload-bank").disabled = input;
}

function showStep(trim) {
  $("upload-bank-step").hidden = trim;
  $("upload-trim-step").hidden = !trim;
  $("upload-box").classList.toggle("wide", trim);
}

function preview() {
  const bank = bankName();
  const p = $("upload-preview");
  let text = "";
  let bad = false;
  if (bank && !VALID.test(bank)) {
    text = "letters, digits, _ — must start with a letter";
    bad = true;
  } else if (bank) {
    // a hint only; the server checks the Dirt/dub folders and answers 409 with a suggestion
    const other = state.samples.find((s) => s.bank === bank && s.source !== "own");
    bad = !!other;
    const note = other ? `taken by ${other.source} — try ${bank}_mine` : ownBanks().includes(bank) ? "appends to your bank" : "new bank";
    text = `s "${bank}:0"  · ${note}`;
  }
  p.textContent = text;
  p.classList.toggle("bad", bad);
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function choiceLabel(f, i) {
  const a = actions.get(f.token);
  if (a === "skip") return "skip";
  if (a === "whole") return "whole";
  if (a === "range") {
    const item = commitItem(f, choiceOf(f));
    return item.action === "whole" ? "whole" : `✂ ${item.start.toFixed(2)}–${item.end.toFixed(2)} s`;
  }
  return queue.includes(i) ? "trim ›" : "trim";
}

// The staged files, each with a button that opens its trim step (long files get one anyway).
function renderList() {
  const rows = batch.files.map((f, i) => {
    const row = el("div", "upload-row");
    const b = el("button", "modal-btn" + (queue.includes(i) ? " hot" : ""), choiceLabel(f, i));
    b.type = "button";
    b.title = "open the trim step for this file";
    b.onclick = () => openTrim(i);
    row.append(el("span", "upload-name", f.filename), el("span", "upload-dur", fmtDur(f.duration)), b);
    return row;
  });
  for (const [name, why] of batch.rejected) {
    const row = el("div", "upload-row bad");
    row.append(el("span", "upload-name", name), el("span", "upload-dur", why));
    rows.push(row);
  }
  $("upload-list").replaceChildren(...rows);
  const n = queue.length - queue.filter((i) => actions.has(batch.files[i].token)).length;
  $("upload-ok").innerHTML = pendingAt() >= 0 ? `<kbd>⏎</kbd>trim ${n} file${n === 1 ? "" : "s"}` : "<kbd>⏎</kbd>add";
}

function renderBank() {
  const n = batch ? batch.files.length : 0;
  $("upload-title").textContent = `add ${n} file${n === 1 ? "" : "s"}`;
  $("upload-files").textContent = "";
  renderList();
}

// ---------- open / close ----------
function openModal(files, prefill) {
  closeModal();
  const my = session;
  modalOpen = true;
  step = "stage";
  const n = files.length;
  $("upload-title").textContent = `add ${n} file${n === 1 ? "" : "s"}`;
  const names = files.slice(0, 4).map((f) => f.name).join(", ");
  $("upload-files").textContent = n > 4 ? `${names}, … +${n - 4}` : names;
  $("upload-list").replaceChildren();
  $("upload-ok").innerHTML = "<kbd>⏎</kbd>add";
  $("upload-banks").replaceChildren(...ownBanks().map((b) => new Option(b)));
  const input = $("upload-bank");
  input.value = prefill || lastBank();
  $("upload-msg").textContent = `preparing ${n} file${n === 1 ? "" : "s"}…`;
  $("upload-suggest").hidden = true;
  showStep(false);
  setBusy(true, { input: false }); // the bank name can be typed while the files are prepared
  $("upload-cancel").disabled = false;
  preview();
  $("upload-modal").hidden = false;
  input.focus();
  input.select();
  stage(files, my);
}

function closeModal() {
  session++;
  view?.destroy();
  view = null;
  $("upload-trim").replaceChildren();
  $("upload-modal").hidden = true;
  showStep(false);
  modalOpen = false;
  step = null;
  batch = null;
  queue = [];
  at = -1;
  kept.clear();
  actions.clear();
}

const discard = (id) => fetch(`/api/upload/stage/${id}`, { method: "DELETE", keepalive: true }).catch(() => {});

// Esc / cancel: the whole batch is dropped, staging included.
function cancel() {
  if (step === "commit") return; // the server is storing it already
  if (batch) discard(batch.id);
  closeModal();
}

function errorText(res, body) {
  // our own errors use `error`; FastAPI/Starlette (too many files, ...) use `detail`
  const detail = typeof body.detail === "string" ? body.detail : Array.isArray(body.detail) ? body.detail.map((d) => d.msg).join("; ") : null;
  return body.error ?? detail ?? (res.status === 413 ? "upload too large (413)" : `upload failed (${res.status})`);
}

function summary(r, staged = []) {
  const rejected = [...staged, ...r.rejected];
  const parts = [`added ${r.added.length}`];
  if (rejected.length) parts.push(`rejected ${rejected.length} (${rejected.map(([f, why]) => `${f}: ${why}`).join("; ")})`);
  let msg = parts.join(", ");
  if (r.added.length) {
    if (r.loaded == null) msg += "\nSuperDirt not reachable — will load on next boot";
    else if (r.loaded === 0) msg += `\nSuperDirt didn't load any files from ${r.bank} (name clash with a synth?)`;
    else msg += `\nloaded in SuperDirt ✓ (${r.loaded})`;
  }
  return msg;
}

// ---------- stage ----------
async function stage(files, my) {
  const form = new FormData();
  for (const f of files) form.append("files[]", f, f.name);
  let res, body;
  try {
    res = await fetch("/api/upload/stage", { method: "POST", body: form });
    body = await res.json().catch(() => ({}));
  } catch {
    if (my !== session) return;
    closeModal();
    toast("upload failed: server not reachable", 5000);
    return;
  }
  if (my !== session) {
    if (res.ok && body.batch) discard(body.batch); // cancelled while preparing
    return;
  }
  if (!res.ok) {
    closeModal(); // 503 = staging dir unusable; 400/413 = nothing to stage
    toast(errorText(res, body), 6000);
    return;
  }
  batch = { id: body.batch, files: body.files, rejected: body.rejected };
  if (!batch.files.length) {
    const rejected = batch.rejected;
    discard(batch.id);
    closeModal();
    toast(summary({ added: [], rejected: [] }, rejected), 6000);
    return;
  }
  queue = batch.files.flatMap((f, i) => (autoTrim(f) ? [i] : []));
  step = "bank";
  setBusy(false);
  $("upload-msg").textContent = "";
  renderBank();
}

// ---------- bank step ----------
function checkBank() {
  if (VALID.test(bankName())) return true;
  $("upload-msg").textContent = "invalid bank name";
  $("upload-bank").focus();
  return false;
}

// Enter / ok in the bank step: the first undecided trim step, or commit when there is none.
function submitBank() {
  if (step !== "bank" || !checkBank()) return;
  const p = pendingAt();
  if (p >= 0) goTrim(p);
  else commit();
}

// "trim" button of a file: insert its step (short files have none) and open it.
function openTrim(i) {
  if (step !== "bank" || !checkBank()) return;
  if (!queue.includes(i)) queue = [...queue, i].sort((a, b) => a - b);
  goTrim(queue.indexOf(i));
}

function backToBank() {
  leaveTrim();
  step = "bank";
  showStep(false);
  renderBank();
  $("upload-bank").focus();
}

// ---------- trim steps ----------
function leaveTrim() {
  if (!view) return;
  kept.set(fileAt(at).token, { sel: view.getSelection(), fade: view.fade });
  view.destroy(); // one AudioContext at a time
  view = null;
}

function goTrim(p) {
  leaveTrim();
  step = "trim";
  at = p;
  const f = fileAt(p);
  const i = queue[p];
  const prev = kept.get(f.token);
  $("upload-title").textContent = `file ${i + 1} of ${batch.files.length}: ${f.filename} (${fmtDur(f.duration)})`;
  $("upload-into").textContent = `into bank ${bankName()}`;
  const nf = p + 1 < queue.length ? fileAt(p + 1) : null;
  $("upload-next").textContent = nf ? `next: ${nf.filename} (${fmtDur(nf.duration)})` : `then: add to ${bankName()}`;
  $("trim-back").innerHTML = p === 0 ? "‹ bank" : "‹ back";
  showStep(true);
  view = createTrimView($("upload-trim"), {
    url: `/api/upload/stage/${batch.id}/${f.token}/source.wav`,
    duration: f.duration,
    selection: prev?.sel ?? null,
  });
  if (prev && !prev.fade) view.setFade(false);
  view.ready.catch(() => {}); // the view shows the error itself; "keep whole" / "skip" still work
  view.focus();
}

function decide(action) {
  if (step !== "trim" || !view) return;
  actions.set(fileAt(at).token, action);
  const p = nextPending(queue.map((i) => batch.files[i].token), actions, at);
  if (p >= 0) goTrim(p); // openTrim can insert a file before the one being decided: never commit with steps left
  else commit();
}

function back() {
  if (step !== "trim") return;
  if (at > 0) goTrim(at - 1);
  else backToBank();
}

// ---------- commit ----------
async function commit(bankRaw) {
  const bank = normalize(bankRaw ?? $("upload-bank").value);
  if (!VALID.test(bank)) {
    backToBank();
    $("upload-msg").textContent = "invalid bank name";
    return;
  }
  leaveTrim();
  const my = session;
  step = "commit";
  showStep(false);
  renderBank();
  $("upload-suggest").hidden = true;
  $("upload-msg").textContent = "saving…";
  setBusy(true);
  const files = batch.files.map((f) => commitItem(f, choiceOf(f)));
  let res, body;
  try {
    res = await fetch("/api/upload/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch: batch.id, bank, files }),
    });
    body = await res.json().catch(() => ({}));
  } catch {
    if (my !== session) return;
    step = "bank";
    setBusy(false);
    $("upload-msg").textContent = "upload failed: server not reachable";
    $("upload-bank").focus();
    return;
  }
  if (my !== session) return;
  if (res.status === 410) {
    closeModal(); // expired or committed elsewhere: nothing left to retry with
    toast(body.error ?? "upload expired — drop the files again", 6000);
    return;
  }
  step = "bank";
  setBusy(false);
  if (res.status === 409 && body.suggestion) {
    // the batch is kept on the server, and so are all selections: only the bank name is asked again
    $("upload-msg").textContent = body.error ?? `${bank} is taken`;
    const b = $("upload-suggest");
    b.textContent = `use ${body.suggestion}`;
    b.onclick = () => {
      $("upload-bank").value = body.suggestion;
      preview();
      submitBank();
    };
    b.hidden = false;
    b.focus();
    return;
  }
  if (!res.ok) {
    $("upload-msg").textContent = errorText(res, body);
    $("upload-bank").focus();
    return;
  }
  const stagedRejected = batch.rejected;
  closeModal(); // committed: the server discarded the batch
  rememberBank(body.bank);
  toast(summary(body, stagedRejected), 6000);
  if (!body.added.length) return;
  await loadSamples();
  const first = state.samples.find((s) => s.source === "own" && s.bank === body.bank && s.filename === body.added[0]);
  if (!first) return;
  if (!matches(first)) {
    // the active filters would hide the new sample: clear them so it shows up selected
    $("search").value = "";
    setFilter({ type: null, tag: null, star: false, unused: false, q: "" });
  }
  select(first.id, { audition: false });
}

// ---------- keys ----------
// Capture phase on window: runs before app.js's document handler. While the dialog is open nothing reaches
// app.js (space there auditions through SuperDirt on the speakers). Enter / Esc belong to the dialog; in a
// trim step every other key goes to the trim view (space, arrows, z, f), and the bubble guard on the modal
// stops whatever the view does not handle — also before it has decoded.
function onKeyCapture(e) {
  if (!$("drop").hidden && e.key === "Escape") {
    depth = 0;
    overlay(false);
    e.preventDefault();
    return;
  }
  if (!modalOpen) return;
  if (e.key === "Escape") {
    cancel();
    e.preventDefault();
  } else if (e.key === "Enter") {
    const onButton = e.target instanceof HTMLButtonElement; // Enter on a focused button clicks it
    if (step === "bank" && e.target === $("upload-bank")) {
      submitBank();
      e.preventDefault();
    } else if (step === "trim" && !onButton) {
      if (!e.repeat) decide("range"); // a held Enter must not race through the steps
      e.preventDefault();
    }
  } else if (step === "trim" && $("upload-trim").contains(e.target)) {
    return; // to the trim view
  }
  e.stopPropagation();
}

function onKeyModal(e) {
  // bubble phase: keys the trim view did not handle (or before it decoded) end here, never in app.js
  if (e.key === " " && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement)) e.preventDefault();
  e.stopPropagation();
}

// ---------- drag overlay ----------
let depth = 0;
const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
const overlay = (on) => ($("drop").hidden = !on);

function onDragEnter(e) {
  if (!carriesFiles(e) || modalOpen) return;
  e.preventDefault();
  depth++;
  overlay(true);
}
function onDragOver(e) {
  if (!carriesFiles(e) || modalOpen) return;
  e.preventDefault(); // allows the drop
  e.dataTransfer.dropEffect = "copy";
}
function onDragLeave(e) {
  if (!carriesFiles(e)) return;
  depth = Math.max(0, depth - 1);
  // relatedTarget null = pointer left the window
  if (depth === 0 || e.relatedTarget === null) {
    depth = 0;
    overlay(false);
  }
}
async function onDrop(e) {
  if (!carriesFiles(e)) return;
  e.preventDefault(); // never let the browser navigate to the file
  depth = 0;
  overlay(false);
  if (modalOpen) return;
  const got = grab(e.dataTransfer);
  const { files, folder } = await collect(got);
  if (!files.length) {
    toast("nothing to add (only hidden files)");
    return;
  }
  openModal(files, folder);
}

export function initUpload() {
  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
  window.addEventListener("keydown", onKeyCapture, true);
  $("upload-modal").addEventListener("keydown", onKeyModal);
  // closing the tab mid-batch: drop the staged files (the server also purges staging on start)
  window.addEventListener("pagehide", () => batch && step !== "commit" && discard(batch.id));

  $("upload-bank").addEventListener("input", () => {
    $("upload-suggest").hidden = true;
    if (step === "bank") $("upload-msg").textContent = "";
    preview();
  });
  $("upload-ok").onclick = () => submitBank();
  $("upload-cancel").onclick = cancel;
  $("trim-cancel").onclick = cancel;
  $("trim-back").onclick = back;
  $("trim-skip").onclick = () => decide("skip");
  $("trim-whole").onclick = () => decide("whole");
  $("trim-keep").onclick = () => decide("range");
  // a click beside the box cancels only before anything was decided in a trim step
  $("upload-modal").addEventListener("mousedown", (e) => {
    if (e.target === $("upload-modal") && (step === "stage" || (step === "bank" && !actions.size))) cancel();
  });
  // in a trim step, clicks on the dialog's text must not take the focus (and with it the keys) from the view
  $("upload-box").addEventListener("mousedown", (e) => {
    if (step !== "trim" || e.target.closest("button, canvas, input")) return;
    e.preventDefault();
    view?.focus();
  });

  const picker = $("upload-input");
  $("upload-pick").onclick = () => picker.click();
  picker.addEventListener("change", () => {
    const files = [...picker.files].filter((f) => !hidden(f.name));
    picker.value = "";
    if (files.length) openModal(files, "");
  });
}
