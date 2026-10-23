// Trim view: waveform with a selection you loop in the browser until it feels right.
// The loop buffer holds exactly frames [a, b) of the decoded source with the same 5 ms fades
// the server applies (trimmath.js mirrors trim.py), so what loops is what gets saved.
import { clampSel, nudge, zoomTo, xToTime, timeToX, peaks, toFrames, sliceWithFades, wavSampleRate } from "./trimmath.js";

const EDGE_PX = 6; // grab distance for selection edges (css px)
const DRAG_PX = 3; // movement before a press becomes a drag instead of a click
const REBUILD_MS = 30;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const fmtT = (t, digits = 3) => `${t.toFixed(digits)} s`;

/**
 * createTrimView(container, {url, duration, selection?, onChange?})
 *   url        WAV to load (the staged source.wav)
 *   duration   file duration in seconds (staged duration = frames / sr)
 *   selection  optional initial {start, end} (e.g. when stepping back to a file); default whole file
 *   onChange   called with {start, end} after every selection change
 * returns {destroy(), getSelection(), setFade(bool), fade, ready, _loop}
 */
export function createTrimView(container, { url, duration, selection = null, onChange = () => {} }) {
  // ---------- DOM ----------
  const root = el("div", "trim");
  root.tabIndex = 0;
  const head = el("div", "trim-row");
  const stateEl = el("span", "trim-state", "loading…");
  const selEl = el("span", "trim-sel");
  const lenEl = el("span", "trim-dim");
  // one non-wrapping, fixed-width unit so the header never reflows while dragging
  const readout = el("span", "trim-readout");
  readout.append(selEl, " ", lenEl);
  const fadeEl = el("span", "trim-fade");
  const zoomBtn = el("button", "modal-btn", "zoom to selection");
  const wholeBtn = el("button", "modal-btn", "whole file");
  for (const b of [zoomBtn, wholeBtn]) {
    b.type = "button";
    b.tabIndex = -1;
  }
  const tools = el("span", "trim-tools"); // the buttons wrap as one unit, never one by one
  tools.append(zoomBtn, wholeBtn);
  head.append(stateEl, el("span", "trim-dim", "selection"), readout, fadeEl, tools);
  const wave = el("canvas", "trim-wave");
  const ruler = el("div", "trim-ruler");
  const mini = el("canvas", "trim-mini");
  const help = el("div", "trim-help");
  help.innerHTML =
    "<span>drag = new selection · drag edges = adjust · click = play from there</span>" +
    "<span><kbd>space</kbd>loop <kbd>←</kbd><kbd>→</kbd>start <kbd>⇧←</kbd><kbd>⇧→</kbd>end <kbd>alt</kbd>1 ms " +
    "<kbd>z</kbd>zoom <kbd>f</kbd>fade</span>";
  root.append(head, wave, ruler, mini, help);
  container.append(root);

  // ---------- state ----------
  let dur = duration || 0;
  let sr = 0; // the file's sample rate (from the WAV header): selections snap to its frames
  let sel = { start: 0, end: dur };
  let view = { from: 0, to: dur };
  let fade = true;
  let ctx = null;
  let decoded = null;
  let channels = []; // Float32Array per channel of `decoded`
  let src = null; // current voice {node: AudioBufferSourceNode, gain: GainNode}
  let play = null; // {mode: "loop"|"play", t0 (ctx time of buffer pos 0), from (file s), len (s)}
  let loopBuf = null;
  let destroyed = false;
  let rebuildTimer = 0;
  let raf = 0;
  let drag = null;
  let peakCache = { key: "", data: null };
  let miniCache = { key: "", data: null };
  const abort = new AbortController();

  // ---------- audio ----------
  // Playback de-click ramp on every voice start/stop/swap. This is a playback envelope on a GainNode only;
  // the R1 edge fades baked into the loop buffer (identical to the server cut) are not touched.
  const RAMP_S = 0.005;

  // Retire the current voice: ramp its gain to 0 over RAMP_S, then stop it (immediately when ramp = false).
  function stopSource(ramp = true) {
    if (!src) return;
    const { node, gain } = src;
    src = null;
    play = null;
    node.onended = () => {
      node.disconnect();
      gain.disconnect();
    };
    const now = ctx.currentTime;
    if (ramp) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + RAMP_S);
    }
    try {
      node.stop(ramp ? now + RAMP_S : 0);
    } catch {}
  }

  // New voice through its own GainNode, ramping 0 -> 1 over RAMP_S. Called right after stopSource(),
  // so the old voice ramps down while this one ramps up: a 5 ms crossfade.
  function startVoice(buffer, loop, offset) {
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = loop; // for the loop: the whole buffer is the loop (gapless, no loopStart/loopEnd)
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + RAMP_S);
    node.connect(gain).connect(ctx.destination);
    node.start(now, offset);
    return { node, gain };
  }

  // Position (file seconds) of what is audible right now, or null.
  function position() {
    if (!play) return null;
    const t = ctx.currentTime - play.t0;
    return play.mode === "loop" ? play.from + (t % play.len) : play.from + t;
  }

  // Frames of the selection in `decoded`. Normally decoded.sampleRate === sr and these are the server's
  // frames exactly; if the browser refused the file's rate we slice by time at the context's rate.
  const loopFrames = () => toFrames(sel, decoded.sampleRate, decoded.length);

  function buildLoop() {
    const { a, b } = loopFrames();
    const data = sliceWithFades(channels, a, b, fade, decoded.sampleRate);
    const buf = ctx.createBuffer(data.length, b - a, decoded.sampleRate);
    data.forEach((d, c) => buf.copyToChannel(d, c));
    return { buf, a, b };
  }

  function startLoop(offset = 0) {
    if (!decoded) return;
    stopSource();
    ctx.resume();
    const { buf, a, b } = buildLoop();
    loopBuf = buf;
    const rate = decoded.sampleRate;
    const len = (b - a) / rate;
    const off = Math.min(Math.max(0, offset), len - 1 / rate);
    src = startVoice(buf, true, off);
    play = { mode: "loop", t0: ctx.currentTime - off, from: a / rate, len };
    tick();
  }

  function playFrom(t) {
    if (!decoded) return;
    stopSource();
    ctx.resume();
    const voice = startVoice(decoded, false, t);
    voice.node.onended = () => {
      voice.node.disconnect();
      voice.gain.disconnect();
      if (src === voice) {
        src = null;
        play = null;
        render();
      }
    };
    src = voice;
    play = { mode: "play", t0: ctx.currentTime, from: t, len: dur - t };
    tick();
  }

  const looping = () => play?.mode === "loop";

  function toggleLoop() {
    if (looping()) stopSource();
    else startLoop();
    render();
  }

  // Selection or fade changed: rebuild the loop, keeping the play position if it is still inside.
  function scheduleRebuild() {
    if (!looping()) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      if (!looping() || destroyed) return;
      const pos = position();
      const rate = decoded.sampleRate;
      const { a, b } = loopFrames();
      const inside = pos >= a / rate && pos < b / rate;
      startLoop(inside ? pos - a / rate : 0);
    }, REBUILD_MS);
  }

  // ---------- selection ----------
  function setSel(next) {
    const s = clampSel(next, dur, sr);
    if (s.start === sel.start && s.end === sel.end) return;
    sel = s;
    scheduleRebuild();
    render();
    onChange({ ...sel });
  }

  function setFade(on) {
    fade = !!on;
    scheduleRebuild();
    render();
  }

  const isWhole = () => view.from <= 0 && view.to >= dur;
  function toggleZoom() {
    view = isWhole() ? zoomTo(sel, dur) : { from: 0, to: dur };
    render();
  }

  // ---------- drawing ----------
  const css = (name, fallback) => getComputedStyle(root).getPropertyValue(name).trim() || fallback;

  function size(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    return { W, H, dpr };
  }

  function cachedPeaks(cache, v, W) {
    const key = `${v.from}|${v.to}|${W}`;
    if (cache.key !== key) {
      cache.key = key;
      cache.data = peaks(channels, v, W, decoded.sampleRate);
    }
    return cache.data;
  }

  function bars(g, p, H) {
    const mid = H / 2;
    for (let x = 0; x < p.length; x++) {
      const half = Math.max(0.5, Math.min(1, p[x]) * (mid - 2));
      g.fillRect(x, mid - half, 1, half * 2);
    }
  }

  function drawWave() {
    const { W, H, dpr } = size(wave);
    const g = wave.getContext("2d");
    g.clearRect(0, 0, W, H);
    g.fillStyle = css("--wave-axis", "#3a2d1e");
    g.fillRect(0, Math.round(H / 2), W, 1);
    if (!decoded) return;
    g.fillStyle = css("--wave-fill", "#ffb45f");
    bars(g, cachedPeaks(peakCache, view, W), H);
    const x0 = timeToX(sel.start, W, view);
    const x1 = timeToX(sel.end, W, view);
    g.fillStyle = "rgba(6, 4, 2, 0.72)";
    if (x0 > 0) g.fillRect(0, 0, Math.min(W, x0), H);
    if (x1 < W) g.fillRect(Math.max(0, x1), 0, W - Math.max(0, x1), H);
    g.fillStyle = "rgba(255, 210, 122, 0.10)";
    g.fillRect(x0, 0, x1 - x0, H);
    g.fillStyle = css("--text-hot", "#ffd08a");
    const ew = 2 * dpr;
    g.fillRect(x0 - ew / 2, 0, ew, H);
    g.fillRect(x1 - ew / 2, 0, ew, H);
    const pos = position();
    if (pos != null) {
      g.fillStyle = "#fff3d6";
      g.fillRect(Math.round(timeToX(pos, W, view)), 0, Math.max(1, dpr), H);
    }
  }

  function drawMini() {
    const { W, H, dpr } = size(mini);
    const g = mini.getContext("2d");
    g.clearRect(0, 0, W, H);
    if (!decoded) return;
    const whole = { from: 0, to: dur };
    g.fillStyle = css("--text-dim", "#9a7442");
    bars(g, cachedPeaks(miniCache, whole, W), H);
    g.fillStyle = "rgba(255, 210, 122, 0.22)";
    const s0 = timeToX(sel.start, W, whole);
    g.fillRect(s0, 0, Math.max(dpr, timeToX(sel.end, W, whole) - s0), H);
    g.strokeStyle = css("--text-hot", "#ffd08a");
    g.lineWidth = dpr;
    const v0 = timeToX(view.from, W, whole);
    const v1 = timeToX(view.to, W, whole);
    g.strokeRect(v0 + dpr / 2, dpr / 2, Math.max(dpr, v1 - v0 - dpr), H - dpr);
  }

  function drawRuler() {
    const span = view.to - view.from;
    const digits = span < 0.2 ? 3 : span < 2 ? 2 : span < 20 ? 1 : 0;
    const labels = [];
    for (let k = 0; k <= 4; k++) labels.push(el("span", null, `${(view.from + (k * span) / 4).toFixed(digits)}s`));
    ruler.replaceChildren(...labels);
  }

  function render() {
    if (destroyed) return;
    stateEl.textContent = !decoded ? stateEl.textContent : looping() ? "▶ looping" : play ? "▶ playing" : "■ stopped";
    stateEl.classList.toggle("on", !!play);
    selEl.textContent = `${fmtT(sel.start)} – ${fmtT(sel.end)}`;
    lenEl.textContent = `(${fmtT(sel.end - sel.start)})`;
    fadeEl.textContent = fade ? "fade 5 ms" : "no fade";
    fadeEl.classList.toggle("off", !fade);
    zoomBtn.classList.toggle("hot", !isWhole());
    drawWave();
    drawMini();
    drawRuler();
  }

  function tick() {
    if (raf || destroyed) return;
    const loop = () => {
      raf = 0;
      if (destroyed) return;
      drawWave();
      if (play) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  // ---------- input ----------
  const waveX = (e) => e.clientX - wave.getBoundingClientRect().left;
  const waveT = (e) => Math.min(dur, Math.max(0, xToTime(waveX(e), wave.clientWidth, view)));

  function edgeAt(x) {
    const w = wave.clientWidth;
    const d0 = Math.abs(x - timeToX(sel.start, w, view));
    const d1 = Math.abs(x - timeToX(sel.end, w, view));
    if (Math.min(d0, d1) > EDGE_PX) return null;
    return d0 <= d1 ? "start" : "end";
  }

  function onDown(e) {
    if (!decoded || e.button !== 0) return;
    root.focus({ preventScroll: true });
    wave.setPointerCapture(e.pointerId);
    const edge = edgeAt(waveX(e));
    // every drag is "fixed anchor + pointer": an edge drag anchors the other edge
    drag = edge
      ? { anchor: edge === "start" ? sel.end : sel.start, x: waveX(e), moved: true, edge: true }
      : { anchor: waveT(e), x: waveX(e), moved: false, edge: false };
    e.preventDefault();
  }

  function onMove(e) {
    if (!drag) {
      if (decoded) wave.style.cursor = edgeAt(waveX(e)) ? "ew-resize" : "crosshair";
      return;
    }
    if (!drag.moved && Math.abs(waveX(e) - drag.x) < DRAG_PX) return;
    drag.moved = true;
    const t = waveT(e);
    setSel({ start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) });
  }

  function onUp(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) playFrom(d.anchor);
    else if (!d.edge && !looping()) startLoop(); // a fresh selection is meant to be heard
    render();
    e.preventDefault();
  }

  function onMini(e) {
    if (!decoded) return;
    const r = mini.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * dur;
    const half = (view.to - view.from) / 2;
    const from = Math.min(Math.max(0, t - half), dur - 2 * half);
    view = { from, to: from + 2 * half };
    render();
  }

  function onKey(e) {
    if (!decoded || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === " ") {
      if (!e.repeat) toggleLoop();
    } else if (k === "ArrowLeft" || k === "ArrowRight") {
      const step = (e.altKey ? 0.001 : 0.01) * (k === "ArrowLeft" ? -1 : 1);
      setSel(nudge(sel, e.shiftKey ? "end" : "start", step, dur, sr));
    } else if (e.code === "KeyZ") {
      if (!e.repeat) toggleZoom();
    } else if (e.code === "KeyF") {
      if (!e.repeat) setFade(!fade);
    } else return;
    e.preventDefault();
    e.stopPropagation(); // keep app.js's global keys (space = audition, f = star, ...) out of it
  }

  const keepFocus = (e) => e.preventDefault(); // buttons must not steal focus from the view
  zoomBtn.addEventListener("mousedown", keepFocus);
  wholeBtn.addEventListener("mousedown", keepFocus);
  zoomBtn.onclick = () => {
    view = zoomTo(sel, dur);
    render();
  };
  wholeBtn.onclick = () => {
    view = { from: 0, to: dur };
    render();
  };
  wave.addEventListener("pointerdown", onDown);
  wave.addEventListener("pointermove", onMove);
  wave.addEventListener("pointerup", onUp);
  wave.addEventListener("pointercancel", () => (drag = null));
  mini.addEventListener("pointerdown", onMini);
  root.addEventListener("keydown", onKey);
  const ro = new ResizeObserver(() => render());
  ro.observe(root);

  // ---------- load ----------
  const ready = (async () => {
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(`source not available (${res.status})`);
    const bytes = await res.arrayBuffer();
    if (destroyed) return;
    const fileSr = wavSampleRate(bytes);
    // Decode at the file's own rate so decodeAudioData doesn't resample; fall back to the default rate.
    try {
      ctx = fileSr ? new AudioContext({ sampleRate: fileSr }) : new AudioContext();
    } catch {
      ctx = new AudioContext();
    }
    decoded = await ctx.decodeAudioData(bytes);
    if (destroyed) return;
    sr = fileSr || decoded.sampleRate;
    channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    dur = duration || decoded.length / decoded.sampleRate;
    sel = clampSel(selection ?? { start: 0, end: dur }, dur, sr);
    view = { from: 0, to: dur };
    stateEl.textContent = "";
    render();
  })();
  ready.catch((err) => {
    if (destroyed) return;
    stateEl.textContent = `could not load audio: ${err.message}`;
    stateEl.classList.add("bad");
  });
  render();

  return {
    ready,
    getSelection: () => ({ ...sel }),
    setFade,
    get fade() {
      return fade;
    },
    /** diagnostics: the AudioBuffer currently (or last) looped, or null */
    get _loop() {
      return loopBuf;
    },
    get sampleRate() {
      return ctx?.sampleRate ?? null;
    },
    focus: () => root.focus({ preventScroll: true }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      clearTimeout(rebuildTimer);
      cancelAnimationFrame(raf);
      stopSource(false); // the context closes right after
      ro.disconnect();
      root.removeEventListener("keydown", onKey);
      wave.removeEventListener("pointerdown", onDown);
      wave.removeEventListener("pointermove", onMove);
      wave.removeEventListener("pointerup", onUp);
      mini.removeEventListener("pointerdown", onMini);
      ctx?.close();
      root.remove();
    },
  };
}
