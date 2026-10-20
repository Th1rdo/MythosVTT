import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-combat-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { runCombatAction } = await import("./combat.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;
type CombatDoc = import("../shared/protocol.ts").CombatDoc;
type CombatantDoc = import("../shared/protocol.ts").CombatantDoc;

function setup() {
  const world = World.create({ id: `c${Math.random().toString(36).slice(2, 8)}`, title: "T", system: "ordemparanormal" });
  const [gm, alice, bob] = world.createAsSystem("User", [{ name: "GM", role: "gm" }, { name: "Alice" }, { name: "Bob" }]) as UserDoc[];
  const [scene] = world.createAsSystem("Scene", [{ name: "S" }]);
  const agent = {
    attributes: { dex: { value: 3 } },
    skills: { initiative: { attr: ["dex", 1], degree: { label: "trained" }, mod: null, value: 0 } }
  };
  const [omar, cultist] = world.createAsSystem("Actor", [
    { name: "Omar", system: agent, ownership: { default: 0, [alice._id]: 3 } },
    { name: "Cultista", type: "threat" }
  ]);
  const [t1, t2] = world.createAsSystem("Token", [
    { name: "Omar", actorId: omar._id, x: 0, y: 0 },
    { name: "Cultista", actorId: cultist._id, x: 200, y: 0 }
  ], scene._id);
  return { world, gm, alice, bob, scene, t1, t2 };
}

type WorldT = ReturnType<typeof setup>["world"];
const combatOf = (world: WorldT, sceneId: string) =>
  world.all<CombatDoc>("Combat").find((c: CombatDoc) => c.sceneId === sceneId)!;
const combatantsOf = (world: WorldT, combatId: string) =>
  world.all<CombatantDoc>("Combatant").filter((c: CombatantDoc) => c._parent === combatId);

test("GM adds tokens (creating the encounter), rolls, starts and advances", () => {
  const { world, gm, scene, t1, t2 } = setup();
  runCombatAction(world, gm, { action: "toggleTokens", sceneId: scene._id, tokenIds: [t1._id, t2._id] });
  const combat = combatOf(world, scene._id);
  assert.equal(combatantsOf(world, combat._id).length, 2);

  const changes = runCombatAction(world, gm, { action: "rollAll", combatId: combat._id });
  const rolls = changes.filter(c => c.type === "ChatMessage").map(c => (c.after as any).roll.formula);
  assert.deepEqual(rolls.sort(), ["1d20", "3d20kh+5"], "OP initiative = Iniciativa skill test; actors without OP data roll 1d20");
  assert.ok(combatantsOf(world, combat._id).every(c => typeof c.initiative === "number"));

  runCombatAction(world, gm, { action: "start", combatId: combat._id });
  const started = combatOf(world, scene._id);
  assert.equal(started.round, 1);
  assert.ok(started.current);
  runCombatAction(world, gm, { action: "nextTurn", combatId: combat._id });
  runCombatAction(world, gm, { action: "nextTurn", combatId: combat._id });
  assert.equal(combatOf(world, scene._id).round, 2);
});

test("players: own tokens only, roll own initiative, end only their own turn", () => {
  const { world, gm, alice, bob, scene, t1, t2 } = setup();
  assert.throws(() => runCombatAction(world, alice, { action: "toggleTokens", sceneId: scene._id, tokenIds: [t1._id] }), /criou/);
  runCombatAction(world, gm, { action: "toggleTokens", sceneId: scene._id, tokenIds: [t2._id] });
  runCombatAction(world, alice, { action: "toggleTokens", sceneId: scene._id, tokenIds: [t1._id] });
  assert.throws(() => runCombatAction(world, alice, { action: "toggleTokens", sceneId: scene._id, tokenIds: [t2._id] }), /permissão/);

  const combat = combatOf(world, scene._id);
  const [mine, theirs] = ["Omar", "Cultista"].map(n => combatantsOf(world, combat._id).find(c => c.name === n)!);
  runCombatAction(world, alice, { action: "rollInitiative", combatId: combat._id, combatantIds: [mine._id] });
  assert.throws(() => runCombatAction(world, alice, { action: "rollInitiative", combatId: combat._id, combatantIds: [theirs._id] }), /permissão/);
  assert.throws(() => runCombatAction(world, bob, { action: "start", combatId: combat._id }), /permissão/);

  // Force a known order: Omar first.
  world.applyAsSystem({ op: "update", type: "Combatant", parent: combat._id, updates: [{ _id: mine._id, initiative: 30 }, { _id: theirs._id, initiative: 1 }] });
  runCombatAction(world, gm, { action: "start", combatId: combat._id });
  assert.throws(() => runCombatAction(world, bob, { action: "nextTurn", combatId: combat._id }), /permissão/);
  runCombatAction(world, alice, { action: "nextTurn", combatId: combat._id });
  assert.equal(combatOf(world, scene._id).current, theirs._id);
  assert.throws(() => runCombatAction(world, alice, { action: "nextTurn", combatId: combat._id }), /permissão/, "not her turn any more");
});

test("deleting the current combatant's token passes the turn; deleting the scene removes the encounter", () => {
  const { world, gm, scene, t1, t2 } = setup();
  runCombatAction(world, gm, { action: "toggleTokens", sceneId: scene._id, tokenIds: [t1._id, t2._id] });
  const combat = combatOf(world, scene._id);
  const [a, b] = combatantsOf(world, combat._id);
  world.applyAsSystem({ op: "update", type: "Combatant", parent: combat._id, updates: [{ _id: a._id, initiative: 20 }, { _id: b._id, initiative: 10 }] });
  runCombatAction(world, gm, { action: "start", combatId: combat._id });
  assert.equal(combatOf(world, scene._id).current, a._id);
  world.apply({ op: "delete", type: "Token", parent: scene._id, ids: [a.tokenId!] }, gm);
  assert.equal(combatantsOf(world, combat._id).length, 1);
  assert.equal(combatOf(world, scene._id).current, b._id);
  world.apply({ op: "delete", type: "Scene", ids: [scene._id] }, gm);
  assert.equal(world.all("Combat").length, 0);
  assert.equal(world.all("Combatant").length, 0);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
