// Pure helpers for the trim view. The frame maths mirrors src/samplebank/trim.py exactly,
// so what the browser loops is what the server cuts.

export const MIN_SEL = 0.01; // seconds; = trim.MIN_SLICE_S
const FADE_MS = 5; // = trim.FADE_MS

// trim._round_half_up: seconds -> frames everywhere (Python round() is half-even, Math.round isn't for x < 0)
const rhu = (x) => Math.floor(x + 0.5);
const minFrames = (sr) => rhu(MIN_SEL * sr);

// Seconds -> frame range [a, b) as the server computes it; `total` = frames in the file.
export function toFrames(sel, sr, total) {
  return { a: rhu(sel.start * sr), b: Math.min(rhu(sel.end * sr), total) };
}

// Order, clamp to [0, duration], and guarantee >= 10 ms *in frames at sr* (the server's check).
// The result is snapped to frame boundaries, so start*sr / end*sr round-trip exactly.
export function clampSel(sel, duration, sr) {
  const total = rhu(duration * sr);
  const min = minFrames(sr);
  if (total <= min) return { start: 0, end: total / sr };
  const lo = Math.max(0, Math.min(sel.start, sel.end, duration));
  const hi = Math.min(duration, Math.max(sel.start, sel.end, 0));
  let { a, b } = toFrames({ start: lo, end: hi }, sr, total);
  if (b - a < min) {
    b = a + min;
    if (b > total) [a, b] = [total - min, total];
  }
  return { start: a / sr, end: b / sr };
}

// Move one edge by deltaSec; it stops at the file bounds and never comes closer than 10 ms to the other edge.
export function nudge(sel, which, deltaSec, duration, sr) {
  const total = rhu(duration * sr);
  const min = minFrames(sr);
  let { a, b } = toFrames(clampSel(sel, duration, sr), sr, total);
  if (which === "start") a = Math.max(0, Math.min(rhu((sel.start + deltaSec) * sr), b - min));
  else b = Math.min(total, Math.max(rhu((sel.end + deltaSec) * sr), a + min));
  return { start: a / sr, end: b / sr };
}

// view = {from, to} in seconds, mapped onto [0, width] pixels
export const xToTime = (x, width, view) => view.from + (x / width) * (view.to - view.from);
export const timeToX = (t, width, view) => ((t - view.from) / (view.to - view.from)) * width;

export function zoomTo(sel, duration, pad = 0.1) {
  const p = (sel.end - sel.start) * pad;
  return { from: Math.max(0, sel.start - p), to: Math.min(duration, sel.end + p) };
}

// trim.fade_gains: F = min(round_half_up(FADE_MS/1000 * sr), n // 2)
export const fadeFrames = (n, sr) => Math.min(rhu((FADE_MS / 1000) * sr), Math.floor(n / 2));

// gain(i) = min(1, i/F, (n-1-i)/F), or 1 when F == 0 — same linear ramp as cut_wav
export function fadeGain(i, n, F) {
  if (F <= 0) return 1;
  return Math.min(1, i / F, (n - 1 - i) / F);
}

// Copy of frames [a, b) of every channel, with the edge fades applied when `fade` is on.
export function sliceWithFades(channels, a, b, fade, sr) {
  const n = b - a;
  const F = fade ? fadeFrames(n, sr) : 0;
  return channels.map((ch) => {
    const out = ch.slice(a, b);
    if (F > 0) {
      // gain < 1 only within F frames of either edge
      for (let i = 0; i < F; i++) out[i] *= fadeGain(i, n, F);
      for (let i = Math.max(F, n - F); i < n; i++) out[i] *= fadeGain(i, n, F);
    }
    return out;
  });
}

// abs-max over all channels for each of `width` pixel columns of the view
export function peaks(channelData, view, width, sr) {
  const out = new Float32Array(width);
  const len = channelData[0]?.length ?? 0;
  const f0 = view.from * sr;
  const span = ((view.to - view.from) * sr) / width;
  for (let px = 0; px < width; px++) {
    let s = Math.max(0, Math.round(f0 + px * span));
    let e = Math.min(len, Math.round(f0 + (px + 1) * span));
    if (e <= s) e = Math.min(len, s + 1);
    let m = 0;
    for (const ch of channelData) {
      for (let i = s; i < e; i++) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > m) m = v;
      }
    }
    out[px] = m;
  }
  return out;
}

// Sample rate from a RIFF/WAVE header's fmt chunk, or null.
export function wavSampleRate(buf) {
  const v = new DataView(buf);
  const id = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (v.byteLength < 12 || id(0) !== "RIFF" || id(8) !== "WAVE") return null;
  for (let o = 12; o + 8 <= v.byteLength; ) {
    const size = v.getUint32(o + 4, true);
    if (id(o) === "fmt ") return o + 16 <= v.byteLength ? v.getUint32(o + 12, true) : null;
    o += 8 + size + (size & 1);
  }
  return null;
}
