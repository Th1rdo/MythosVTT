import type { RollResult, RollTerm } from "./protocol.ts";

/**
 * Dice formulas: sums of dice and numbers.
 *   2d20kh      roll two d20, keep the highest
 *   3d20kh1+5   keep highest 1, add 5
 *   2d20kl      keep lowest
 *   1d6+1d4-1
 *   d20         (count defaults to 1)
 */
const TERM = /^([+-])?\s*(?:(\d*)d(\d+)(?:(kh|kl)(\d*))?|(\d+))/i;

export const MAX_DICE = 100;
export const MAX_FACES = 1000;
export const MAX_NUMBER = 1_000_000;

export class DiceError extends Error {}

export type RandomInt = (faces: number) => number;

export function parseFormula(formula: string): RollTerm[] {
  if (formula.length > 200) throw new DiceError("Fórmula demasiado longa");
  let rest = formula.replace(/\s+/g, "");
  if (!rest) throw new DiceError("Fórmula vazia");
  const terms: RollTerm[] = [];
  let first = true;
  while (rest.length) {
    const m = TERM.exec(rest);
    if (!m || (!first && !m[1])) throw new DiceError(`Não percebi a fórmula: "${formula}"`);
    const sign = m[1] === "-" ? -1 : 1;
    if (m[6] !== undefined) {
      const value = Number(m[6]);
      if (value > MAX_NUMBER) throw new DiceError(`Número demasiado grande: ${m[6]}`);
      terms.push({ kind: "number", value, sign });
    } else {
      const count = m[2] === "" ? 1 : Number(m[2]);
      const faces = Number(m[3]);
      if (count < 1 || count > MAX_DICE) throw new DiceError(`Número de dados inválido (1–${MAX_DICE})`);
      if (faces < 2 || faces > MAX_FACES) throw new DiceError(`Dado inválido: d${faces}`);
      const keep = m[4]?.toLowerCase() === "kh" ? "high" : m[4]?.toLowerCase() === "kl" ? "low" : "all";
      const keepCount = keep === "all" ? count : Math.min(count, m[5] ? Number(m[5]) : 1);
      terms.push({ kind: "dice", count, faces, keep, keepCount, results: [], sign });
    }
    rest = rest.slice(m[0].length);
    first = false;
  }
  return terms;
}

export function roll(formula: string, randomInt: RandomInt): RollResult {
  const terms = parseFormula(formula);
  let total = 0;
  for (const t of terms) {
    if (t.kind === "number") {
      total += t.sign * t.value;
      continue;
    }
    const values = Array.from({ length: t.count }, () => randomInt(t.faces));
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => t.keep === "low" ? a[0] - b[0] : b[0] - a[0]);
    const keptIdx = new Set(order.slice(0, t.keepCount).map(([, i]) => i));
    t.results = values.map((value, i) => ({ value, kept: keptIdx.has(i) }));
    total += t.sign * t.results.filter(r => r.kept).reduce((s, r) => s + r.value, 0);
  }
  return { formula: formatTerms(terms), total, terms };
}

export function formatTerms(terms: RollTerm[]): string {
  return terms.map((t, i) => {
    const sign = t.sign < 0 ? "-" : i === 0 ? "" : "+";
    if (t.kind === "number") return sign + t.value;
    const keep = t.keep === "all" ? "" : (t.keep === "high" ? "kh" : "kl") + (t.keepCount === 1 ? "" : t.keepCount);
    return `${sign}${t.count}d${t.faces}${keep}`;
  }).join("");
}

/**
 * Ordem Paranormal test: roll one d20 per point in the attribute and keep the highest.
 * With 0 in the attribute you roll 2d20 and keep the lowest.
 */
export function opTestFormula(attribute: number, bonus: number): string {
  const dice = attribute > 0 ? `${attribute}d20kh` : "2d20kl";
  return bonus ? `${dice}${bonus > 0 ? "+" : ""}${bonus}` : dice;
}
