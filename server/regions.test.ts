import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-regions-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { processRegionEvents } = await import("./regions.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;
type TokenDoc = import("../shared/protocol.ts").TokenDoc;

function setup() {
  const world = World.create({ id: `r${Math.random().toString(36).slice(2, 8)}`, title: "T", system: "ordemparanormal" });
  const [gm, alice] = world.createAsSystem("User", [{ name: "GM", role: "gm" }, { name: "Alice" }]) as UserDoc[];
  const [scene] = world.createAsSystem("Scene", [{ name: "S", width: 2000, height: 2000 }]);
  const [actor] = world.createAsSystem("Actor", [{ name: "Omar", ownership: { default: 0, [alice._id]: 3 } }]);
  const [token] = world.createAsSystem("Token", [{ actorId: actor._id, actorLink: true, x: 0, y: 0 }], scene._id);
  const move = (x: number, y: number, user = alice, extra: Record<string, unknown> = {}) => {
    const changes = world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x, y, ...extra }] }, user);
    return processRegionEvents(world, changes, user._id);
  };
  return { world, gm, alice, scene, actor, token, move };
}

const square = (x: number, y: number, size = 300) => [{ type: "rectangle", x, y, width: size, height: size }];

test("teleport moves a token entering the region to a destination region", () => {
  const { world, scene, token, move } = setup();
  const [dest] = world.createAsSystem("Region", [{ name: "Saída", shapes: square(1500, 1500) }], scene._id);
  world.createAsSystem("Region", [{
    name: "Alçapão", shapes: square(500, 0),
    behaviors: [{ _id: "b1", name: "", disabled: false, type: "teleportToken", system: { destinations: [dest._id] } }]
  }], scene._id);
  move(600, 0);
  const t = world.get("Token", token._id) as TokenDoc;
  assert.ok(t.x >= 1450 && t.x <= 1800 && t.y >= 1450 && t.y <= 1800, `landed at ${t.x},${t.y}`);
});

test("apply effect on enter, remove it on exit; scrolling text goes to owners", () => {
  const { world, alice, gm, scene, actor, move } = setup();
  world.createAsSystem("Region", [{
    name: "Névoa", shapes: square(500, 0),
    behaviors: [
      { _id: "b1", name: "", disabled: false, type: "applyActiveEffect", system: { effect: { name: "Envenenado", icon: "☠️", disabled: false, statuses: ["envenenado"], changes: [], duration: { rounds: null, startRound: null, combat: null }, description: "" } } },
      { _id: "b2", name: "", disabled: false, type: "displayScrollingText", system: { text: "Cheira mal…", color: "#00ff00", events: ["tokenEnter"], visibility: "owner" } }
    ]
  }], scene._id);
  const entered = move(600, 0);
  assert.equal(world.all("ActiveEffect").filter(e => e._parent === actor._id).length, 1);
  const text = entered.emits.find(e => e.event === "scrollingText")!;
  assert.deepEqual([...text.to!].sort(), [alice._id, gm._id].sort());
  move(1200, 0);
  assert.equal(world.all("ActiveEffect").filter(e => e._parent === actor._id).length, 0);
});

test("change level asks the mover which floor; disabled behaviours do nothing", () => {
  const { world, alice, scene, move } = setup();
  const [rc, up] = world.createAsSystem("Level", [{ name: "R/C", elevation: { bottom: 0, top: 10 } }, { name: "1.º", elevation: { bottom: 10, top: 20 } }], scene._id);
  world.createAsSystem("Region", [{
    name: "Escadas", shapes: square(500, 0), levels: [rc._id, up._id],
    behaviors: [{ _id: "b1", name: "", disabled: false, type: "changeLevel", system: {} }]
  }], scene._id);
  const res = move(600, 0);
  const prompt = res.emits.find(e => e.event === "levelPrompt")!;
  assert.deepEqual(prompt.to, [alice._id]);
  assert.deepEqual((prompt.data as { levels: string[] }).levels, [up._id]);

  const [r2] = world.createAsSystem("Region", [{
    name: "Off", shapes: square(1200, 1200),
    behaviors: [{ _id: "b9", name: "", disabled: true, type: "displayScrollingText", system: { text: "x", color: "#fff", events: ["tokenEnter"], visibility: "all" } }]
  }], scene._id);
  assert.equal(move(1300, 1300).emits.length, 0);
  void r2;
});

test("players place templates (forced to be their own, behaviour-free) and can't touch GM regions", () => {
  const { world, alice, gm, scene } = setup();
  const [c] = world.apply({ op: "create", type: "Region", parent: scene._id, data: [{ shapes: [{ type: "circle", x: 100, y: 100, radius: 150 }], behaviors: [{ type: "teleportToken" }] }] }, alice);
  const r = c.after as unknown as { template: { author: string }; behaviors: unknown[]; visibility: number };
  assert.equal(r.template.author, alice._id);
  assert.equal(r.behaviors.length, 0);
  assert.equal(r.visibility, 2);
  world.apply({ op: "update", type: "Region", parent: scene._id, updates: [{ _id: c.after!._id, shapes: [{ type: "circle", x: 200, y: 200, radius: 150 }] }] }, alice);
  const [gmRegion] = world.apply({ op: "create", type: "Region", parent: scene._id, data: [{ shapes: square(0, 0) }] }, gm);
  assert.throws(() => world.apply({ op: "delete", type: "Region", parent: scene._id, ids: [gmRegion.after!._id] }, alice), /permissão/);
  assert.throws(() => world.apply({ op: "create", type: "Region", parent: scene._id, data: [{ shapes: [{ type: "circle", x: "a" }] }] }, alice), /forma/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
