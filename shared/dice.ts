import type { DieResult, RollResult, RollTerm } from "./protocol.ts";

/**
 * Dice formulas, rolled on the server. The syntax follows Foundry's so imported formulas and players'
 * habits carry over:
 *
 *   2d20kh+5          keep highest (kh/kl/k N, drop dh/dl/d N)
 *   4d6dl             drop the lowest
 *   1d10x  1d10xo     explode on max (or x>8, x=1…); xo explodes once
 *   1d20r1  1d6rr<3   reroll once / until it stops matching
 *   6d10cs>=7         count successes (cf failures, df/sf deduct/subtract failures, ms margin of success)
 *   1d20min5 3d6max4  floor/ceiling each die; even / odd count even or odd results
 *   4dF  1dc          fate dice (−1/0/+1) and coins (0/1, "c1" calls heads)
 *   (1d4+1)d6         parenthesised counts and faces
 *   {1d20, 1d12+2}kh  pools: keep/drop/count over whole sub-formulas
 *   floor(1d10/2)     functions: abs ceil floor round trunc sign sqrt cbrt min max pow exp log clamp
 *   2d6 * 3 % 5       + − * / % and parentheses, usual precedence
 *   1d8[fogo]         flavour text in brackets
 *
 * Everything here is original code; Foundry was only studied for behaviour (REA evidence in the vault).
 */

export const MAX_DICE = 100;
export const MAX_FACES = 1000;
export const MAX_NUMBER = 1_000_000;
/** Dice rolled in one formula, explosions and rerolls included. */
export const MAX_RESULTS = 1000;
const MAX_LENGTH = 400;

export class DiceError extends Error {}

/** A fair integer in 1..faces. */
export type RandomInt = (faces: number) => number;

type Cmp = "=" | "<" | "<=" | ">" | ">=";

type Node =
  | { t: "num"; value: number; flavor: string | null }
  | { t: "dice"; count: Node | null; faces: Node | "f" | "c"; mods: string; flavor: string | null; text: string }
  | { t: "pool"; items: Node[]; mods: string; flavor: string | null; text: string }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "%"; a: Node; b: Node }
  | { t: "neg"; a: Node }
  | { t: "paren"; a: Node; flavor: string | null }
  | { t: "fn"; name: string; args: Node[]; flavor: string | null };

const FUNCTIONS: Record<string, (...n: number[]) => number> = {
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc, sign: Math.sign,
  sqrt: Math.sqrt, cbrt: Math.cbrt, exp: Math.exp, log: Math.log, log2: Math.log2, log10: Math.log10,
  pow: Math.pow, min: Math.min, max: Math.max,
  clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi)
};

// ---------------------------------------------------------------------------
// Parsing: a small recursive-descent parser over the formula text.

class Parser {
  #s: string;
  #i = 0;

  constructor(src: string) {
    this.#s = src;
  }

  parse(): Node {
    this.#ws();
    if (this.#i >= this.#s.length) throw new DiceError("Fórmula vazia");
    const n = this.#additive();
    this.#ws();
    if (this.#i < this.#s.length) this.#fail();
    return n;
  }

  #fail(): never {
    const near = this.#s.slice(this.#i, this.#i + 12);
    throw new DiceError(near ? `Não percebi a fórmula perto de "${near}"` : "A fórmula acaba a meio");
  }

  #ws(): void {
    while (this.#s[this.#i] === " " || this.#s[this.#i] === "\t") this.#i++;
  }

  #peek(): string {
    this.#ws();
    return this.#s[this.#i] ?? "";
  }

  #eat(ch: string): boolean {
    if (this.#peek() !== ch) return false;
    this.#i++;
    return true;
  }

  #additive(): Node {
    let a = this.#multiplicative();
    for (let c = this.#peek(); c === "+" || c === "-"; c = this.#peek()) {
      this.#i++;
      a = { t: "bin", op: c, a, b: this.#multiplicative() };
    }
    return a;
  }

  #multiplicative(): Node {
    let a = this.#unary();
    for (let c = this.#peek(); c === "*" || c === "/" || c === "%"; c = this.#peek()) {
      this.#i++;
      a = { t: "bin", op: c, a, b: this.#unary() };
    }
    return a;
  }

