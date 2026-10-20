import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-chat-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { publicDoc } = await import("./hub.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;
type ChatMessageDoc = import("../shared/protocol.ts").ChatMessageDoc;

function setup() {
  const world = World.create({ id: `c${Math.random().toString(36).slice(2, 8)}`, title: "T", system: "ordemparanormal" });
  const [gm, alice] = world.createAsSystem("User", [{ name: "GM", role: "gm" }, { name: "Alice" }]) as UserDoc[];
  return { world, gm, alice };
}

test("[[inline]] rolls are rolled by the server, whatever the client sends", () => {
  const { world, alice } = setup();
  const [c] = world.apply({ op: "create", type: "ChatMessage", data: [{ content: "Dano [[2d6+3]] e [[/r 1d4]]", inline: [{ formula: "1", total: 999, terms: [] }] }] }, alice);
  const m = c.after as ChatMessageDoc;
  assert.equal(m.inline.length, 2);
  assert.ok(m.inline[0].total >= 5 && m.inline[0].total <= 15);
  assert.equal(m.inline[1].formula, "1d4");
  assert.throws(() => world.apply({ op: "create", type: "ChatMessage", data: [{ content: "[[1d20qq]]" }] }, alice), /Rolagem no texto/);
});

test("blind rolls hide the result from non-GMs, the roller included", () => {
  const { world, gm, alice } = setup();
  const [msg] = world.createAsSystem("ChatMessage", [{ author: alice._id, content: "", roll: { formula: "1d20", total: 17, terms: [] }, whisper: [gm._id, alice._id], blind: true }]);
  assert.equal((publicDoc("ChatMessage", msg, alice) as ChatMessageDoc).roll, null);
  assert.equal((publicDoc("ChatMessage", msg, gm) as ChatMessageDoc).roll?.total, 17);
  // Players can't mark their own messages blind (or smuggle a roll in).
  const [c] = world.apply({ op: "create", type: "ChatMessage", data: [{ content: "olá", blind: true, roll: { formula: "1d20", total: 20, terms: [] } }] }, alice);
  assert.equal((c.after as ChatMessageDoc).blind, false);
  assert.equal((c.after as ChatMessageDoc).roll, null);
});
