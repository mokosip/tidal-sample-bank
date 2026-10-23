// Mirrored peak bars (peaks = 64 abs-max values in 0..1 from analysis.py).
export function drawPeaks(canvas, peaks) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(canvas);
  const mid = h / 2;

  ctx.fillStyle = css.getPropertyValue("--wave-axis").trim() || "#2a2b28";
  ctx.fillRect(0, Math.round(mid), w, 1);
  if (!peaks || !peaks.length) return;

  const step = w / peaks.length;
  const bar = Math.max(1, step * 0.6);
  ctx.fillStyle = css.getPropertyValue("--wave-fill").trim() || "#ffb45f";
  for (let i = 0; i < peaks.length; i++) {
    const p = Math.min(1, Math.max(0, peaks[i]));
    const half = Math.max(0.5, p * (mid - 2));
    ctx.fillRect(i * step + (step - bar) / 2, mid - half, bar, half * 2);
  }
}
