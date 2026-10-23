import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_SEL,
  clampSel,
  xToTime,
  timeToX,
  zoomTo,
  nudge,
  fadeGain,
  fadeFrames,
  toFrames,
  sliceWithFades,
  peaks,
  wavSampleRate,
} from "../../src/samplebank/static/trimmath.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const frames = (sel, sr) => toFrames(sel, sr, Infinity);

test("MIN_SEL is 10 ms", () => assert.equal(MIN_SEL, 0.01));

test("clampSel orders and clamps to the file", () => {
  const s = clampSel({ start: 3, end: 1 }, 5, 1000);
  assert.deepEqual(s, { start: 1, end: 3 });
  const c = clampSel({ start: -2, end: 9 }, 5, 1000);
  assert.deepEqual(c, { start: 0, end: 5 });
});

test("clampSel enforces the 10 ms minimum in frames at the file's rate", () => {
  for (const sr of [8000, 22050, 44100, 48000, 96000]) {
    const min = Math.floor(0.01 * sr + 0.5); // same as the server's round-half-up(MIN_SLICE_S * sr)
    for (const [start, end] of [[1, 1], [1, 1.002], [1.00001, 1.0099], [2.3333, 2.3334]]) {
      const s = clampSel({ start, end }, 5, sr);
      const { a, b } = frames(s, sr);
      assert.ok(b - a >= min, `sr ${sr}: ${b - a} < ${min}`);
      assert.ok(s.end <= 5 && s.start >= 0);
    }
    // at the very end of the file the selection grows backwards
    const s = clampSel({ start: 5, end: 5 }, 5, sr);
    const { a, b } = frames(s, sr);
    assert.ok(b - a >= min);
    assert.ok(b <= 5 * sr);
  }
});

test("clampSel snaps to frame boundaries so seconds round-trip exactly", () => {
  const s = clampSel({ start: 0.12345, end: 0.6789 }, 5, 44100);
  close(s.start * 44100, Math.round(s.start * 44100), 1e-6);
  close(s.end * 44100, Math.round(s.end * 44100), 1e-6);
});

test("x <-> time round-trip under zoom", () => {
  const view = { from: 12.5, to: 14.75 };
  for (const t of [12.5, 13, 14.2, 14.75]) close(xToTime(timeToX(t, 800, view), 800, view), t);
  close(xToTime(0, 800, view), 12.5);
  close(xToTime(800, 800, view), 14.75);
  close(timeToX(13.625, 800, view), 400);
});

test("zoomTo pads by a fraction of the selection, clamped to the file", () => {
  assert.deepEqual(zoomTo({ start: 10, end: 20 }, 40), { from: 9, to: 21 });
  let v = zoomTo({ start: 0.5, end: 20 }, 40);
  assert.equal(v.from, 0);
  close(v.to, 21.95);
  v = zoomTo({ start: 30, end: 39.5 }, 40, 0.2);
  close(v.from, 28.1);
  assert.equal(v.to, 40);
});

test("nudge moves one edge and clamps", () => {
  const sr = 1000;
  let s = nudge({ start: 1, end: 2 }, "start", 0.01, 5, sr);
  assert.deepEqual(s, { start: 1.01, end: 2 });
  s = nudge({ start: 1, end: 2 }, "end", -0.001, 5, sr);
  assert.deepEqual(s, { start: 1, end: 1.999 });
  // start can't go below 0, end can't pass the file
  assert.deepEqual(nudge({ start: 0.005, end: 2 }, "start", -0.01, 5, sr), { start: 0, end: 2 });
  assert.deepEqual(nudge({ start: 1, end: 4.995 }, "end", 0.01, 5, sr), { start: 1, end: 5 });
  // edges never cross or get closer than the minimum
  assert.deepEqual(nudge({ start: 1, end: 1.015 }, "start", 0.01, 5, sr), { start: 1.005, end: 1.015 });
  assert.deepEqual(nudge({ start: 1, end: 1.015 }, "end", -0.01, 5, sr), { start: 1, end: 1.01 });
});

test("fadeGain endpoints and middle", () => {
  const n = 1000, F = 221;
  assert.equal(fadeGain(0, n, F), 0);
  assert.equal(fadeGain(n - 1, n, F), 0);
  assert.equal(fadeGain(500, n, F), 1);
  assert.equal(fadeGain(5, 10, 0), 1);
});

test("fadeFrames: round-half-up of 5 ms, at most half the slice", () => {
  assert.equal(fadeFrames(100000, 44100), 221); // 220.5 rounds up (Python round() would give 220)
  assert.equal(fadeFrames(100000, 22050), 110);
  assert.equal(fadeFrames(7, 48000), 3);
  assert.equal(fadeFrames(1, 44100), 0);
});

