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
