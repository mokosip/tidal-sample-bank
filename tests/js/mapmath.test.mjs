import { test } from "node:test";
import assert from "node:assert/strict";
import { fitView, toScreen, toWorld, zoomAt, buildGrid, nearest, kNearest } from "../../src/samplebank/static/mapmath.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("fitView centres the unit square inside the canvas with padding", () => {
  const v = fitView(1000, 600, 20);
  assert.equal(v.scale, 560);
  const [x0, y0] = toScreen(v, 0, 0);
  const [x1, y1] = toScreen(v, 1, 1);
  close(y0, 20);
  close(y1, 580);
  close((x0 + x1) / 2, 500);
});

test("toWorld inverts toScreen", () => {
  const v = { scale: 731.5, ox: -42.25, oy: 17 };
  const [sx, sy] = toScreen(v, 0.3, 0.8);
  const [wx, wy] = toWorld(v, sx, sy);
  close(wx, 0.3);
  close(wy, 0.8);
});

test("zoomAt keeps the world point under the cursor fixed", () => {
  let v = fitView(1000, 800, 20);
  for (const [sx, sy, f] of [[123, 456, 1.5], [800, 50, 3], [400, 400, 0.4], [0, 799, 7]]) {
    const before = toWorld(v, sx, sy);
    v = zoomAt(v, sx, sy, f);
    const after = toWorld(v, sx, sy);
    close(after[0], before[0], 1e-9);
    close(after[1], before[1], 1e-9);
  }
});

test("zoomAt clamps the scale and still keeps the cursor point fixed", () => {
  const v = { scale: 500, ox: 10, oy: 10 };
  const z = zoomAt(v, 300, 200, 1e6, { min: 100, max: 5000 });
  assert.equal(z.scale, 5000);
  const before = toWorld(v, 300, 200);
  const after = toWorld(z, 300, 200);
  close(after[0], before[0]);
  close(after[1], before[1]);
  assert.equal(zoomAt(v, 0, 0, 1e-6, { min: 100, max: 5000 }).scale, 100);
});

const pts = [
  { x: 0.1, y: 0.1 },
  { x: 0.105, y: 0.1 },
  { x: 0.5, y: 0.5 },
  { x: null, y: null }, // still analysing: never hit
  { x: 0.999, y: 1.0 },
  { x: 0.0, y: 0.0 },
];

test("nearest returns the closest point within the radius", () => {
  const g = buildGrid(pts, 16);
  assert.equal(nearest(g, pts, 0.104, 0.1, 0.01), 1);
  assert.equal(nearest(g, pts, 0.101, 0.1, 0.01), 0);
  assert.equal(nearest(g, pts, 0.5, 0.505, 0.01), 2);
});

test("nearest returns -1 when nothing is inside the radius", () => {
  const g = buildGrid(pts, 16);
  assert.equal(nearest(g, pts, 0.3, 0.3, 0.05), -1);
  assert.equal(nearest(g, pts, 0.5, 0.52, 0.01), -1);
});

test("nearest finds points across cell borders and at the edges of the unit square", () => {
  const g = buildGrid([{ x: 0.2499, y: 0.5 }, { x: 1, y: 1 }, { x: 0, y: 0 }], 4); // cell border at 0.25
  assert.equal(nearest(g, [{ x: 0.2499, y: 0.5 }, { x: 1, y: 1 }, { x: 0, y: 0 }], 0.2501, 0.5, 0.01), 0);
  const p = [{ x: 1, y: 1 }, { x: 0, y: 0 }];
  const g2 = buildGrid(p, 8);
  assert.equal(nearest(g2, p, 1.002, 0.998, 0.01), 0);
  assert.equal(nearest(g2, p, -0.003, 0.001, 0.01), 1);
});

test("nearest works with a radius larger than a cell (zoomed far out)", () => {
  const p = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }];
  const g = buildGrid(p, 64);
  assert.equal(nearest(g, p, 0.3, 0.3, 0.3), 0);
  assert.equal(nearest(g, p, 0.3, 0.3, 0.2), -1);
});

test("nearest agrees with a brute-force scan on random points", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const p = Array.from({ length: 2000 }, () => ({ x: rnd(), y: rnd() }));
  const g = buildGrid(p, 64);
  for (let k = 0; k < 500; k++) {
    const qx = rnd(), qy = rnd(), r = 0.002 + rnd() * 0.03;
    let best = -1, bd = r * r;
    p.forEach((q, i) => {
      const d = (q.x - qx) ** 2 + (q.y - qy) ** 2;
      if (d <= bd) { bd = d; best = i; }
    });
    const got = nearest(g, p, qx, qy, r);
    if (best < 0) assert.equal(got, -1);
    else close((p[got].x - qx) ** 2 + (p[got].y - qy) ** 2, bd, 1e-15);
  }
});

test("kNearest lists the k closest other placed points, nearest first", () => {
  const p = [{ x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }, { x: 0.52, y: 0.5 }, { x: null, y: null }, { x: 0.5, y: 0.45 }, { x: 0.6, y: 0.6 }];
  assert.deepEqual(kNearest(p, 0, 3), [2, 4, 5]);
  assert.deepEqual(kNearest(p, 3, 3), []); // unplaced point has no neighbours
  assert.deepEqual(kNearest(p, 0, 10), [2, 4, 5, 1]);
});
