// Pure map math (no DOM): world <-> screen transform and a uniform grid for hit tests.
// World = the unit square of the layout (x, y in 0..1). A view is { scale, ox, oy }:
//   screen = o + world * scale

export function fitView(w, h, pad = 24) {
  const scale = Math.max(1, Math.min(w, h) - 2 * pad);
  return { scale, ox: (w - scale) / 2, oy: (h - scale) / 2 };
}

export const toScreen = (v, wx, wy) => [v.ox + wx * v.scale, v.oy + wy * v.scale];
export const toWorld = (v, sx, sy) => [(sx - v.ox) / v.scale, (sy - v.oy) / v.scale];

// Zoom by `factor` around screen point (sx, sy); the world point under it stays put.
export function zoomAt(v, sx, sy, factor, { min = 0, max = Infinity } = {}) {
  const scale = Math.min(max, Math.max(min, v.scale * factor));
  const [wx, wy] = toWorld(v, sx, sy);
  return { scale, ox: sx - wx * scale, oy: sy - wy * scale };
}

const placed = (p) => p.x != null && p.y != null;

// Uniform n x n grid over the unit square; cells hold point indices. Points outside
// 0..1 (should not happen) are clamped into the border cells.
export function buildGrid(points, n = 64) {
  const cells = Array.from({ length: n * n }, () => []);
  const cell = (c) => Math.min(n - 1, Math.max(0, Math.floor(c * n)));
  points.forEach((p, i) => {
    if (placed(p)) cells[cell(p.y) * n + cell(p.x)].push(i);
  });
  return { n, cells, cell };
}

// Index of the point nearest to (wx, wy) within world radius r, or -1.
export function nearest(grid, points, wx, wy, r) {
  const { n, cells, cell } = grid;
  const x0 = cell(wx - r), x1 = cell(wx + r), y0 = cell(wy - r), y1 = cell(wy + r);
  let best = -1;
  let bd = r * r;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      for (const i of cells[cy * n + cx]) {
        const p = points[i];
        const d = (p.x - wx) ** 2 + (p.y - wy) ** 2;
        if (d <= bd) {
          bd = d;
          best = i;
        }
      }
    }
  }
  return best;
}

// The k placed points closest to points[i] (excluding i), nearest first.
export function kNearest(points, i, k) {
  const p = points[i];
  if (!p || !placed(p)) return [];
  const out = [];
  points.forEach((q, j) => {
    if (j !== i && placed(q)) out.push([(q.x - p.x) ** 2 + (q.y - p.y) ** 2, j]);
  });
  out.sort((a, b) => a[0] - b[0]);
  return out.slice(0, k).map((e) => e[1]);
}
