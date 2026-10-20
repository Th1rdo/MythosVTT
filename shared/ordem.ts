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

/** Skill names (pt), keyed like the Foundry system's data. */
export const SKILL_LABELS: Record<string, string> = {
  acrobatics: "Acrobacia", animal: "Adestramento", arts: "Artes", athleticism: "Atletismo", relevance: "Atualidades",
  sciences: "Ciências", crime: "Crime", diplomacy: "Diplomacia", deception: "Enganação", resilience: "Fortitude",
  stealth: "Furtividade", initiative: "Iniciativa", intimidation: "Intimidação", intuition: "Intuição",
  investigation: "Investigação", fighting: "Luta", medicine: "Medicina", occultism: "Ocultismo", perception: "Percepção",
  driving: "Pilotagem", aim: "Pontaria", reflexes: "Reflexos", religion: "Religião", survival: "Sobrevivência",
  tactics: "Tática", technology: "Tecnologia", will: "Vontade", freeSkill: "Perícia livre"
};

/** Item types of the ordemparanormal system. */
export const ITEM_TYPES: [type: string, label: string][] = [
  ["armament", "Arma"], ["protection", "Proteção"], ["generalEquipment", "Equipamento"], ["ritual", "Ritual"], ["ability", "Habilidade"]
];

/** Default system data for a new item of each type (mirrors the system's template.json). */
export function itemTemplate(type: string): Record<string, unknown> {
  const base = { description: "", weight: 1, category: 0 };
  switch (type) {
    case "armament":
      return {
        ...base, quantity: 1, proficiency: 0, critical: "20/x2", range: "",
        formulas: { attack: { formula: "", attr: "", skill: "fighting", bonus: "" }, damage: { formula: "1d6", attr: "", bonus: "", type: "" } }
      };
    case "protection": return { ...base, defense: 0, quantity: 1 };
    case "generalEquipment": return { ...base, quantity: 1 };
    case "ritual":
      return { description: "", circle: 1, element: "", target: "", execution: "", range: "", area: { name: "", size: "", type: "" }, duration: "", resistance: "" };
    case "ability": return { description: "", abilityType: "", preRequisite: "" };
    default: return { description: "" };
  }
}
