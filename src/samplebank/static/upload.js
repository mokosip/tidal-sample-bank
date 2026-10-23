// Upload: drop files/folders anywhere (or pick them via the "+ add" button), name the bank,
// POST /api/upload, then refetch and select the first added sample.
import { state, loadSamples, select, setFilter, matches, toast } from "./app.js";
import { normalize, VALID, hidden, grab, collect } from "./dropwalk.js";

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

// ---------- modal ----------
let modalOpen = false;
let pending = [];

function setBusy(busy) {
  for (const el of $("upload-modal").querySelectorAll("button, input")) el.disabled = busy;
  $("upload-msg").textContent = busy ? "uploading…" : $("upload-msg").textContent;
}

function preview() {
  const bank = normalize($("upload-bank").value);
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

function openModal(files, prefill) {
  pending = files;
  modalOpen = true;
  const n = files.length;
  $("upload-title").textContent = `add ${n} file${n === 1 ? "" : "s"}`;
  const names = files.slice(0, 4).map((f) => f.name).join(", ");
  $("upload-files").textContent = n > 4 ? `${names}, … +${n - 4}` : names;
  $("upload-banks").replaceChildren(...ownBanks().map((b) => new Option(b)));
  const input = $("upload-bank");
  input.value = prefill || lastBank();
  $("upload-msg").textContent = "";
  $("upload-suggest").hidden = true;
  setBusy(false);
  preview();
  $("upload-modal").hidden = false;
  input.focus();
  input.select();
}

function closeModal() {
  $("upload-modal").hidden = true;
  modalOpen = false;
  pending = [];
}

function summary(r) {
  const parts = [`added ${r.added.length}`];
  if (r.rejected.length) parts.push(`rejected ${r.rejected.length} (${r.rejected.map(([f, why]) => `${f}: ${why}`).join("; ")})`);
  let msg = parts.join(", ");
  if (r.added.length) {
    if (r.loaded == null) msg += "\nSuperDirt not reachable — will load on next boot";
    else if (r.loaded === 0) msg += `\nSuperDirt didn't load any files from ${r.bank} (name clash with a synth?)`;
    else msg += `\nloaded in SuperDirt ✓ (${r.loaded})`;
  }
  return msg;
}

async function submit(bankRaw) {
  const bank = normalize(bankRaw ?? $("upload-bank").value);
  if (!VALID.test(bank)) {
    $("upload-msg").textContent = "invalid bank name";
    return;
  }
  const form = new FormData();
  form.append("bank", bank);
  for (const f of pending) form.append("files[]", f, f.name);
  $("upload-suggest").hidden = true;
  setBusy(true);
  let res, body;
  try {
    res = await fetch("/api/upload", { method: "POST", body: form });
    body = await res.json().catch(() => ({}));
  } catch {
    setBusy(false);
    $("upload-msg").textContent = "upload failed: server not reachable";
    return;
  }
  setBusy(false);
  if (res.status === 409 && body.suggestion) {
    $("upload-msg").textContent = body.error ?? `${bank} is taken`;
    const b = $("upload-suggest");
    b.textContent = `use ${body.suggestion}`;
    b.onclick = () => {
      $("upload-bank").value = body.suggestion;
      submit(body.suggestion);
    };
    b.hidden = false;
    b.focus();
    return;
  }
  if (!res.ok) {
    // our own errors use `error`; FastAPI/Starlette (too many files, ...) use `detail`
    const detail = typeof body.detail === "string" ? body.detail : Array.isArray(body.detail) ? body.detail.map((d) => d.msg).join("; ") : null;
    $("upload-msg").textContent =
      body.error ?? detail ?? (res.status === 413 ? "upload too large (413)" : `upload failed (${res.status})`);
    $("upload-bank").focus();
    return;
  }
  closeModal();
  rememberBank(body.bank);
  toast(summary(body), 6000);
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
  // capture: runs before app.js's key handler; global keys stay inert while the modal is open
  window.addEventListener(
    "keydown",
    (e) => {
      if (!$("drop").hidden && e.key === "Escape") {
        depth = 0;
        overlay(false);
        e.preventDefault();
        return;
      }
      if (!modalOpen) return;
      if (e.key === "Escape") {
        closeModal();
        e.preventDefault();
      } else if (e.key === "Enter" && e.target === $("upload-bank")) {
        submit();
        e.preventDefault();
      }
      e.stopPropagation();
    },
    true,
  );

  $("upload-bank").addEventListener("input", () => {
    $("upload-suggest").hidden = true;
    $("upload-msg").textContent = "";
    preview();
  });
  $("upload-ok").onclick = () => submit();
  $("upload-cancel").onclick = closeModal;
  $("upload-modal").addEventListener("mousedown", (e) => e.target === $("upload-modal") && closeModal());

  const picker = $("upload-input");
  $("upload-pick").onclick = () => picker.click();
  picker.addEventListener("change", () => {
    const files = [...picker.files].filter((f) => !hidden(f.name));
    picker.value = "";
    if (files.length) openModal(files, "");
  });
}
