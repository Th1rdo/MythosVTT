import { test } from "node:test";
import assert from "node:assert/strict";
import { GRID, cellCenter, hexAt, hexCenter, measure, snapPoint, snapTokenPosition } from "./grid.ts";

const square = { type: GRID.SQUARE, size: 100, distance: 1.5 };
const oddR = { type: GRID.HEX_ODD_R, size: 100, distance: 1.5 };
const evenQ = { type: GRID.HEX_EVEN_Q, size: 100, distance: 1.5 };
const none = { type: GRID.GRIDLESS, size: 100, distance: 1.5 };

test("square grid keeps the old behaviour", () => {
  assert.equal(measure(square, { x: 0, y: 0 }, { x: 300, y: 100 }), 4.5);
  assert.deepEqual(snapPoint(square, { x: 140, y: 26 }), { x: 150, y: 50 });
  assert.deepEqual(snapTokenPosition(square, { x: 140, y: 260 }, 1, 1), { x: 100, y: 300 });
});

test("hex centres round-trip and neighbours are one hex apart", () => {
  for (const g of [oddR, evenQ]) {
    for (const [row, col] of [[0, 0], [3, 5], [4, 2], [7, 7]]) {
      const c = hexCenter(g, row, col);
      assert.deepEqual(hexAt(g, c), { row, col });
      assert.deepEqual(hexAt(g, { x: c.x + 10, y: c.y - 10 }), { row, col }, "points near a centre map to that hex");
    }
  }
  // odd-r: row 1 is shifted right by half a hex.
  assert.equal(hexCenter(oddR, 1, 0).x - hexCenter(oddR, 0, 0).x, 50);
  // Each step to an adjacent hex is one cell (odd-r: an even row touches columns c-1 and c above and below).
  const a = hexCenter(oddR, 2, 2);
  for (const [r, c] of [[2, 3], [2, 1], [1, 1], [1, 2], [3, 1], [3, 2]]) assert.equal(measure(oddR, a, hexCenter(oddR, r, c)), 1.5);
  assert.equal(measure(oddR, hexCenter(oddR, 0, 0), hexCenter(oddR, 0, 4)), 6);
});

test("hex snapping puts token centres on hex centres", () => {
  const p = snapTokenPosition(oddR, { x: 237, y: 190 }, 1, 1);
  const centre = { x: p.x + 50, y: p.y + 50 };
  const c = cellCenter(oddR, centre);
  assert.ok(Math.abs(c.x - centre.x) <= 1 && Math.abs(c.y - centre.y) <= 1);
});

test("gridless measures straight lines and doesn't snap", () => {
  assert.equal(measure(none, { x: 0, y: 0 }, { x: 300, y: 400 }), 7.5);
  assert.deepEqual(snapPoint(none, { x: 12.4, y: 7.6 }), { x: 12, y: 8 });
});
