import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEffects, barValue, isExpired, tokenActor } from "./actors.ts";
import type { ActorDoc, BaseDoc, DocType, EffectData, TokenDoc } from "./protocol.ts";

const actor = {
  _id: "a", name: "Omar", type: "agent", img: null, ownership: { default: 0 }, folder: null,
  system: { PV: { value: 10, max: 20 }, defense: { value: 12 }, attributes: { dex: { value: 2 } } }
} as unknown as ActorDoc;

const effect = (changes: EffectData["changes"], extra: Partial<EffectData> = {}): EffectData =>
  ({ _id: Math.random().toString(36), name: "e", icon: "✨", disabled: false, statuses: [], changes, duration: { rounds: null, startRound: null, combat: null }, description: "", ...extra });

test("effect changes apply in Foundry's order and don't touch the source", () => {
  const d = applyEffects(actor, [
    effect([{ key: "system.defense.value", type: "add", value: "-5" }]),
    effect([{ key: "system.defense.value", type: "multiply", value: "2" }]),
    effect([{ key: "system.attributes.dex.value", type: "upgrade", value: "3" }]),
    effect([{ key: "system.PV.max", type: "override", value: "30" }], { disabled: true })
  ]);
  assert.equal(d.system.defense.value, 19, "multiply (×2 = 24) before add (−5)");
  assert.equal(d.system.attributes.dex.value, 3);
  assert.equal(d.system.PV.max, 20, "disabled effects do nothing");
  assert.equal(actor.system.defense.value, 12);
});

function lookup(docs: Partial<Record<DocType, BaseDoc[]>>) {
  return {
    get: (t: DocType, id: string) => docs[t]?.find(d => d._id === id),
    all: (t: DocType) => docs[t] ?? []
  };
}

test("unlinked tokens overlay their delta; linked tokens are the actor", () => {
  const base = { ...actor };
  const ae = { _id: "e1", _parent: "a", ...effect([{ key: "system.defense.value", type: "add", value: "1" }], { statuses: ["abalado"] }) };
  const docs = lookup({ Actor: [base], ActiveEffect: [ae] });
  const tok = (extra: Partial<TokenDoc>) => ({ _id: "t", actorId: "a", actorLink: false, delta: {}, ...extra } as unknown as TokenDoc);

  const unlinked = tokenActor(tok({ delta: { name: "Omar (cópia)", system: { PV: { value: 3 } }, effects: [effect([], { statuses: ["caido"] })] } }), docs)!;
  assert.equal(unlinked.source.name, "Omar (cópia)");
  assert.deepEqual(unlinked.source.system.PV, { value: 3, max: 20 });
  assert.deepEqual([...unlinked.statuses].sort(), ["abalado", "caido"]);
  assert.equal(unlinked.derived.system.defense.value, 13);

  const linked = tokenActor(tok({ actorLink: true, delta: { system: { PV: { value: 1 } } } }), docs)!;
  assert.equal(linked.source.system.PV.value, 10, "delta ignored when linked");
});

test("bars and expiry", () => {
  assert.deepEqual(barValue(actor, "PV"), { value: 10, max: 20 });
  assert.equal(barValue(actor, "nope"), null);
  const e = effect([], { duration: { rounds: 2, startRound: 3, combat: "c" } });
  assert.equal(isExpired(e, "c", 4), false);
  assert.equal(isExpired(e, "c", 5), true);
  assert.equal(isExpired(e, "other", 9), false);
});
