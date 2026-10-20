import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-journal-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { publicDoc, stripSecrets } = await import("./hub.ts");
const { canSee } = await import("../shared/permissions.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;
type JournalEntryPageDoc = import("../shared/protocol.ts").JournalEntryPageDoc;

function setup() {
  const id = `j${Math.random().toString(36).slice(2, 8)}`;
  const world = World.create({ id, title: "T", system: "ordemparanormal" });
  const [gm, alice, bob] = world.createAsSystem("User", [{ name: "GM", role: "gm" }, { name: "Alice" }, { name: "Bob" }]) as UserDoc[];
  return { id, world, gm, alice, bob };
}

test("old entries get their text as a first page when the world opens", () => {
  const { id, world } = setup();
  const [entry] = world.createAsSystem("JournalEntry", [{ name: "Antigo", content: "<p>olá</p>" }]);
  world.close();
  const again = World.open(id);
  const pages = again.all<JournalEntryPageDoc>("JournalEntryPage").filter(p => p._parent === entry._id);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].text.content, "<p>olá</p>");
  assert.equal(again.get("JournalEntry", entry._id)!.content, "");
  again.close();
});

test("pages inherit the entry's ownership unless set; secrets reach only owners", () => {
  const { world, alice, bob } = setup();
  const [entry] = world.createAsSystem("JournalEntry", [{ name: "Caso", ownership: { default: 0, [alice._id]: 2, [bob._id]: 3 } }]);
  const [open, hidden] = world.createAsSystem("JournalEntryPage", [
    { name: "Resumo", text: { content: '<p>público</p><section class="secret"><p>o culpado é o padre</p></section><section class="secret revealed"><p>já revelado</p></section>', markdown: "", format: 1 } },
    { name: "Notas do mestre", ownership: { default: 0 } }
  ], entry._id) as JournalEntryPageDoc[];
  assert.equal(canSee("JournalEntryPage", open, alice, world), true);
  assert.equal(canSee("JournalEntryPage", hidden, alice, world), false);
  const seen = publicDoc("JournalEntryPage", open, alice, world) as JournalEntryPageDoc;
  assert.ok(!seen.text.content.includes("padre"));
  assert.ok(seen.text.content.includes("já revelado"));
  assert.ok((publicDoc("JournalEntryPage", open, bob, world) as JournalEntryPageDoc).text.content.includes("padre"), "owners keep secrets");

  // Owners edit pages and the entry, but not who owns it; observers can't edit.
  world.apply({ op: "update", type: "JournalEntryPage", parent: entry._id, updates: [{ _id: open._id, name: "Resumo v2" }] }, bob);
  assert.throws(() => world.apply({ op: "update", type: "JournalEntryPage", parent: entry._id, updates: [{ _id: open._id, name: "x" }] }, alice), /Sem permissão/);
  assert.throws(() => world.apply({ op: "update", type: "JournalEntry", updates: [{ _id: entry._id, ownership: { default: 3 } }] }, bob), /Sem permissão/);
  world.apply({ op: "create", type: "JournalEntryPage", parent: entry._id, data: [{ name: "Nova", type: "image", src: "/assets/x.png" }] }, bob);
});

test("secret stripping leaves ordinary sections alone", () => {
  assert.equal(stripSecrets('<section class="intro">a</section><section class="secret">b</section>'), '<section class="intro">a</section>');
});
