import type { CombatDoc, CombatantDoc } from "./protocol.ts";

/** Turn order: highest initiative first, combatants without initiative last, then by name and id. */
export function turnOrder<T extends CombatantDoc>(combatants: T[]): T[] {
  return [...combatants].sort((a, b) => {
    const ia = a.initiative ?? -Infinity;
    const ib = b.initiative ?? -Infinity;
    if (ia !== ib) return ib - ia;
    return a.name.localeCompare(b.name, "pt") || (a._id > b._id ? 1 : -1);
  });
}

export interface TurnState {
  round: number;
  current: string | null;
}

function eligible(c: CombatantDoc, skipDefeated: boolean): boolean {
  return !skipDefeated || !c.defeated;
}

/** Begin the encounter: round 1, first eligible combatant. */
export function startState(combat: CombatDoc, combatants: CombatantDoc[]): TurnState {
  const order = turnOrder(combatants);
  return { round: 1, current: order.find(c => eligible(c, combat.skipDefeated))?._id ?? order[0]?._id ?? null };
}

export function nextTurnState(combat: CombatDoc, combatants: CombatantDoc[]): TurnState {
  if (combat.round === 0) return startState(combat, combatants);
  const order = turnOrder(combatants);
  const idx = order.findIndex(c => c._id === combat.current);
  const next = order.slice(idx + 1).find(c => eligible(c, combat.skipDefeated));
  return next ? { round: combat.round, current: next._id } : nextRoundState(combat, combatants);
}

export function previousTurnState(combat: CombatDoc, combatants: CombatantDoc[]): TurnState {
  const order = turnOrder(combatants);
  const idx = order.findIndex(c => c._id === combat.current);
  const before = order.slice(0, Math.max(0, idx)).reverse().find(c => eligible(c, combat.skipDefeated));
  if (before) return { round: combat.round, current: before._id };
  if (combat.round <= 1) return { round: combat.round, current: combat.current };
  const last = [...order].reverse().find(c => eligible(c, combat.skipDefeated));
  return { round: combat.round - 1, current: last?._id ?? null };
}

export function nextRoundState(combat: CombatDoc, combatants: CombatantDoc[]): TurnState {
  const order = turnOrder(combatants);
  return { round: combat.round + 1, current: order.find(c => eligible(c, combat.skipDefeated))?._id ?? order[0]?._id ?? null };
}

export function previousRoundState(combat: CombatDoc, combatants: CombatantDoc[]): TurnState {
  if (combat.round <= 1) return { round: combat.round, current: combat.current };
  const order = turnOrder(combatants);
  return { round: combat.round - 1, current: order.find(c => eligible(c, combat.skipDefeated))?._id ?? null };
}