// Reference values from the server implementation:
//   uv run python -c "from samplebank.trim import fade_gains; print(fade_gains(n, sr)[i])"
// (src/samplebank/trim.py, generated 2026-10-23)
const PY = [
  [20, 1000, [[0, 0.0], [1, 0.2], [2, 0.4], [4, 0.8], [5, 1.0], [6, 1.0], [10, 1.0], [17, 0.4], [18, 0.2], [19, 0.0]]],
  [7, 48000, [[0, 0.0], [1, 0.3333333333333333], [2, 0.6666666666666666], [3, 1.0], [4, 0.6666666666666666], [5, 0.3333333333333333], [6, 0.0]]],
  [1000, 44100, [[0, 0.0], [1, 0.004524886877828055], [2, 0.00904977375565611], [220, 0.995475113122172], [221, 1.0], [222, 1.0], [500, 1.0], [997, 0.00904977375565611], [998, 0.004524886877828055], [999, 0.0]]],
  [600, 22050, [[0, 0.0], [1, 0.00909090909090909], [2, 0.01818181818181818], [109, 0.990909090909091], [110, 1.0], [111, 1.0], [300, 1.0], [597, 0.01818181818181818], [598, 0.00909090909090909], [599, 0.0]]],
  [1, 44100, [[0, 1.0]]],
  [3, 8000, [[0, 0.0], [1, 1.0], [2, 0.0]]],
];

test("fadeGain matches samplebank.trim.fade_gains exactly", () => {
  for (const [n, sr, pairs] of PY) {
    const F = fadeFrames(n, sr);
    for (const [i, g] of pairs) assert.equal(fadeGain(i, n, F), g, `n=${n} sr=${sr} i=${i}`);
  }
});

test("toFrames rounds half-up and clamps the end to the file", () => {
  assert.deepEqual(toFrames({ start: 0.0625, end: 0.1875 }, 8, 100), { a: 1, b: 2 }); // exactly .5 and 1.5 frames
  assert.deepEqual(toFrames({ start: 0.05, end: 0.2 }, 1000, 100), { a: 50, b: 100 });
});

test("sliceWithFades copies frames [a, b) with gains", () => {
  const ch = [Float32Array.from({ length: 100 }, () => 1), Float32Array.from({ length: 100 }, (_, i) => i)];
  const out = sliceWithFades(ch, 10, 30, true, 1000); // n=20, F=5
  assert.equal(out.length, 2);
  assert.equal(out[0].length, 20);
  assert.equal(out[0][0], 0);
  assert.equal(out[0][19], 0);
  close(out[0][1], 0.2, 1e-7);
  assert.equal(out[0][10], 1);
  assert.equal(out[1][10], 20);
  const raw = sliceWithFades(ch, 10, 30, false, 1000);
  assert.equal(raw[1][0], 10);
  assert.equal(raw[1][19], 29);
});

test("peaks: abs-max per pixel over all channels", () => {
  const sr = 100;
  const ramp = Float32Array.from({ length: 100 }, (_, i) => -i / 100); // 1 s, 0 .. -0.99
  const p = peaks([ramp], { from: 0, to: 1 }, 10, sr);
  assert.equal(p.length, 10);
  for (let px = 0; px < 10; px++) close(p[px], (px * 10 + 9) / 100, 1e-6);
  const z = peaks([ramp, new Float32Array(100)], { from: 0.5, to: 0.6 }, 5, sr);
  for (let px = 0; px < 5; px++) close(z[px], (50 + px * 2 + 1) / 100, 1e-6);
  // zoomed in beyond one frame per pixel: every pixel still shows a value
  const zz = peaks([ramp], { from: 0.5, to: 0.52 }, 8, sr);
  assert.ok(zz.every((v) => v > 0));
});

test("wavSampleRate reads the fmt chunk", () => {
  const buf = new ArrayBuffer(44 + 8);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, buf.byteLength - 8, true);
  str(8, "WAVE");
  str(12, "JUNK");
  v.setUint32(16, 0, true); // empty chunk before fmt
  str(20, "fmt ");
  v.setUint32(24, 16, true);
  v.setUint16(28, 1, true);
  v.setUint16(30, 2, true);
  v.setUint32(32, 22050, true);
  assert.equal(wavSampleRate(buf), 22050);
  assert.equal(wavSampleRate(new ArrayBuffer(12)), null);
});
