import { test } from "node:test";
import assert from "node:assert/strict";
import type { DieResult, RollTerm } from "./protocol.ts";
import { DiceError, opTestFormula, parseFormula, replaceFormulaData, roll } from "./dice.ts";

/** Deterministic dice: returns the given values in order (for d20 etc.: the face). */
const seq = (...values: number[]) => () => {
  if (!values.length) throw new Error("ran out of dice");
  return values.shift()!;
};
const dice = (t: RollTerm) => (t as { results: DieResult[] }).results;
const active = (t: RollTerm) => dice(t).map(r => r.active);

test("keep / drop highest and lowest", () => {
  const r = roll("3d20kh+5", seq(4, 17, 9));
  assert.equal(r.total, 22);
  assert.equal(r.formula, "3d20kh+5");
  assert.deepEqual(active(r.terms[0]), [false, true, false]);
  assert.equal(roll("2d20kl", seq(12, 3)).total, 3);
  assert.equal(roll("4d6kh3", seq(1, 6, 4, 5)).total, 15);
  assert.equal(roll("4d6dl", seq(1, 6, 4, 5)).total, 15);
  assert.equal(roll("4d6dh2", seq(1, 6, 4, 5)).total, 5);
  assert.equal(roll("4d6k2", seq(1, 6, 4, 5)).total, 11);
});

test("arithmetic: precedence, parentheses, unary signs, functions", () => {
  assert.equal(roll("1d6 + 1d4 - 2", seq(5, 3)).total, 6);
  assert.equal(roll("-1d4+10", seq(4)).total, 6);
  assert.equal(roll("2+3*4", seq()).total, 14);
  assert.equal(roll("(2+3)*4", seq()).total, 20);
  assert.equal(roll("10 % 4 + 7/2", seq()).total, 5.5);
  assert.equal(roll("floor(1d10/2)", seq(7)).total, 3);
  assert.equal(roll("max(1d20, 1d20) + min(3, 5)", seq(4, 15)).total, 18);
  assert.equal(roll("2d20++1", seq(1, 2)).total, 4);
  assert.equal(roll("d20", seq(11)).total, 11);
  assert.equal(roll("0.1+0.2", seq()).total, 0.3);
});

test("parenthesised count and faces", () => {
  const r = roll("(1d4)d6", seq(2, 3, 5));
  assert.equal(r.total, 8);
  assert.equal(r.terms.length, 2);
  assert.equal(roll("1d(2*3)", seq(6)).total, 6);
});

test("explode and explode once", () => {
  const r = roll("2d6x", seq(6, 2, 6, 1));
  assert.equal(r.total, 15);
  assert.deepEqual(dice(r.terms[0]).map(d => !!d.exploded), [true, false, true, false]);
  assert.equal(roll("1d6xo", seq(6, 6)).total, 12);
  assert.equal(roll("1d10x>8", seq(9, 10, 3)).total, 22);
  assert.equal(roll("3d6x1=6", seq(6, 6, 6, 6)).total, 24, "x1=6 explodes at most once in total");
  assert.throws(() => roll("1d6x>=1", seq(1)), DiceError);
});

test("reroll once and recursively", () => {
  const once = roll("1d20r1", seq(1, 1));
  assert.equal(once.total, 1);
  assert.deepEqual(dice(once.terms[0]).map(d => d.rerolled ?? false), [true, false]);
  assert.equal(roll("1d6rr<3", seq(1, 2, 5)).total, 5);
  assert.equal(roll("2d6r<3", seq(1, 4, 2)).total, 6);
});

test("successes, failures, margins, min/max, even/odd", () => {
  assert.equal(roll("6d10cs>=7", seq(7, 2, 10, 6, 8, 1)).total, 3);
  assert.equal(roll("4d6cs", seq(6, 6, 1, 3)).total, 2, "cs alone counts maximum faces");
  assert.equal(roll("4d6cf", seq(1, 6, 1, 3)).total, 2);
  assert.equal(roll("4d10cs>6df=1", seq(7, 1, 9, 3)).total, 1);
  assert.equal(roll("1d20ms>=10", seq(14)).total, 4);
  assert.equal(roll("3d6min3", seq(1, 5, 2)).total, 11);
  assert.equal(roll("3d6max4", seq(1, 6, 5)).total, 9);
  assert.equal(roll("4d6even", seq(2, 3, 4, 6)).total, 3);
});

test("fate dice, coins and pools", () => {
  // Fate: random(3) − 2 → 1→−1, 2→0, 3→+1.
  assert.equal(roll("4dF", seq(1, 3, 3, 2)).total, 1);
  assert.equal(roll("2dc", seq(2, 1)).total, 1);
  assert.equal(roll("3dcc1", seq(2, 2, 1)).total, 2);
  const pool = roll("{1d20, 1d12+2}kh", seq(5, 10));
  assert.equal(pool.total, 12);
  assert.equal(pool.terms.at(-1)!.kind, "pool");
  assert.equal(roll("{1d6, 1d6, 1d6}cs>=4", seq(4, 2, 6)).total, 2);
});

test("flavour text", () => {
  const r = roll("1d8[fogo] + 2[força]", seq(5));
  assert.equal(r.total, 7);
  assert.equal((r.terms[0] as { flavor?: string | null }).flavor, "fogo");
  assert.equal((r.terms[0] as { formula: string }).formula, "1d8");
});

test("rejects junk and abuse", () => {
  for (const bad of ["", "2d20; drop table", "1000d6", "1d1", "2d20+x", "1d20+99999999999", "1d20qq", "(1d6", "evil(1)", "1/0"]) {
    assert.throws(() => roll(bad, () => 1), DiceError, bad);
  }
  assert.throws(() => roll("100d6x", () => 6), DiceError, "too many dice from explosions");
  assert.doesNotThrow(() => parseFormula("2d20kh + 1d4[bónus]"));
});

test("@data replacement", () => {
  const { formula, missing } = replaceFormulaData("1d20+@agilidade+@pericias.luta-@nada", { agilidade: 3, pericias: { luta: { value: -2 } } });
  assert.equal(formula, "1d20+3+(-2)-0");
  assert.deepEqual(missing, ["nada"]);
});

test("Ordem Paranormal test formula", () => {
  assert.equal(opTestFormula(3, 5), "3d20kh+5");
  assert.equal(opTestFormula(0, 0), "2d20kl");
  assert.equal(opTestFormula(2, -2), "2d20kh-2");
});
