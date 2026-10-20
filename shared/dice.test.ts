import { test } from "node:test";
import assert from "node:assert/strict";
import { DiceError, opTestFormula, parseFormula, roll } from "./dice.ts";

/** Deterministic dice: returns the given values in order. */
const seq = (...values: number[]) => () => values.shift()!;

test("keep highest", () => {
  const r = roll("3d20kh+5", seq(4, 17, 9));
  assert.equal(r.total, 22);
  assert.equal(r.formula, "3d20kh+5");
  const dice = r.terms[0];
  assert.ok(dice.kind === "dice");
  assert.deepEqual(dice.results.map(x => x.kept), [false, true, false]);
});

test("keep lowest", () => {
  assert.equal(roll("2d20kl", seq(12, 3)).total, 3);
});

test("sums and negatives", () => {
  assert.equal(roll("1d6 + 1d4 - 2", seq(5, 3)).total, 6);
  assert.equal(roll("-1d4+10", seq(4)).total, 6);
});

test("default count and keep count", () => {
  assert.equal(roll("d20", seq(11)).total, 11);
  assert.equal(roll("4d6kh3", seq(1, 6, 4, 5)).total, 15);
});

test("rejects junk and abuse", () => {
  assert.throws(() => parseFormula(""), DiceError);
  assert.throws(() => parseFormula("2d20; drop table"), DiceError);
  assert.throws(() => parseFormula("1000d6"), DiceError);
  assert.throws(() => parseFormula("1d1"), DiceError);
  assert.throws(() => parseFormula("2d20+x"), DiceError);
  assert.throws(() => parseFormula("2d20++1"), DiceError);
  assert.throws(() => parseFormula("1d20+99999999999"), DiceError);
});

test("Ordem Paranormal test formula", () => {
  assert.equal(opTestFormula(3, 5), "3d20kh+5");
  assert.equal(opTestFormula(0, 0), "2d20kl");
  assert.equal(opTestFormula(2, -2), "2d20kh-2");
});
