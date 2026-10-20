import type { ChatMessageDoc, RollMode, RollResult, RollTableDoc, TableAction, TableDraw, TableResultDoc, UserDoc } from "../shared/protocol.ts";
import { OWNERSHIP } from "../shared/protocol.ts";
import { ownershipLevel } from "../shared/permissions.ts";
import type { RandomInt } from "../shared/dice.ts";
import { roll } from "../shared/dice.ts";
import type { Change, World } from "./world.ts";

const MAX_DEPTH = 5;
const MAX_TRIES = 1000;
const MAX_DRAWS = 50;

type Drawn = TableDraw["results"][number];

/** Results in range order, then by id (stable across clients). */
export function tableResults(world: World, tableId: string): TableResultDoc[] {
  return world.all<TableResultDoc>("TableResult").filter(r => r._parent === tableId)
    .sort((a, b) => a.range[0] - b.range[0] || a._id.localeCompare(b._id));
}

/** Ranges laid end to end by weight, and the formula that covers them. */
export function normalizedRanges(results: TableResultDoc[]): { ranges: Map<string, [number, number]>; formula: string } {
  const ranges = new Map<string, [number, number]>();
  let next = 1;
  for (const r of results) {
    const w = Math.max(1, Math.round(r.weight || 1));
    ranges.set(r._id, [next, next + w - 1]);
    next += w;
  }
  // A single slot needs no dice (and d1 isn't a die).
  return { ranges, formula: next - 1 > 1 ? `1d${next - 1}` : "1" };
}

/**
 * Roll a table once: retry until the total lands on a result that hasn't been drawn, then follow
 * results that point at other tables. `taken` collects ids drawn so far so draws of several at once
 * don't repeat results of tables without replacement.
 */
function rollTable(world: World, table: RollTableDoc, random: RandomInt, taken: Set<string>, depth = 0): { roll: RollResult | null; results: Drawn[] } {
  if (depth > MAX_DEPTH) throw new Error("Tabelas dentro de tabelas a mais (máx. 5 níveis)");
  const all = tableResults(world, table._id);
  const blocked = (r: TableResultDoc) => (!table.replacement && (r.drawn || taken.has(r._id)));
  const available = all.filter(r => !blocked(r));
  if (!available.length) throw new Error(`A tabela "${table.name}" não tem resultados disponíveis${table.replacement ? "" : " (repõe-a)"}`);
  let ranges = new Map(all.map(r => [r._id, r.range] as const));
  let formula = table.formula.trim();
  if (!formula) ({ ranges, formula } = normalizedRanges(all));

  let result: RollResult | null = null;
  let hits: TableResultDoc[] = [];
  for (let i = 0; i < MAX_TRIES && !hits.length; i++) {
    result = roll(formula, random);
    const total = result.total;
    hits = available.filter(r => total >= ranges.get(r._id)![0] && total <= ranges.get(r._id)![1]);
  }
  if (!hits.length) throw new Error(`Nenhum resultado de "${table.name}" cabe na fórmula ${formula}`);

  const out: Drawn[] = [];
  for (const r of hits) {
    if (!table.replacement) taken.add(r._id);
    const inner = r.type === "document" && r.document?.type === "RollTable" ? (world.get("RollTable", r.document.id) as RollTableDoc | undefined) : undefined;
    if (inner) {
      const nested = rollTable(world, inner, random, taken, depth + 1);
      out.push(...nested.results.map(n => ({ ...n, from: n.from ?? inner.name })));
      continue;
    }
    out.push({
      name: r.name || (r.document ? String((world.get(r.document.type, r.document.id) as { name?: string } | undefined)?.name ?? "") : ""),
      description: r.description, img: r.img, document: r.type === "document" ? r.document : null,
      roll: result!.total, from: null
    });
  }
  return { roll: result, results: out };
}

/**
 * Draw, reset or re-weight a table. Drawing needs observer rights; reset/normalize need owner rights.
 * Draws are posted to the chat as one card (with the roll when the table shows it).
 */
export function runTableAction(world: World, user: UserDoc, a: TableAction, random: RandomInt): Change[] {
  const table = world.get("RollTable", a?.tableId) as RollTableDoc | undefined;
  if (!table) throw new Error("Tabela não existe");
  const level = ownershipLevel(table.ownership, user);
  const results = tableResults(world, table._id);

  if (a.action === "reset" || a.action === "normalize") {
    if (level < OWNERSHIP.OWNER) throw new Error("Sem permissão");
    if (a.action === "reset") {
      const updates = results.filter(r => r.drawn).map(r => ({ _id: r._id, drawn: false }));
      return updates.length ? world.applyAsSystem({ op: "update", type: "TableResult", parent: table._id, updates }) : [];
    }
    const { ranges, formula } = normalizedRanges(results);
    return [
      ...world.applyAsSystem({ op: "update", type: "RollTable", updates: [{ _id: table._id, formula }] }),
      ...(results.length ? world.applyAsSystem({ op: "update", type: "TableResult", parent: table._id, updates: results.map(r => ({ _id: r._id, range: ranges.get(r._id)! })) }) : [])
    ];
  }

  if (a.action !== "draw") throw new Error("Ação desconhecida");
  if (level < OWNERSHIP.OBSERVER) throw new Error("Sem permissão");
  const count = Math.min(MAX_DRAWS, Math.max(1, Math.round(Number(a.count) || 1)));
  const taken = new Set<string>();
  const drawn: Drawn[] = [];
  let firstRoll: RollResult | null = null;
  for (let i = 0; i < count; i++) {
    let r;
    try {
      r = rollTable(world, table, random, taken);
    } catch (err) {
      if (i === 0) throw err;
      break; // Ran out part-way through a multiple draw: post what came out.
    }
    firstRoll ??= r.roll;
    drawn.push(...r.results);
  }

  const changes: Change[] = [];
  // Mark draws on every table without replacement that gave something.
  const byTable = new Map<string, string[]>();
  for (const id of taken) {
    const res = world.get("TableResult", id) as TableResultDoc | undefined;
    if (!res) continue;
    const t = world.get("RollTable", res._parent!) as RollTableDoc | undefined;
    if (!t || t.replacement) continue;
    byTable.set(t._id, [...(byTable.get(t._id) ?? []), id]);
  }
  for (const [tableId, ids] of byTable) {
    changes.push(...world.applyAsSystem({ op: "update", type: "TableResult", parent: tableId, updates: ids.map(id => ({ _id: id, drawn: true })) }));
  }

  const mode: RollMode = a.mode ?? "public";
  const gms = world.all<UserDoc>("User").filter(u => u.role === "gm").map(u => u._id);
  const whisper = mode === "public" ? null : mode === "self" ? [user._id] : [...new Set([...gms, user._id])];
  const message: Partial<ChatMessageDoc> = {
    author: user._id,
    speaker: { actor: null, alias: user.name },
    content: "",
    flavor: count > 1 ? `${drawn.length} resultados de ${table.name}` : `Resultado de ${table.name}`,
    roll: table.displayRoll && count === 1 ? firstRoll : null,
    table: { tableId: table._id, name: table.name, img: table.img, results: drawn },
    whisper,
    blind: mode === "blind",
    timestamp: Date.now()
  };
  changes.push(...world.createAsSystem("ChatMessage", [message]).map(after => ({ type: "ChatMessage" as const, after })));
  return changes;
}
