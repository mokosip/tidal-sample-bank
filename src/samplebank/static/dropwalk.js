// Pure helpers for upload.js (no DOM, no app state), so node --test can import them.

// same rule as ingest.normalize_bank; the server normalises again and has the final word
export const normalize = (s) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");
export const VALID = /^[a-z][a-z0-9_]*$/;
// prefill only: make a folder name like "My Kicks (2024)" a valid suggestion
export const fromFolder = (s) => normalize(s).replace(/[^a-z0-9_]/g, "").replace(/^[^a-z]+/, "");

export const hidden = (name) => name.startsWith("."); // .DS_Store, ._foo, .git …

export function readAll(reader) {
  // readEntries returns batches (Chrome: 100) until an empty one
  return new Promise((resolve, reject) => {
    const out = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(out);
        out.push(...batch);
        next();
      }, reject);
    next();
  });
}

export async function walk(entry, out) {
  if (hidden(entry.name)) return;
  if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
  else if (entry.isDirectory) for (const e of await readAll(entry.createReader())) await walk(e, out);
}

// must run synchronously inside the drop handler: items are emptied once it returns
export function grab(dt) {
  const entries = [];
  const loose = [];
  for (const item of Array.from(dt.items ?? [])) { // array-like, not iterable everywhere
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) loose.push(f);
    }
  }
  if (!entries.length && !loose.length) loose.push(...Array.from(dt.files ?? []));
  return { entries, loose };
}

export async function collect({ entries, loose }) {
  const files = loose.filter((f) => !hidden(f.name));
  for (const e of entries) await walk(e, files);
  const dir = entries.find((e) => e.isDirectory);
  return { files, folder: dir ? fromFolder(dir.name) : "" };
}
