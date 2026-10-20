/**
 * Status conditions offered on the token HUD. Ordem Paranormal's Foundry system doesn't define its own
 * list (it falls back to Foundry's generic one, which uses Foundry's icon art), so Mesa ships the OP
 * conditions with emoji icons. They are markers: mechanical changes can be added per effect.
 */
export interface Condition {
  id: string;
  name: string;
  icon: string;
}

export const DEAD = "morto";

export const CONDITIONS: Condition[] = [
  { id: DEAD, name: "Morto", icon: "💀" },
  { id: "morrendo", name: "Morrendo", icon: "🩸" },
  { id: "inconsciente", name: "Inconsciente", icon: "😵" },
  { id: "abalado", name: "Abalado", icon: "😰" },
  { id: "apavorado", name: "Apavorado", icon: "😱" },
  { id: "enlouquecendo", name: "Enlouquecendo", icon: "🌀" },
  { id: "perturbado", name: "Perturbado", icon: "😖" },
  { id: "agarrado", name: "Agarrado", icon: "🤼" },
  { id: "atordoado", name: "Atordoado", icon: "💫" },
  { id: "caido", name: "Caído", icon: "⤵️" },
  { id: "cego", name: "Cego", icon: "🙈" },
  { id: "surdo", name: "Surdo", icon: "🙉" },
  { id: "confuso", name: "Confuso", icon: "❓" },
  { id: "debilitado", name: "Debilitado", icon: "🦴" },
  { id: "desprevenido", name: "Desprevenido", icon: "😳" },
  { id: "enjoado", name: "Enjoado", icon: "🤢" },
  { id: "enredado", name: "Enredado", icon: "🕸️" },
  { id: "envenenado", name: "Envenenado", icon: "☠️" },
  { id: "exausto", name: "Exausto", icon: "🥵" },
  { id: "fatigado", name: "Fatigado", icon: "😮‍💨" },
  { id: "fraco", name: "Fraco", icon: "🪶" },
  { id: "frustrado", name: "Frustrado", icon: "😤" },
  { id: "imovel", name: "Imóvel", icon: "🧱" },
  { id: "lento", name: "Lento", icon: "🐌" },
  { id: "ofuscado", name: "Ofuscado", icon: "😎" },
  { id: "paralisado", name: "Paralisado", icon: "🧊" },
  { id: "pasmo", name: "Pasmo", icon: "😶" },
  { id: "sangrando", name: "Sangrando", icon: "🩹" },
  { id: "surpreendido", name: "Surpreendido", icon: "❗" },
  { id: "vulneravel", name: "Vulnerável", icon: "🎯" },
  { id: "invisivel", name: "Invisível", icon: "👻" },
  { id: "em-chamas", name: "Em chamas", icon: "🔥" }
];

export const CONDITION_BY_ID = new Map(CONDITIONS.map(c => [c.id, c]));
