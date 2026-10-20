import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-cards-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { runCardsAction, stackCards } = await import("./cards.ts");
const { publicDoc } = await import("./hub.ts");
const { canSee } = await import("../shared/permissions.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;
type CardsDoc = import("../shared/protocol.ts").CardsDoc;
type CardDoc = import("../shared/protocol.ts").CardDoc;

let n = 0;
const counter = () => ((n = (n % 7) + 1), n);

function setup() {
  const world = World.create({ id: `c${Math.random().toString(36).slice(2, 8)}`, title: "T", system: "ordemparanormal" });
  const [gm, alice] = world.createAsSystem("User", [{ name: "GM", role: "gm" }, { name: "Alice" }]) as UserDoc[];
  const [deck, hand, pile] = world.createAsSystem("Cards", [
    { name: "Baralho", type: "deck", ownership: { default: 1 } },
    { name: "Mão da Alice", type: "hand", ownership: { default: 0, [alice._id]: 3 } },
    { name: "Mesa", type: "pile", ownership: { default: 2 } }
  ]) as CardsDoc[];
  world.applyAsSystem({ op: "create", type: "Card", parent: deck._id, data: ["Ás", "Dois", "Três", "Quatro", "Cinco"].map((name, i) => ({ name, sort: (i + 1) * 1000, faces: [{ name, text: "", img: null }], face: 0 })) });
  const run = (u: UserDoc, a: Parameters<typeof runCardsAction>[2]) => runCardsAction(world, u, a, counter);
  const names = (id: string) => stackCards(world, id).map((c: CardDoc) => c.name);
  const cards = (id: string) => world.get("Cards", id) as CardsDoc;
  return { world, gm, alice, deck, hand, pile, run, names, cards };
}

test("dealing marks deck cards drawn and puts copies in the hand; counts follow", () => {
  const { world, gm, deck, hand, run, names, cards } = setup();
  assert.equal(cards(deck._id).available, 5);
  run(gm, { action: "deal", from: deck._id, to: [hand._id], number: 2 });
  assert.deepEqual(names(hand._id), ["Ás", "Dois"]);
  assert.equal(cards(deck._id).available, 3);
  assert.equal(cards(hand._id).available, 2);
  assert.equal(stackCards(world, deck._id).filter((c: CardDoc) => c.drawn).length, 2);
  assert.throws(() => run(gm, { action: "deal", from: deck._id, to: [hand._id], number: 9 }), /só tem 3/);
});

test("players draw into their hand, play to a pile, and cards go home on recall", () => {
  const { world, gm, alice, deck, hand, pile, run, names, cards } = setup();
  run(alice, { action: "draw", to: hand._id, from: deck._id, number: 1 });
  assert.deepEqual(names(hand._id), ["Ás"]);
  assert.throws(() => run(alice, { action: "draw", to: pile._id, from: deck._id, number: 1 }), /Sem permissão/, "only into stacks she owns");
  const [ace] = stackCards(world, hand._id);
  run(alice, { action: "pass", from: hand._id, to: pile._id, cardIds: [ace._id], kind: "play" });
  assert.deepEqual(names(pile._id), ["Ás"]);
  assert.deepEqual(names(hand._id), []);
  assert.match(world.all("ChatMessage").at(-1)!.content as string, /jogou Ás para Mesa/);

  // Recalling the pile returns the Ace to the deck; recalling the deck gathers everything.
  run(gm, { action: "recall", stack: pile._id });
  assert.equal(cards(deck._id).available, 5);
  run(gm, { action: "deal", from: deck._id, to: [hand._id, pile._id], number: 2 });
  assert.equal(cards(deck._id).available, 1);
  run(gm, { action: "recall", stack: deck._id });
  assert.equal(cards(deck._id).available, 5);
  assert.deepEqual(names(hand._id), []);
  assert.deepEqual(names(pile._id), []);
});

test("hands are private, deck order is secret, face-down cards hide their faces", () => {
  const { world, gm, alice, deck, hand, pile, run } = setup();
  const [inDeck] = stackCards(world, deck._id);
  assert.equal(canSee("Card", inDeck, alice, world), false, "LIMITED on the deck: can draw, can't look");
  run(gm, { action: "deal", from: deck._id, to: [pile._id], number: 1, faceDown: true });
  const [down] = stackCards(world, pile._id);
  assert.equal(canSee("Card", down, alice, world), true);
  const seen = publicDoc("Card", down, alice, world) as CardDoc;
  assert.equal(seen.faces.length, 0);
  assert.notEqual(seen.name, "Ás");
  run(gm, { action: "flip", stack: pile._id, cardId: down._id, face: 0 });
  assert.equal((publicDoc("Card", world.get("Card", down._id)!, alice, world) as CardDoc).name, "Ás");
  run(gm, { action: "deal", from: deck._id, to: [hand._id], number: 1 });
  const [mine] = stackCards(world, hand._id);
  const [bob] = world.createAsSystem("User", [{ name: "Bob" }]) as UserDoc[];
  assert.equal(canSee("Card", mine, bob, world), false, "someone else's hand");
  assert.throws(() => run(alice, { action: "shuffle", stack: deck._id }), /Sem permissão/);
});
