import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, VALID, fromFolder, grab, collect } from "../../src/samplebank/static/dropwalk.js";

// minimal FileSystemEntry fakes; readEntries hands out batches of 2 like Chrome's 100
const file = (name) => ({ name, isFile: true, isDirectory: false, file: (ok) => ok({ name }) });
const dir = (name, children) => ({
  name, isFile: false, isDirectory: true,
  createReader() {
    let i = 0;
    return { readEntries: (ok) => setTimeout(() => ok(children.slice(i, (i += 2)))) };
  },
});

test("normalize matches ingest.normalize_bank", () => {
  assert.equal(normalize("  My Kicks-2 "), "my_kicks_2");
  assert.equal(normalize("a - b"), "a_b");
  assert.ok(VALID.test(normalize("Dub Hits")));
  assert.ok(!VALID.test(normalize("2fast")));
});

test("fromFolder makes a valid prefill from odd folder names", () => {
  assert.equal(fromFolder("My Kicks (2024)"), "my_kicks_2024");
  assert.equal(fromFolder("01 Drums"), "drums");
  assert.equal(fromFolder("Täst"), "tst");
});

test("folders are walked recursively, flattened, dotfiles skipped, top folder names the bank", async () => {
  const top = dir("Test Bank", [
    file("a.wav"), file(".DS_Store"), file("b.mp3"),
    dir("sub", [file("c.wav"), dir(".git", [file("x.wav")]), file("d.txt")]),
  ]);
  const { files, folder } = await collect({ entries: [top, file("loose.wav")], loose: [{ name: "._junk" }, { name: "e.aif" }] });
  assert.deepEqual(files.map((f) => f.name).sort(), ["a.wav", "b.mp3", "c.wav", "d.txt", "e.aif", "loose.wav"]);
  assert.equal(folder, "test_bank");
});

test("plain files: no folder prefill", async () => {
  const { files, folder } = await collect({ entries: [file("a.wav")], loose: [] });
  assert.deepEqual(files.map((f) => f.name), ["a.wav"]);
  assert.equal(folder, "");
});

test("grab falls back to getAsFile, then to dt.files", () => {
  const f = { name: "x.wav" };
  const items = { length: 2, 0: { kind: "file", webkitGetAsEntry: () => null, getAsFile: () => f }, 1: { kind: "string" } };
  assert.deepEqual(grab({ items, files: [] }), { entries: [], loose: [f] });
  assert.deepEqual(grab({ items: { length: 0 }, files: [f] }), { entries: [], loose: [f] });
});

import { AUTO_TRIM_S, autoTrim, commitItem, fmtDur, nextPending } from "../../src/samplebank/static/dropwalk.js";

test("trim step opens automatically only above 4 s", () => {
  assert.equal(AUTO_TRIM_S, 4);
  assert.equal(autoTrim({ duration: 4 }), false);
  assert.equal(autoTrim({ duration: 4.0001 }), true);
  assert.equal(autoTrim({ duration: 1 }), false);
});

test("commitItem: no choice = whole, range kept, full-file range sent as whole", () => {
  const f = { token: "t", duration: 40 };
  assert.deepEqual(commitItem(f, undefined), { token: "t", action: "whole" });
  assert.deepEqual(commitItem(f, { action: "skip" }), { token: "t", action: "skip" });
  assert.deepEqual(commitItem(f, { action: "whole", sel: { start: 1, end: 2 }, fade: true }), { token: "t", action: "whole" });
  assert.deepEqual(commitItem(f, { action: "range", sel: { start: 12.84, end: 14.91 }, fade: true }), {
    token: "t", action: "range", start: 12.84, end: 14.91, fade: true,
  });
  assert.deepEqual(commitItem(f, { action: "range", sel: { start: 1, end: 2 }, fade: false }).fade, false);
  // the trim view's whole-file selection is frame-snapped: end = round(dur*sr)/sr, equal to duration within a frame
  const g = { token: "u", duration: 1764000 / 44100 };
  const all = { start: 0, end: 1764000 / 44100 };
  // whole-file selection with fade off was heard unfaded -> stored as is
  assert.deepEqual(commitItem(g, { action: "range", sel: all, fade: false }), { token: "u", action: "whole" });
  // with fade on it was heard with 5 ms fades -> must be saved as a range with fades
  assert.deepEqual(commitItem(g, { action: "range", sel: all, fade: true }), { token: "u", action: "range", start: 0, end: all.end, fade: true });
  assert.equal(commitItem(g, { action: "range", sel: { start: 0, end: 1763999 / 44100 }, fade: false }).action, "range");
  assert.equal(commitItem(g, { action: "range", sel: { start: 1 / 44100, end: 1764000 / 44100 }, fade: false }).action, "range");
});

test("fmtDur", () => {
  assert.equal(fmtDur(40.3), "40.3 s");
  assert.equal(fmtDur(1), "1.0 s");
  assert.equal(fmtDur(0.04), "0.04 s");
});

test("nextPending: next undecided step after `at`, then wrap to earlier ones, -1 when done", () => {
  const q = ["a", "b", "c", "d"];
  assert.equal(nextPending(q, new Set(), 0), 1);
  assert.equal(nextPending(q, new Set(["b"]), 0), 2);
  // forward order first, even when an earlier step is also pending
  assert.equal(nextPending(q, new Set(["a", "c"]), 1), 3);
  // wrap to earlier ones
  assert.equal(nextPending(q, new Set(["c", "d"]), 3), 0);
  assert.equal(nextPending(q, new Set(["a", "c", "d"]), 2), 1);
  // all decided -> commit
  assert.equal(nextPending(q, new Set(q), 2), -1);
  assert.equal(nextPending(["a"], new Set(["a"]), 0), -1);
  assert.equal(nextPending([], new Set(), 0), -1);
});

test("nextPending: drop [40 s, 2 s], trim the short one first -> the long one comes next", () => {
  // queue after openTrim(1): [long, short], at = 1 (the short one), short just decided
  assert.equal(nextPending(["long", "short"], new Set(["short"]), 1), 0);
  assert.equal(nextPending(["long", "short"], new Set(["short", "long"]), 0), -1);
});

test("nextPending: after back-navigation, decided steps are skipped", () => {
  const q = ["a", "b", "c"];
  // all decided, user went back to a and re-decides: nothing pending
  assert.equal(nextPending(q, new Set(q), 0), -1);
  // went back to b (a decided, c undecided): re-deciding b goes on to c
  assert.equal(nextPending(q, new Set(["a", "b"]), 1), 2);
  // went back from c to a while b is still undecided
  assert.equal(nextPending(q, new Set(["a"]), 0), 1);
});
