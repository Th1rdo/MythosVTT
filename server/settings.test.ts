import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-settings-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { worldSetting, userSetting } = await import("../shared/settings.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;
type ChatMessageDoc = import("../shared/protocol.ts").ChatMessageDoc;

function setup() {
  const world = World.create({ id: `s${Math.random().toString(36).slice(2, 8)}`, title: "T", system: "ordemparanormal" });
  const [gm, alice, bob] = world.createAsSystem("User", [{ name: "GM", role: "gm" }, { name: "Alice" }, { name: "Bob" }]) as UserDoc[];
  const [scene] = world.createAsSystem("Scene", [{ name: "S" }]);
  const set = (key: string, value: unknown) => world.apply({ op: "create", type: "Setting", data: [{ key, value }] }, gm);
  return { world, gm, alice, bob, scene, set };
}

test("world settings: defaults, validation, GM only", () => {
  const { world, alice, set } = setup();
  assert.equal(worldSetting(world, "core.playerDrawings"), true);
  assert.throws(() => set("core.nope", 1), /desconhecida/);
  assert.throws(() => set("core.playerDrawings", "sim"), /sim\/não/);
  assert.throws(() => set("core.gridDiagonals", "hexagonal"), /opção inválida/);
  assert.throws(() => world.apply({ op: "create", type: "Setting", data: [{ key: "core.playerUpload", value: true }] }, alice), /Sem permissão/);
  set("core.gridDiagonals", "alternating");
  assert.equal(worldSetting(world, "core.gridDiagonals"), "alternating");
});

test("player permissions follow the settings", () => {
  const { world, alice, scene, set } = setup();
  world.apply({ op: "create", type: "Drawing", parent: scene._id, data: [{}] }, alice);
  set("core.playerDrawings", false);
  assert.throws(() => world.apply({ op: "create", type: "Drawing", parent: scene._id, data: [{}] }, alice), /desligou os desenhos/);

  const [m] = world.apply({ op: "create", type: "Macro", data: [{ name: "x", type: "script", command: "1" }] }, alice).map(c => c.after!);
  set("core.playerMacroScript", false);
  assert.throws(() => world.apply({ op: "create", type: "Macro", data: [{ name: "y", type: "script" }] }, alice), /script/);
  assert.throws(() => world.apply({ op: "update", type: "Macro", updates: [{ _id: m._id, command: "2" }] }, alice), /script/);
  world.apply({ op: "update", type: "Macro", updates: [{ _id: m._id, name: "renamed" }] }, alice);
  world.apply({ op: "create", type: "Macro", data: [{ name: "chat ok", type: "chat", command: "olá" }] }, alice);

  set("core.playerTemplates", false);
  assert.throws(() => world.apply({ op: "create", type: "Region", parent: scene._id, data: [{ shapes: [{ type: "circle", x: 0, y: 0, radius: 10 }] }] }, alice), /modelos/);
});

test("whispers reach real users, include the author, and can be turned off for players", () => {
  const { world, alice, bob, set } = setup();
  const [c] = world.apply({ op: "create", type: "ChatMessage", data: [{ content: "psst", whisper: [bob._id, "nobody"] }] }, alice);
  assert.deepEqual((c.after as ChatMessageDoc).whisper, [bob._id, alice._id]);
  assert.throws(() => world.apply({ op: "create", type: "ChatMessage", data: [{ content: "?", whisper: ["nobody"] }] }, alice), /ninguém/);
  set("core.playerWhisper", false);
  assert.throws(() => world.apply({ op: "create", type: "ChatMessage", data: [{ content: "psst", whisper: [bob._id] }] }, alice), /sussurros/);
});

test("user settings live on the user and are validated", () => {
  const { world, alice } = setup();
  assert.equal(userSetting(world.get("User", alice._id) as UserDoc, "core.rollMode"), "public");
  world.apply({ op: "update", type: "User", updates: [{ _id: alice._id, "settings.core:rollMode": "gm" }] }, alice);
  assert.equal(userSetting(world.get("User", alice._id) as UserDoc, "core.rollMode"), "gm");
  assert.throws(() => world.apply({ op: "update", type: "User", updates: [{ _id: alice._id, settings: { "core:rollMode": "loud" } }] }, alice), /opção inválida/);
  assert.throws(() => world.apply({ op: "update", type: "User", updates: [{ _id: alice._id, settings: { "core:playerUpload": true } }] }, alice), /desconhecida/);
});

test("pause: players can't move tokens; a region can pause the game; players set their own character", async () => {
  const { world, gm, alice, scene, set } = setup();
  const { processRegionEvents } = await import("./regions.ts");
  const [actor] = world.createAsSystem("Actor", [{ name: "Omar", ownership: { default: 0, [alice._id]: 3 } }]);
  const [other] = world.createAsSystem("Actor", [{ name: "Cultista" }]);
  const [token] = world.createAsSystem("Token", [{ actorId: actor._id, x: 0, y: 0 }], scene._id);
  set("core.paused", true);
  assert.throws(() => world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x: 100 }] }, alice), /pausa/);
  world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x: 100 }] }, gm);
  world.setWorldSetting("core.paused", false);

  world.createAsSystem("Region", [{ name: "Alarme", shapes: [{ type: "rectangle", x: 300, y: 0, width: 300, height: 300 }],
    behaviors: [{ _id: "p1", name: "", disabled: false, type: "pauseGame", system: { onlyPlayers: true } }] }], scene._id);
  const changes = world.apply({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x: 400 }] }, alice);
  processRegionEvents(world, changes, alice._id);
  assert.equal(worldSetting(world, "core.paused"), true);

  world.apply({ op: "update", type: "User", updates: [{ _id: alice._id, character: actor._id, pronouns: "ela", avatar: "/assets/a.png" }] }, alice);
  assert.throws(() => world.apply({ op: "update", type: "User", updates: [{ _id: alice._id, character: other._id }] }, alice), /personagem tua/);
});
