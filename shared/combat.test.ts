import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRoundState, nextTurnState, previousTurnState, startState, turnOrder } from "./combat.ts";
import type { CombatDoc, CombatantDoc } from "./protocol.ts";

const c = (id: string, initiative: number | null, defeated = false): CombatantDoc =>
  ({ _id: id, name: id, actorId: null, tokenId: null, img: null, initiative, hidden: false, defeated });
const combat = (round: number, current: string | null): CombatDoc => ({ _id: "c", sceneId: null, round, current, skipDefeated: true, sort: 0 });

const list = [c("a", 12), c("b", 20), c("x", null), c("d", 15, true), c("e", 15)];

test("turn order: initiative desc, unset last, ties by name", () => {
  assert.deepEqual(turnOrder(list).map(x => x._id), ["b", "d", "e", "a", "x"]);
});

test("start and advance, skipping defeated and wrapping rounds", () => {
  let s = startState(combat(0, null), list);
  assert.deepEqual(s, { round: 1, current: "b" });
  s = nextTurnState(combat(s.round, s.current), list);
  assert.equal(s.current, "e", "d is defeated");
  s = nextTurnState(combat(s.round, s.current), list);
  s = nextTurnState(combat(s.round, s.current), list);
  assert.equal(s.current, "x");
  s = nextTurnState(combat(s.round, s.current), list);
  assert.deepEqual(s, { round: 2, current: "b" });
});

test("going back crosses into the previous round but not before round 1", () => {
  assert.deepEqual(previousTurnState(combat(2, "b"), list), { round: 1, current: "x" });
  assert.deepEqual(previousTurnState(combat(1, "b"), list), { round: 1, current: "b" });
  assert.deepEqual(previousTurnState(combat(1, "e"), list), { round: 1, current: "b" });
});

test("current is tracked by id, so re-sorting doesn't change whose turn it is", () => {
  const changed = list.map(x => (x._id === "a" ? { ...x, initiative: 30 } : x));
  assert.equal(nextTurnState(combat(1, "e"), changed).current, "x", "a moved ahead of e, so after e comes x");
  assert.deepEqual(nextRoundState(combat(1, "e"), changed), { round: 2, current: "a" });
});
