import { test } from "node:test";
import assert from "node:assert/strict";
import { gridDistance, movementBlocked, pointInPolygon, sideOf, visibilityPolygon, wallEdges } from "./geometry.ts";
import type { WallDoc } from "./protocol.ts";

const bounds = { x: 0, y: 0, width: 1000, height: 1000 };

function wall(c: [number, number, number, number], extra: Partial<WallDoc> = {}): WallDoc {
  return { _id: Math.random().toString(36), c, move: 20, sight: 20, light: 20, sound: 20, dir: 0, door: 0, ds: 0, ...extra };
}

test("open room: everything visible", () => {
  const poly = visibilityPolygon({ x: 500, y: 500 }, [], bounds);
  assert.ok(pointInPolygon({ x: 10, y: 10 }, poly));
  assert.ok(pointInPolygon({ x: 990, y: 990 }, poly));
});

test("a wall casts a shadow", () => {
  const edges = wallEdges([wall([600, 0, 600, 1000])], "sight");
  const poly = visibilityPolygon({ x: 300, y: 500 }, edges, bounds);
  assert.ok(pointInPolygon({ x: 550, y: 500 }, poly));
  assert.ok(!pointInPolygon({ x: 700, y: 500 }, poly));
});

test("open doors don't block, closed and locked do", () => {
  const open = wallEdges([wall([600, 0, 600, 1000], { door: 1, ds: 1 })], "sight");
  const locked = wallEdges([wall([600, 0, 600, 1000], { door: 1, ds: 2 })], "sight");
  assert.equal(open.length, 0);
  assert.equal(locked.length, 1);
});

test("limited (terrain) walls: see through one, not two", () => {
  const one = wallEdges([wall([600, 0, 600, 1000], { sight: 10 })], "sight");
  const two = wallEdges([wall([600, 0, 600, 1000], { sight: 10 }), wall([700, 0, 700, 1000], { sight: 10 })], "sight");
  const o = { x: 300, y: 500 };
  assert.ok(pointInPolygon({ x: 800, y: 500 }, visibilityPolygon(o, one, bounds)));
  assert.ok(pointInPolygon({ x: 650, y: 500 }, visibilityPolygon(o, two, bounds)));
  assert.ok(!pointInPolygon({ x: 800, y: 500 }, visibilityPolygon(o, two, bounds)));
});

test("one-way walls follow Foundry's side convention", () => {
  // a=(600,0) → b=(600,1000): orient2d < 0 on the west side, which Foundry calls LEFT.
  const [e] = wallEdges([wall([600, 0, 600, 1000], { dir: 1 })], "sight");
  assert.equal(sideOf(e, { x: 300, y: 500 }), 1);
  assert.equal(sideOf(e, { x: 900, y: 500 }), 2);
  // dir LEFT = transparent when the viewer is on the left (west), blocks from the right (east).
  assert.ok(pointInPolygon({ x: 800, y: 500 }, visibilityPolygon({ x: 300, y: 500 }, [e], bounds)));
  assert.ok(!pointInPolygon({ x: 300, y: 500 }, visibilityPolygon({ x: 900, y: 500 }, [e], bounds)));
});

test("radius and cone limit the polygon", () => {
  const o = { x: 500, y: 500 };
  const round = visibilityPolygon(o, [], bounds, { radius: 100 });
  assert.ok(pointInPolygon({ x: 590, y: 500 }, round));
  assert.ok(!pointInPolygon({ x: 620, y: 500 }, round));
  // Facing down (rotation 0) with a 90° cone: below is visible, above is not.
  const cone = visibilityPolygon(o, [], bounds, { radius: 300, angle: 90, rotation: 0 });
  assert.ok(pointInPolygon({ x: 500, y: 700 }, cone));
  assert.ok(!pointInPolygon({ x: 500, y: 300 }, cone));
  assert.ok(!pointInPolygon({ x: 700, y: 500 }, cone));
});

test("crossing walls keep a sharp corner", () => {
  const edges = wallEdges([wall([400, 300, 800, 300]), wall([600, 100, 600, 500])], "sight");
  const poly = visibilityPolygon({ x: 500, y: 600 }, edges, bounds);
  assert.ok(pointInPolygon({ x: 590, y: 310 }, poly));
  assert.ok(!pointInPolygon({ x: 590, y: 290 }, poly));
});

test("movement collision", () => {
  const edges = wallEdges([wall([600, 0, 600, 1000]), wall([0, 800, 1000, 800], { move: 0 })], "move");
  assert.ok(movementBlocked({ x: 550, y: 50 }, { x: 650, y: 50 }, edges));
  assert.ok(!movementBlocked({ x: 550, y: 750 }, { x: 550, y: 850 }, edges), "move: NONE walls don't block");
  assert.ok(!movementBlocked({ x: 100, y: 100 }, { x: 500, y: 500 }, edges));
});

test("grid distance counts diagonals as one square", () => {
  assert.equal(gridDistance({ x: 0, y: 0 }, { x: 300, y: 100 }, 100, 1.5), 4.5);
  assert.equal(gridDistance({ x: 0, y: 0 }, { x: 300, y: 300 }, 100, 1.5), 4.5);
});
