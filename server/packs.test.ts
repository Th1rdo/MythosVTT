import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-packs-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { runPackAction } = await import("./packs.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;
type PackIndexEntry = import("../shared/protocol.ts").PackIndexEntry;
type PackEntry = import("../shared/protocol.ts").PackEntry;
type BaseDoc = import("../shared/protocol.ts").BaseDoc;

function setup() {
  const world = World.create({ id: `p${Math.random().toString(36).slice(2, 8)}`, title: "T", system: "ordemparanormal" });
  const [gm, alice] = world.createAsSystem("User", [{ name: "GM", role: "gm" }, { name: "Alice" }]) as UserDoc[];
  const [actor] = world.createAsSystem("Actor", [{ name: "Cultista", type: "threat" }]);
  world.createAsSystem("Item", [{ name: "Faca", type: "armament" }, { name: "Corrente", type: "armament" }], actor._id);
  const [mine] = world.createAsSystem("Actor", [{ name: "Omar", ownership: { default: 0, [alice._id]: 3 } }]);
  const run = (user: UserDoc, a: Parameters<typeof runPackAction>[2]) => runPackAction(world, user, a);
  return { world, gm, alice, actor, mine, run };
}

test("export an actor with its items, import it back with fresh ids", () => {
  const { world, gm, actor, run } = setup();
  const [pack] = world.createAsSystem("Compendium", [{ name: "Ameaças", type: "Actor" }]);
  run(gm, { action: "export", packId: pack._id, docs: [{ type: "Actor", id: actor._id }] });
  const index = run(gm, { action: "index", packId: pack._id }).result as PackIndexEntry[];
  assert.deepEqual(index.map(e => [e.name, e.subtype]), [["Cultista", "threat"]]);
  const entry = run(gm, { action: "get", packId: pack._id, entryId: index[0]._id }).result as PackEntry;
  assert.equal(entry.docs.Item?.length, 2);

  const { changes } = run(gm, { action: "import", packId: pack._id, entryIds: [index[0]._id] });
  const copy = changes.find(c => c.type === "Actor")!.after!;
  assert.notEqual(copy._id, actor._id);
  assert.deepEqual(world.all("Item").filter((i: BaseDoc) => i._parent === copy._id).map((i: BaseDoc) => i.name).sort(), ["Corrente", "Faca"]);
});

test("players browse visible packs and take items into their own actor only", () => {
  const { world, gm, alice, actor, mine, run } = setup();
  const [pack] = world.createAsSystem("Compendium", [{ name: "Armas", type: "Item" }]);
  const [world_item] = world.createAsSystem("Item", [{ name: "Revólver", type: "armament" }]);
  run(gm, { action: "export", packId: pack._id, docs: [{ type: "Item", id: world_item._id }] });
  assert.throws(() => run(alice, { action: "index", packId: pack._id }), /Sem permissão/);
  world.apply({ op: "update", type: "Compendium", updates: [{ _id: pack._id, visibility: 1 }] }, gm);
  const [e] = run(alice, { action: "index", packId: pack._id }).result as PackIndexEntry[];
  run(alice, { action: "importToActor", packId: pack._id, entryId: e._id, actorId: mine._id });
  assert.ok(world.all("Item").some((i: BaseDoc) => i._parent === mine._id && i.name === "Revólver"));
  assert.throws(() => run(alice, { action: "importToActor", packId: pack._id, entryId: e._id, actorId: actor._id }), /Sem permissão/);
  assert.throws(() => run(alice, { action: "import", packId: pack._id, entryIds: [e._id] }), /Sem permissão/);
  assert.throws(() => run(alice, { action: "delete", packId: pack._id, entryIds: [e._id] }), /Sem permissão/);

  world.apply({ op: "update", type: "Compendium", updates: [{ _id: pack._id, locked: true }] }, gm);
  assert.throws(() => run(gm, { action: "delete", packId: pack._id, entryIds: [e._id] }), /trancado/);
  world.apply({ op: "delete", type: "Compendium", ids: [pack._id] }, gm);
  assert.equal(world.packs.packCount(pack._id), 0, "deleting the pack deletes its entries");
});

test("adventures bundle folders and keep ids on import", () => {
  const { world, gm, run } = setup();
  const [folder] = world.createAsSystem("Folder", [{ name: "Caso 1", type: "JournalEntry" }]);
  const [entry] = world.createAsSystem("JournalEntry", [{ name: "Briefing", folder: folder._id }]);
  world.createAsSystem("JournalEntryPage", [{ name: "Página 1" }], entry._id);
  const [scene] = world.createAsSystem("Scene", [{ name: "Armazém" }]);
  world.createAsSystem("Wall", [{ c: [0, 0, 100, 0] }], scene._id);
  const [pack] = world.createAsSystem("Compendium", [{ name: "Aventuras", type: "Adventure" }]);
  run(gm, { action: "exportAdventure", packId: pack._id, name: "Caso 1", folders: [folder._id], docs: [{ type: "Scene", id: scene._id }] });
  const [adv] = run(gm, { action: "index", packId: pack._id }).result as PackIndexEntry[];

  // Delete the originals, then import: same ids come back, children included.
  world.apply({ op: "delete", type: "JournalEntry", ids: [entry._id] }, gm);
  world.apply({ op: "delete", type: "Scene", ids: [scene._id] }, gm);
  run(gm, { action: "import", packId: pack._id, entryIds: [adv._id] });
  assert.equal(world.get("JournalEntry", entry._id)?.name, "Briefing");
  assert.equal(world.all("JournalEntryPage").filter((p: BaseDoc) => p._parent === entry._id).length, 1);
  assert.equal(world.all("Wall").filter((w: BaseDoc) => w._parent === scene._id).length, 1);

  // Importing again without overwrite leaves existing documents alone; with overwrite replaces them.
  world.apply({ op: "update", type: "JournalEntry", updates: [{ _id: entry._id, name: "Mudado" }] }, gm);
  run(gm, { action: "import", packId: pack._id, entryIds: [adv._id] });
  assert.equal(world.get("JournalEntry", entry._id)?.name, "Mudado");
  run(gm, { action: "import", packId: pack._id, entryIds: [adv._id], overwrite: true });
  assert.equal(world.get("JournalEntry", entry._id)?.name, "Briefing");
});

test("import reports how many documents it created", () => {
  const { world, gm, run } = setup();
  const [pack] = world.createAsSystem("Compendium", [{ name: "Armas", type: "Item" }]);
  const [a, b] = world.createAsSystem("Item", [{ name: "A", type: "armament" }, { name: "B", type: "armament" }]);
  run(gm, { action: "export", packId: pack._id, docs: [{ type: "Item", id: a._id }, { type: "Item", id: b._id }] });
  const ids = (run(gm, { action: "index", packId: pack._id }).result as PackIndexEntry[]).map(e => e._id);
  assert.equal(run(gm, { action: "import", packId: pack._id, entryIds: ids }).result, 2);
});
