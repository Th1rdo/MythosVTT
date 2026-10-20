import type { ActorDoc } from "./protocol.ts";
import { opTestFormula } from "./dice.ts";

/**
 * Ordem Paranormal rules shared by the sheet (client) and the server (initiative).
 * Keys match the `ordemparanormal` Foundry system's data so imported actors work unchanged.
 */
export const ATTRIBUTES: [key: string, label: string][] = [
  ["dex", "AGI"], ["str", "FOR"], ["int", "INT"], ["pre", "PRE"], ["vit", "VIG"]
];

export const DEGREES: [label: string, name: string, bonus: number][] = [
  ["untrained", "Destreinado", 0], ["trained", "Treinado", 5], ["veteran", "Veterano", 10], ["expert", "Expert", 15]
];

export function isOrdemActor(actor: ActorDoc | undefined): boolean {
  return !!actor?.system?.attributes && !!actor?.system?.skills;
}

/** Skill bonus = training degree (+5/+10/+15) + misc modifier + flat value. */
export function skillBonus(skill: any): number {
  const degree = DEGREES.find(d => d[0] === skill?.degree?.label)?.[2] ?? 0;
  return (degree + (Number(skill?.mod) || 0) + (Number(skill?.value) || 0)) || 0;
}

/** Roll formula for a skill test: attribute dice keep highest + skill bonus. */
export function skillFormula(actor: ActorDoc, skillKey: string): string {
  const skill = actor.system?.skills?.[skillKey];
  const attrKey = Array.isArray(skill?.attr) ? skill.attr[0] : skill?.attr ?? "dex";
  const attr = Number(actor.system?.attributes?.[attrKey]?.value) || 0;
  return opTestFormula(attr, skillBonus(skill));
}

/** Initiative: an Iniciativa skill test, or a plain d20 for actors without OP data. */
export function initiativeFormula(actor: ActorDoc | undefined): string {
  if (!actor || !isOrdemActor(actor)) return "1d20";
  return skillFormula(actor, "initiative");
}
