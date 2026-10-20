import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-test-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { canSee } = await import("../shared/permissions.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;

function setup() {
  const world = World.create({ id: `w${Math.random().toString(36).slice(2, 8)}`, title: "Test", system: "ordemparanormal" });
  const [gm, alice, bob] = world.createAsSystem("User", [
    { name: "GM", role: "gm" }, { name: "Alice" }, { name: "Bob" }
  ]) as UserDoc[];
  const [scene] = world.createAsSystem("Scene", [{ name: "S" }]);
  const [actor] = world.createAsSystem("Actor", [{ name: "Omar", ownership: { default: 0, [alice._id]: 3 } }]);
  const [token] = world.createAsSystem("Token", [{ actorId: actor._id, x: 100, y: 100 }], scene._id);
  return { world, gm, alice, bob, scene, actor, token };
}

test("owner can move their token, nobody else can", () => {
  const { world, alice, bob, scene, token } = setup();
  const [c] = world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x: 200, y: 300 }] }, alice);
  assert.equal(c.after!.x, 200);
  assert.throws(() => world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x: 0 }] }, bob), /permissão/);
  // Owners can move but not reveal/hide
  assert.throws(() => world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, hidden: true }] }, alice), /permissão/);
});

test("dot-path updates merge deeply", () => {
  const { world, alice, actor } = setup();
  world.apply({ op: "update", type: "Actor", updates: [{ _id: actor._id, system: { PV: { value: 10, max: 20 } } }] }, alice);
  world.apply({ op: "update", type: "Actor", updates: [{ _id: actor._id, "system.PV.value": 7 }] }, alice);
  assert.deepEqual((world.get("Actor", actor._id) as any).system.PV, { value: 7, max: 20 });
});

test("players can't create actors or forge chat authors", () => {
  const { world, gm, bob } = setup();
  assert.throws(() => world.apply({ op: "create", type: "Actor", data: [{ name: "x" }] }, bob), /permissão/);
  const [c] = world.apply({ op: "create", type: "ChatMessage", data: [{ content: "olá", author: gm._id, html: true }] }, bob);
  assert.equal(c.after!.author, bob._id);
  assert.equal(c.after!.html, false);
});

test("visibility: hidden tokens, unowned actors, whispers", () => {
  const { world, gm, alice, bob, scene, actor, token } = setup();
  world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, hidden: true }] }, gm);
  const t = world.get("Token", token._id)!;
  assert.equal(canSee("Token", t, alice, world), true, "owner still sees hidden token");
  assert.equal(canSee("Token", t, bob, world), false);
  assert.equal(canSee("Actor", actor, bob, world), false);
  const [msg] = world.createAsSystem("ChatMessage", [{ author: alice._id, content: "psst", whisper: [gm._id, alice._id] }]);
  assert.equal(canSee("ChatMessage", msg, bob, world), false);
  assert.equal(canSee("ChatMessage", msg, gm, world), true);
});

test("deleting a scene deletes its tokens; activating one deactivates others", () => {
  const { world, gm, scene, token } = setup();
  const [other] = world.createAsSystem("Scene", [{ name: "B", active: true }]);
  world.apply({ op: "update", type: "Scene", updates: [{ _id: scene._id, active: true }] }, gm);
  assert.equal((world.get("Scene", other._id) as any).active, false);
  const changes = world.apply({ op: "delete", type: "Scene", ids: [scene._id] }, gm);
  assert.ok(changes.some(c => c.type === "Token" && c.before?._id === token._id && !c.after));
  assert.equal(world.get("Token", token._id), undefined);
});

test("changes persist across reopen; passwords are hashed", () => {
  const { world, gm, alice } = setup();
  world.apply({ op: "update", type: "User", updates: [{ _id: alice._id, password: "segredo" }] }, gm);
  const id = world.meta.id;
  world.close();
  const again = World.open(id);
  const stored = again.get("User", alice._id) as UserDoc;
  assert.match(stored.passwordHash!, /^scrypt:/);
  assert.ok(!JSON.stringify(stored).includes("segredo"));
  again.close();
});