  #unary(): Node {
    if (this.#eat("-")) return { t: "neg", a: this.#unary() };
    if (this.#eat("+")) return this.#unary();
    return this.#primary();
  }

  #primary(): Node {
    const start = (this.#ws(), this.#i);
    const c = this.#peek();
    let count: Node | null = null;

    if (c === "(") {
      this.#i++;
      const a = this.#additive();
      if (!this.#eat(")")) this.#fail();
      // "(1d4)d6": a parenthesised count.
      if (/[dD]/.test(this.#s[this.#i] ?? "")) count = { t: "paren", a, flavor: null };
      else return { t: "paren", a, flavor: this.#flavor() };
    } else if (c === "{") {
      this.#i++;
      const items = [this.#additive()];
      while (this.#eat(",")) items.push(this.#additive());
      if (!this.#eat("}")) this.#fail();
      const mods = this.#modifiers();
      return { t: "pool", items, mods, flavor: this.#flavor(), text: this.#s.slice(start, this.#i).trim() };
    } else if (/[a-z]/i.test(c) && !/^[dD](\d|\(|[fFcC](?![a-z]))/.test(this.#s.slice(this.#i))) {
      const name = /^[a-z][a-z0-9]*/i.exec(this.#s.slice(this.#i))![0];
      this.#i += name.length;
      if (!this.#eat("(")) throw new DiceError(`Não conheço "${name}" (dados: 1d20; funções: floor(…), max(…)…)`);
      const fn = name.toLowerCase();
      if (!FUNCTIONS[fn]) throw new DiceError(`Função desconhecida: ${name}`);
      const args: Node[] = [];
      if (!this.#eat(")")) {
        args.push(this.#additive());
        while (this.#eat(",")) args.push(this.#additive());
        if (!this.#eat(")")) this.#fail();
      }
      return { t: "fn", name: fn, args, flavor: this.#flavor() };
    } else if (/\d/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(this.#s.slice(this.#i))!;
      this.#i += m[0].length;
      const value = Number(m[0]);
      if (value > MAX_NUMBER) throw new DiceError(`Número demasiado grande: ${m[0]}`);
      if (!/[dD]/.test(this.#s[this.#i] ?? "") || m[1]) return { t: "num", value, flavor: this.#flavor() };
      count = { t: "num", value, flavor: null };
    } else if (!/[dD]/.test(c)) {
      this.#fail();
    }

    // Dice: [count] d faces [modifiers] [flavour]
    this.#i++; // the "d"
    let faces: Node | "f" | "c";
    const f = this.#s[this.#i] ?? "";
    if (/[fF]/.test(f)) {
      faces = "f";
      this.#i++;
    } else if (/[cC]/.test(f)) {
      faces = "c";
      this.#i++;
    } else if (f === "(") {
      this.#i++;
      faces = { t: "paren", a: this.#additive(), flavor: null };
      if (!this.#eat(")")) this.#fail();
    } else {
      const m = /^\d+/.exec(this.#s.slice(this.#i));
      if (!m) this.#fail();
      this.#i += m[0].length;
      faces = { t: "num", value: Number(m[0]), flavor: null };
    }
    const mods = this.#modifiers();
    const flavor = this.#flavor();
    return { t: "dice", count, faces, mods, flavor, text: this.#s.slice(start, this.#i).replace(/\[[^\]]*\]$/, "").trim() };
  }

  /** Modifiers run up to the next space, bracket, operator or comma. */
  #modifiers(): string {
    const m = /^[^\s(){}[\]+\-*/%,]*/.exec(this.#s.slice(this.#i))!;
    this.#i += m[0].length;
    return m[0].toLowerCase();
  }

  #flavor(): string | null {
    if (this.#s[this.#i] !== "[") return null;
    const end = this.#s.indexOf("]", this.#i);
    if (end < 0) this.#fail();
    const text = this.#s.slice(this.#i + 1, end).trim();
    this.#i = end + 1;
    return text || null;
  }
}

/** Parse a formula, throwing DiceError when it isn't valid. Use to validate before sending. */
export function parseFormula(formula: string): Node {
  if (formula.length > MAX_LENGTH) throw new DiceError("Fórmula demasiado longa");
  const node = new Parser(formula).parse();
  checkStatic(node);
  return node;
}

/** Limits that can be checked without rolling. */
function checkStatic(n: Node): void {
  switch (n.t) {
    case "dice":
      if (n.count) checkStatic(n.count);
      if (typeof n.faces === "object") checkStatic(n.faces);
      if (n.count?.t === "num" && (n.count.value < 1 || n.count.value > MAX_DICE || !Number.isInteger(n.count.value))) {
        throw new DiceError(`Número de dados inválido (1–${MAX_DICE})`);
      }
      if (typeof n.faces === "object" && n.faces.t === "num" && (n.faces.value < 2 || n.faces.value > MAX_FACES)) {
        throw new DiceError(`Dado inválido: d${n.faces.value}`);
      }
      checkModifiers(n.mods, n.faces === "c" ? COIN_MODS : n.faces === "f" ? FATE_MODS : DIE_MODS);
      return;
    case "pool":
      n.items.forEach(checkStatic);
      checkModifiers(n.mods, POOL_MODS);
      return;
    case "bin":
      checkStatic(n.a);
      checkStatic(n.b);
      return;
    case "neg":
    case "paren":
      checkStatic(n.a);
      return;
    case "fn":
      n.args.forEach(checkStatic);
  }
}

// ---------------------------------------------------------------------------
// Modifiers

const DIE_MODS = ["rr", "r", "xo", "x", "kh", "kl", "k", "dh", "dl", "d", "min", "max", "even", "odd", "cs", "cf", "df", "sf", "ms"];
const FATE_MODS = ["rr", "r", "kh", "kl", "k", "dh", "dl", "d", "cs", "cf", "df", "sf", "ms"];
const COIN_MODS = ["c"];
const POOL_MODS = ["kh", "kl", "k", "dh", "dl", "d", "cs", "cf"];
const MOD_ARGS = String.raw`[0-9<>=]*`;

/** Split "kh2cs>=5" into ["kh2", "cs>=5"] using the longest known names first. */
function splitModifiers(mods: string, allowed: string[]): { name: string; arg: string }[] {
  if (!mods) return [];
  const names = [...allowed].sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`(${names})(${MOD_ARGS})`, "y");
  const out: { name: string; arg: string }[] = [];
  let i = 0;
  while (i < mods.length) {
    re.lastIndex = i;
    const m = re.exec(mods);
    if (!m) throw new DiceError(`Modificador desconhecido: "${mods.slice(i)}"`);
    out.push({ name: m[1], arg: m[2] });
    i = re.lastIndex;
  }
  return out;
}

function checkModifiers(mods: string, allowed: string[]): void {
  for (const { arg } of splitModifiers(mods, allowed)) {
    if (!/^(\d*)((?:<=|>=|<|>|=)?)(\d*)$/.test(arg)) throw new DiceError(`Modificador inválido: "${arg}"`);
  }
}

/** "N", "<=N", ">N"… → comparison and target. */
function comparison(arg: string, fallback: number): { cmp: Cmp; target: number } {
  const m = /^((?:<=|>=|<|>|=)?)(\d*)$/.exec(arg);
  if (!m) throw new DiceError(`Modificador inválido: "${arg}"`);
  return { cmp: (m[1] || "=") as Cmp, target: m[2] ? Number(m[2]) : fallback };
}

/** Reroll/explode arguments: "r1" (target), "r2<3" (max 2 times, below 3), "x>8". */
function limitedComparison(arg: string, fallback: number): { max: number | null; cmp: Cmp; target: number } {
  const m = /^(\d*)((?:<=|>=|<|>|=)?)(\d*)$/.exec(arg)!;
  if (m[1] && !m[2] && !m[3]) return { max: null, cmp: "=", target: Number(m[1]) };
  return { max: m[1] ? Number(m[1]) : null, cmp: (m[2] || "=") as Cmp, target: m[3] ? Number(m[3]) : fallback };
}

function matches(v: number, cmp: Cmp, target: number): boolean {
  switch (cmp) {
    case "=": return v === target;
    case "<": return v < target;
    case "<=": return v <= target;
    case ">": return v > target;
    case ">=": return v >= target;
  }
}

/** Keep (or drop) the N highest/lowest active results; ties go in roll order. */
function keepOrDrop(results: DieResult[], n: number, keep: boolean, highest: boolean): void {
  const active = results.filter(r => r.active);
  const sorted = [...active].sort((a, b) => (highest ? b.value - a.value : a.value - b.value));
  const chosen = new Set(sorted.slice(0, Math.min(n, sorted.length)));
  for (const r of active) {
    const selected = chosen.has(r);
    if (keep ? !selected : selected) {
      r.active = false;
      r.discarded = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluation

interface Ctx {
  random: RandomInt;
  rolled: number;
  terms: RollTerm[];
}

function rollOne(ctx: Ctx, faces: number | "f" | "c"): number {
  if (++ctx.rolled > MAX_RESULTS) throw new DiceError(`Demasiados dados nesta fórmula (máx. ${MAX_RESULTS})`);
  if (faces === "f") return ctx.random(3) - 2;
  if (faces === "c") return ctx.random(2) - 1;
  return ctx.random(faces);
}

function evalNode(n: Node, ctx: Ctx): number {
  switch (n.t) {
    case "num":
      return n.value;
    case "neg":
      return -evalNode(n.a, ctx);
    case "paren":
      return evalNode(n.a, ctx);
    case "bin": {
      const a = evalNode(n.a, ctx), b = evalNode(n.b, ctx);
      switch (n.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/":
          if (b === 0) throw new DiceError("Divisão por zero");
          return a / b;
        case "%":
          if (b === 0) throw new DiceError("Divisão por zero");
          return a % b;
      }
      break;
    }
    case "fn": {
      const value = FUNCTIONS[n.name](...n.args.map(a => evalNode(a, ctx)));
      if (!Number.isFinite(value)) throw new DiceError(`${n.name}(…) não deu um número`);
      return value;
    }
    case "dice":
      return evalDice(n, ctx);
    case "pool":
      return evalPool(n, ctx);
  }
  throw new DiceError("Fórmula inválida");
}

function evalDice(n: Extract<Node, { t: "dice" }>, ctx: Ctx): number {
  const count = n.count ? Math.round(evalNode(n.count, ctx)) : 1;
  const faces = typeof n.faces === "object" ? Math.round(evalNode(n.faces, ctx)) : n.faces;
  if (count < 0 || count > MAX_DICE) throw new DiceError(`Número de dados inválido (0–${MAX_DICE})`);
  if (typeof faces === "number" && (faces < 2 || faces > MAX_FACES)) throw new DiceError(`Dado inválido: d${faces}`);
  const top = faces === "f" ? 1 : faces === "c" ? 1 : faces;
  const bottom = faces === "f" ? -1 : faces === "c" ? 0 : 1;
  const results: DieResult[] = Array.from({ length: count }, () => ({ value: rollOne(ctx, faces), active: true }));
  if (faces === "f") for (const r of results) setFateFlags(r);
  let margin: { success: number } | { failure: number } | null = null;

  for (const { name, arg } of splitModifiers(n.mods, faces === "c" ? COIN_MODS : faces === "f" ? FATE_MODS : DIE_MODS)) {
    switch (name) {
      case "r":
      case "rr": {
        const { max, cmp, target } = limitedComparison(arg, bottom);
        let left = max;
        const initial = results.length;
        for (let i = 0; i < results.length; i++) {
          if (left !== null && left <= 0) break;
          if (name === "r" && i >= initial) break;
          const r = results[i];
          if (!r.active || !matches(r.value, cmp, target)) continue;
          r.active = false;
          r.rerolled = true;
          const fresh: DieResult = { value: rollOne(ctx, faces), active: true };
          if (faces === "f") setFateFlags(fresh);
          results.push(fresh);
          if (left !== null) left--;
        }
        break;
      }
      case "x":
      case "xo": {
        const { max, cmp, target } = limitedComparison(arg, top);
        // Exploding on every face would never stop: refuse it.
        if (Array.from({ length: top - bottom + 1 }, (_, k) => bottom + k).every(v => matches(v, cmp, target)) && max === null) {
          throw new DiceError("Esse dado explodiria para sempre");
        }
        let left = max;
        const initial = results.length;
        for (let i = 0; i < results.length; i++) {
          if (left !== null && left <= 0) break;
          if (name === "xo" && i >= initial) break;
          const r = results[i];
          if (!r.active || !matches(r.value, cmp, target)) continue;
          r.exploded = true;
          results.push({ value: rollOne(ctx, faces), active: true });
          if (left !== null) left--;
        }
        break;
      }
      case "k":
      case "kh":
      case "kl":
        keepOrDrop(results, arg ? Number(arg) : 1, true, name !== "kl");
        break;
      case "d":
      case "dl":
      case "dh":
        keepOrDrop(results, arg ? Number(arg) : 1, false, name === "dh");
        break;
      case "min":
      case "max": {
        const limit = Number(arg);
        if (!arg) throw new DiceError(`${name} precisa de um número (ex.: ${name}3)`);
        for (const r of results) {
          if (name === "min" ? r.value < limit : r.value > limit) {
            r.count = limit;
            r.rerolled = true;
          }
        }
        break;
      }
      case "even":
      case "odd":
        for (const r of results) {
          r.success = (Math.abs(r.value) % 2 === 0) === (name === "even");
          r.count = r.success ? 1 : 0;
        }
        break;
      case "cs":
      case "cf": {
        const { cmp, target } = comparison(arg, name === "cs" ? top : bottom);
        for (const r of results) {
          const hit = matches(r.value, cmp, target);
          if (name === "cs") r.success = hit;
          else r.failure = hit;
          r.count = hit ? 1 : 0;
        }
        break;
      }
      case "df":
      case "sf": {
        // Failures (by comparison, or the non-successes) take one point off (df) or their value (sf).
        const explicit = arg ? comparison(arg, bottom) : null;
        for (const r of results) {
          const fail = explicit ? matches(r.value, explicit.cmp, explicit.target) : r.success === false;
          if (!fail) continue;
          r.failure = true;
          r.success = undefined;
          r.count = name === "df" ? -1 : -r.value;
        }
        break;
      }
      case "ms": {
        const { cmp, target } = comparison(arg, 0);
        margin = cmp === "<" || cmp === "<=" ? { failure: target } : { success: target };
        break;
      }
      case "c": {
        // Calling a coin: count 1 for each that landed on the called side (default heads = 1).
        const call = arg === "" ? 1 : Number(arg);
        for (const r of results) {
          r.success = r.value === call;
          r.count = r.success ? 1 : 0;
        }
        break;
      }
    }
  }
  let total = results.reduce((s, r) => (r.active ? s + (r.count ?? r.value) : s), 0);
  if (margin) total = "success" in margin ? total - margin.success : margin.failure - total;
  ctx.terms.push({ kind: "dice", formula: n.text, count, faces, results, total, flavor: n.flavor });
  return total;
}

function setFateFlags(r: DieResult): void {
  if (r.value === -1) r.failure = true;
  if (r.value === 1) r.success = true;
}

function evalPool(n: Extract<Node, { t: "pool" }>, ctx: Ctx): number {
  const results: DieResult[] = n.items.map(item => ({ value: evalNode(item, ctx), active: true }));
  for (const { name, arg } of splitModifiers(n.mods, POOL_MODS)) {
    if (name.startsWith("k")) keepOrDrop(results, arg ? Number(arg) : 1, true, name !== "kl");
    else if (name.startsWith("d")) keepOrDrop(results, arg ? Number(arg) : 1, false, name === "dh");
    else {
      const max = Math.max(...results.map(r => r.value)), min = Math.min(...results.map(r => r.value));
      const { cmp, target } = comparison(arg, name === "cs" ? max : min);
      for (const r of results) {
        const hit = matches(r.value, cmp, target);
        if (name === "cs") r.success = hit;
        else r.failure = hit;
        r.count = hit ? 1 : 0;
      }
    }
  }
  const total = results.reduce((s, r) => (r.active ? s + (r.count ?? r.value) : s), 0);
  ctx.terms.push({ kind: "pool", formula: n.text, results, total, flavor: n.flavor });
  return total;
}

/** Round away floating-point noise (0.1 + 0.2) without hiding real fractions. */
const tidy = (v: number) => Math.round(v * 1e6) / 1e6;

export function roll(formula: string, randomInt: RandomInt): RollResult {
  const node = parseFormula(formula);
  const ctx: Ctx = { random: randomInt, rolled: 0, terms: [] };
  const total = tidy(evalNode(node, ctx));
  if (!Number.isFinite(total)) throw new DiceError("A fórmula não deu um número");
  return { formula: formula.trim().replace(/\s+/g, " "), total, terms: ctx.terms };
}

/**
 * Replace @paths with values from `data` (e.g. "1d20+@agilidade" with an actor's system data).
 * Unknown paths become 0 so the roll still works; the list of missing paths is returned too.
 */
export function replaceFormulaData(formula: string, data: Record<string, unknown>): { formula: string; missing: string[] } {
  const missing: string[] = [];
  const out = formula.replace(/@([a-z_][\w.]*)/gi, (_, path: string) => {
    let v: unknown = data;
    for (const k of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    if (v && typeof v === "object" && "value" in (v as object)) v = (v as { value: unknown }).value;
    if (typeof v === "number" && Number.isFinite(v)) return v < 0 ? `(${v})` : String(v);
    if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return `(${v.trim()})`;
    missing.push(path);
    return "0";
  });
  return { formula: out, missing };
}

/**
 * Ordem Paranormal test: roll one d20 per point in the attribute and keep the highest.
 * With 0 in the attribute you roll 2d20 and keep the lowest.
 */
export function opTestFormula(attribute: number, bonus: number): string {
  const dice = attribute > 0 ? `${attribute}d20kh` : "2d20kl";
  return bonus ? `${dice}${bonus > 0 ? "+" : ""}${bonus}` : dice;
}
