import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-macros-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { processRegionEvents } = await import("./regions.ts");
const { canSee } = await import("../shared/permissions.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;
type MacroDoc = import("../shared/protocol.ts").MacroDoc;

function setup() {
  const world = World.create({ id: `m${Math.random().toString(36).slice(2, 8)}`, title: "T", system: "ordemparanormal" });
  const [gm, alice, bob] = world.createAsSystem("User", [{ name: "GM", role: "gm" }, { name: "Alice" }, { name: "Bob" }]) as UserDoc[];
  return { world, gm, alice, bob };
}

test("players make macros as themselves; others need sharing to see, run or edit them", () => {
  const { world, gm, alice, bob } = setup();
  const [c] = world.apply({ op: "create", type: "Macro", data: [{ name: "Ataque", type: "chat", command: "/r 1d20", author: bob._id }] }, alice);
  const m = c.after as MacroDoc;
  assert.equal(m.author, alice._id, "author is the creator, whatever the client says");
  assert.equal(canSee("Macro", m, bob, world), false);
  assert.equal(canSee("Macro", m, gm, world), true);
  assert.throws(() => world.apply({ op: "update", type: "Macro", updates: [{ _id: m._id, command: "x" }] }, bob), /Sem permissão/);

  world.apply({ op: "update", type: "Macro", updates: [{ _id: m._id, ownership: { default: 1 } }] }, alice);
  assert.equal(canSee("Macro", world.get("Macro", m._id)!, bob, world), true);
  assert.throws(() => world.apply({ op: "update", type: "Macro", updates: [{ _id: m._id, command: "x" }] }, bob), /Sem permissão/);

  world.apply({ op: "update", type: "Macro", updates: [{ _id: m._id, ownership: { default: 3 } }] }, alice);
  world.apply({ op: "update", type: "Macro", updates: [{ _id: m._id, command: "/r 2d20kh" }] }, bob);
  assert.throws(() => world.apply({ op: "update", type: "Macro", updates: [{ _id: m._id, author: bob._id }] }, bob), /Sem permissão/);
  assert.throws(() => world.apply({ op: "create", type: "Macro", data: [{ name: "X", type: "python" }] }, alice), /tipo inválido/);
  world.apply({ op: "delete", type: "Macro", ids: [m._id] }, bob);
  assert.equal(world.get("Macro", m._id), undefined);
});

test("region 'execute macro': the mover if allowed, else the GM; or everyone who may run it", () => {
  const { world, gm, alice } = setup();
  const [scene] = world.createAsSystem("Scene", [{ name: "S", width: 2000, height: 2000 }]);
  const [actor] = world.createAsSystem("Actor", [{ name: "Omar", ownership: { default: 0, [alice._id]: 3 } }]);
  const [token] = world.createAsSystem("Token", [{ actorId: actor._id, actorLink: true, x: 0, y: 0 }], scene._id);
  const [macro] = world.apply({ op: "create", type: "Macro", data: [{ name: "Armadilha", type: "script", command: "" }] }, gm).map(c => c.after!);
  const [region] = world.createAsSystem("Region", [{
    name: "Fosso", shapes: [{ type: "rectangle", x: 500, y: 0, width: 300, height: 300 }],
    behaviors: [{ _id: "b1", name: "", disabled: false, type: "executeMacro", system: { macroId: macro._id, events: ["tokenEnter"], everyone: false } }]
  }], scene._id);
  const move = (x: number) => processRegionEvents(world, world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x, y: 0 }] }, alice), alice._id);

  // Alice can't run the GM's private macro → the GM gets it, once.
  let { emits } = move(600);
  assert.equal(emits.length, 1);
  assert.deepEqual(emits[0].to, [gm._id]);
  assert.equal(emits[0].once, true);
  assert.equal((emits[0].data as { event: string }).event, "tokenEnter");
  assert.equal(move(0).emits.length, 0, "exit isn't listed");

  // Shared with everyone → the mover runs it.
  world.apply({ op: "update", type: "Macro", updates: [{ _id: macro._id, ownership: { default: 1 } }] }, gm);
  ({ emits } = move(600));
  assert.equal(emits[0].to![0], alice._id);
  move(0);

  world.apply({ op: "update", type: "Region", parent: scene._id, updates: [{ _id: region._id, behaviors: [{ _id: "b1", name: "", disabled: false, type: "executeMacro", system: { macroId: macro._id, events: ["tokenEnter"], everyone: true } }] }] }, gm);
  ({ emits } = move(600));
  assert.equal(emits[0].once, undefined);
  assert.equal(emits[0].to!.length, 3);
});
