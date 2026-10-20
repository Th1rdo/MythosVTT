import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-tables-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { runTableAction } = await import("./tables.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;
type RollTableDoc = import("../shared/protocol.ts").RollTableDoc;
type TableResultDoc = import("../shared/protocol.ts").TableResultDoc;
type ChatMessageDoc = import("../shared/protocol.ts").ChatMessageDoc;

/** Dice that roll the given faces in order, then repeat the last. */
const dice = (...faces: number[]) => () => (faces.length > 1 ? faces.shift()! : faces[0]);

function setup(over: Partial<RollTableDoc> = {}) {
  const world = World.create({ id: `t${Math.random().toString(36).slice(2, 8)}`, title: "T", system: "ordemparanormal" });
  const [gm, alice] = world.createAsSystem("User", [{ name: "GM", role: "gm" }, { name: "Alice" }]) as UserDoc[];
  const [table] = world.createAsSystem("RollTable", [{ name: "Encontros", ...over }]) as RollTableDoc[];
  world.createAsSystem("TableResult", [
    { name: "Nada", weight: 2, range: [1, 2] }, { name: "Cultistas", weight: 1, range: [3, 3] }, { name: "Criatura", weight: 1, range: [4, 4] }
  ], table._id);
  const last = () => world.all<ChatMessageDoc>("ChatMessage").at(-1)!;
  const results = () => Object.fromEntries(world.all<TableResultDoc>("TableResult").map(r => [r.name, r]));
  return { world, gm, alice, table, last, results };
}

test("draws by weight with the automatic formula and posts a card", () => {
  const { world, gm, table, last } = setup();
  runTableAction(world, gm, { action: "draw", tableId: table._id }, dice(3));
  assert.equal(last().table?.results[0].name, "Cultistas");
  assert.equal(last().roll?.formula, "1d4");
  runTableAction(world, gm, { action: "draw", tableId: table._id }, dice(2));
  assert.equal(last().table?.results[0].name, "Nada");
});

test("without replacement, drawn results are skipped until reset", () => {
  const { world, gm, table, last, results } = setup({ replacement: false });
  runTableAction(world, gm, { action: "draw", tableId: table._id }, dice(4));
  assert.equal(results().Criatura.drawn, true);
  // Rolling 4 again must retry until it lands elsewhere.
  runTableAction(world, gm, { action: "draw", tableId: table._id }, dice(4, 4, 3));
  assert.equal(last().table?.results[0].name, "Cultistas");
  runTableAction(world, gm, { action: "draw", tableId: table._id, count: 5 }, dice(1, 2, 1));
  assert.equal(last().table?.results.length, 1, "only one result left");
  assert.throws(() => runTableAction(world, gm, { action: "draw", tableId: table._id }, dice(1)), /repõe-a/);
  runTableAction(world, gm, { action: "reset", tableId: table._id }, dice(1));
  assert.equal(Object.values(results()).some(r => r.drawn), false);
});

test("nested tables are drawn from; normalize re-lays ranges; permissions", () => {
  const { world, gm, alice, table, last, results } = setup();
  const [inner] = world.createAsSystem("RollTable", [{ name: "Criaturas" }]) as RollTableDoc[];
  world.createAsSystem("TableResult", [{ name: "Zumbi de Sangue", range: [1, 1] }], inner._id);
  world.apply({ op: "update", type: "TableResult", parent: table._id, updates: [{ _id: results().Criatura._id, type: "document", document: { type: "RollTable", id: inner._id } }] }, gm);
  runTableAction(world, gm, { action: "draw", tableId: table._id }, dice(4, 1));
  assert.equal(last().table?.results[0].name, "Zumbi de Sangue");
  assert.equal(last().table?.results[0].from, "Criaturas");

  world.apply({ op: "update", type: "TableResult", parent: table._id, updates: [{ _id: results().Nada._id, weight: 5 }] }, gm);
  runTableAction(world, gm, { action: "normalize", tableId: table._id }, dice(1));
  assert.equal((world.get("RollTable", table._id) as RollTableDoc).formula, "1d7");
  assert.deepEqual(results().Cultistas.range, [6, 6]);

  assert.throws(() => runTableAction(world, alice, { action: "draw", tableId: table._id }, dice(1)), /Sem permissão/);
  world.apply({ op: "update", type: "RollTable", updates: [{ _id: table._id, ownership: { default: 2 } }] }, gm);
  runTableAction(world, alice, { action: "draw", tableId: table._id, mode: "blind" }, dice(1));
  assert.equal(last().blind, true);
  assert.throws(() => runTableAction(world, alice, { action: "reset", tableId: table._id }, dice(1)), /Sem permissão/);
  assert.throws(() => world.apply({ op: "update", type: "TableResult", parent: table._id, updates: [{ _id: results().Nada._id, drawn: true }] }, alice), /Sem permissão/);
});