test("walls: players open/close doors but not locked or secret ones, and can't walk through walls", () => {
  const { world, gm, alice, scene, token } = setup();
  const [door, locked, solid] = world.createAsSystem("Wall", [
    { c: [0, 0, 0, 100], door: 1, ds: 0 },
    { c: [0, 0, 0, 100], door: 1, ds: 2 },
    { c: [300, 0, 300, 1000] }
  ], scene._id);
  world.apply({ op: "update", type: "Wall", parent: scene._id, updates: [{ _id: door._id, ds: 1 }] }, alice);
  assert.throws(() => world.apply({ op: "update", type: "Wall", parent: scene._id, updates: [{ _id: locked._id, ds: 1 }] }, alice), /permissão/);
  assert.throws(() => world.apply({ op: "update", type: "Wall", parent: scene._id, updates: [{ _id: door._id, c: [1, 1, 2, 2] }] }, alice), /permissão/);
  assert.throws(() => world.apply({ op: "update", type: "Wall", parent: scene._id, updates: [{ _id: door._id, ds: 2 }] }, alice), /permissão/);
  // token at (100,100) size 1 on 100px grid: centre (150,150). The wall at x=300 blocks moving to x=400.
  assert.throws(() => world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x: 400 }] }, alice), /parede/);
  world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x: 200 }] }, alice);
  world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x: 500 }] }, gm);
  void solid;
});

test("fog exploration is private, one per user per scene, and validated", async () => {
  const { world, alice, bob, scene } = setup();
  const img = "data:image/webp;base64,AAAA";
  const [c] = world.apply({ op: "create", type: "FogExploration", parent: scene._id, data: [{ explored: img, user: bob._id }] }, alice);
  assert.equal(c.after!.user, alice._id, "user is forced to the author");
  assert.throws(() => world.apply({ op: "create", type: "FogExploration", parent: scene._id, data: [{ explored: img }] }, alice), /existe/);
  assert.throws(() => world.apply({ op: "update", type: "FogExploration", parent: scene._id, updates: [{ _id: c.after!._id, explored: img }] }, bob), /permissão/);
  assert.throws(() => world.apply({ op: "create", type: "FogExploration", parent: scene._id, data: [{ explored: "javascript:alert(1)" }] }, bob), /formato/);
  assert.equal(canSee("FogExploration", c.after!, bob, world), false);
});

test("secret doors look like plain walls to players", async () => {
  const { publicDoc } = await import("./hub.ts");
  const { world, gm, alice, scene } = setup();
  const [secret] = world.createAsSystem("Wall", [{ c: [0, 0, 0, 100], door: 2 }], scene._id);
  assert.equal((publicDoc("Wall", secret, alice) as any).door, 0);
  assert.equal((publicDoc("Wall", secret, gm) as any).door, 2);
});

test("world items: GM only, hidden from players unless shared; owners edit token deltas", () => {
  const { world, gm, alice, scene, token } = setup();
  assert.throws(() => world.apply({ op: "create", type: "Item", data: [{ name: "Pistola" }] }, alice), /permissão/);
  const [c] = world.apply({ op: "create", type: "Item", data: [{ name: "Pistola", type: "armament" }] }, gm);
  assert.equal(c.after!._parent, undefined);
  assert.equal(canSee("Item", c.after!, alice, world), false);
  world.apply({ op: "update", type: "Item", updates: [{ _id: c.after!._id, "ownership.default": 1 }] }, gm);
  assert.equal(canSee("Item", world.get("Item", c.after!._id)!, alice, world), true);
  world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, "delta.system.PV.value": 3 }] }, alice);
  assert.equal((world.get("Token", token._id) as any).delta.system.PV.value, 3);
});

test("deleting a folder moves its contents up", () => {
  const { world, gm, actor } = setup();
  const [outer] = world.createAsSystem("Folder", [{ name: "NPCs", type: "Actor" }]);
  const [inner] = world.createAsSystem("Folder", [{ name: "Cultistas", type: "Actor", folder: outer._id }]);
  world.apply({ op: "update", type: "Actor", updates: [{ _id: actor._id, folder: inner._id }] }, gm);
  world.apply({ op: "delete", type: "Folder", ids: [inner._id] }, gm);
  assert.equal((world.get("Actor", actor._id) as any).folder, outer._id);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
