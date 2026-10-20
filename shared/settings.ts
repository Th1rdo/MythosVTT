import type { SettingDoc, UserDoc } from "./protocol.ts";
import type { DocLookup } from "./permissions.ts";

/**
 * Every setting Mesa knows, in one registry the server and the clients share.
 *   world  — one value for the table, stored as a Setting document, changed by the GM, enforced by the server
 *   user   — follows a user across devices, stored on their User document
 *   client — this browser only (localStorage)
 * Modules will register their own here later (Phase 8).
 */
export type SettingScope = "world" | "user" | "client";

export type SettingType =
  | { kind: "boolean" }
  | { kind: "number"; min?: number; max?: number; step?: number; range?: boolean }
  | { kind: "string"; multiline?: boolean }
  | { kind: "select"; choices: [string, string][] };

export interface SettingDef {
  key: string;
  scope: SettingScope;
  category: SettingCategory;
  name: string;
  hint?: string;
  type: SettingType;
  default: unknown;
  /** Needs a page reload to take effect. */
  reload?: boolean;
  /** Kept out of the Definições window (state rather than a preference, e.g. the pause). */
  hidden?: boolean;
}

export type SettingCategory = "game" | "permissions" | "canvas" | "chat" | "interface";
export const CATEGORY_LABELS: Record<SettingCategory, string> = {
  game: "Jogo", permissions: "Permissões dos jogadores", canvas: "Mapa e desempenho", chat: "Chat e dados", interface: "Interface"
};

const bool = (key: string, scope: SettingScope, category: SettingCategory, name: string, def: boolean, hint?: string): SettingDef =>
  ({ key, scope, category, name, hint, type: { kind: "boolean" }, default: def });

export const SETTINGS: SettingDef[] = [
  { key: "core.paused", scope: "world", category: "game", name: "Jogo em pausa", hidden: true, type: { kind: "boolean" }, default: false },
  // World: the table's rules
  {
    key: "core.gridDiagonals", scope: "world", category: "game", name: "Diagonais na grelha quadrada",
    hint: "Como se contam as casas na diagonal ao medir (régua, modelos).", default: "equidistant",
    type: { kind: "select", choices: [["equidistant", "Uma casa (1-1-1)"], ["alternating", "Alternadas (1-2-1)"], ["exact", "Distância exata"], ["rectilinear", "Só ortogonal (2 por diagonal)"]] }
  },
  bool("core.playerDrawings", "world", "permissions", "Jogadores podem desenhar", true),
  bool("core.playerTemplates", "world", "permissions", "Jogadores podem pôr modelos de medição", true),
  bool("core.playerMacroScript", "world", "permissions", "Jogadores podem fazer macros de script", true, "Desligado: só macros de chat. Scripts correm no browser de quem os executa."),
  bool("core.playerUpload", "world", "permissions", "Jogadores podem carregar ficheiros", false, "Imagens e sons para as suas personagens, macros e diário."),
  bool("core.playerPing", "world", "permissions", "Jogadores podem sinalizar o mapa", true),
  bool("core.playerRuler", "world", "permissions", "Os outros veem a régua dos jogadores", true),
  bool("core.playerWhisper", "world", "permissions", "Jogadores podem sussurrar (/w)", true),

  // User: follows the person
  {
    key: "core.rollMode", scope: "user", category: "chat", name: "Modo de rolagem por omissão",
    hint: "Para /r e para as rolagens das fichas. /gr, /br e /sr continuam a funcionar.", default: "public",
    type: { kind: "select", choices: [["public", "Para todos"], ["gm", "Para mim e o mestre"], ["blind", "Às cegas (só o mestre)"], ["self", "Só para mim"]] }
  },

  // Client: this browser
  bool("core.chatNotifications", "client", "chat", "Mostrar mensagens novas por cima do mapa", true, "Quando o separador do chat está fechado."),
  bool("core.lightAnimation", "client", "canvas", "Animar luzes (tochas, pulsar)", true),
  {
    key: "core.maxFPS", scope: "client", category: "canvas", name: "Máximo de imagens por segundo",
    hint: "Baixa em computadores fracos ou portáteis a bateria (0 = sem limite).", default: 60, type: { kind: "number", min: 0, max: 240, step: 10, range: true }
  },
  bool("core.reduceMotion", "client", "interface", "Reduzir animações", false, "Desliga a animação dos tokens a mover e dos sinais.")
];

export const SETTING_MAP = new Map(SETTINGS.map(s => [s.key, s]));

/** Check and coerce a value for a setting; throws with a readable message. */
export function validateSetting(def: SettingDef, value: unknown): unknown {
  const t = def.type;
  switch (t.kind) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${def.name}: tem de ser sim/não`);
      return value;
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n) || (t.min !== undefined && n < t.min) || (t.max !== undefined && n > t.max)) throw new Error(`${def.name}: número inválido`);
      return n;
    }
    case "string":
      if (typeof value !== "string" || value.length > 10_000) throw new Error(`${def.name}: texto inválido`);
      return value;
    case "select":
      if (!t.choices.some(([v]) => v === value)) throw new Error(`${def.name}: opção inválida`);
      return value;
  }
}

/** A world setting's current value (its Setting document, or the default). */
export function worldSetting<T = unknown>(docs: DocLookup, key: string): T {
  const doc = (docs.all("Setting") as SettingDoc[]).find(s => s.key === key);
  return (doc ? doc.value : SETTING_MAP.get(key)?.default) as T;
}

/**
 * User settings are stored on the User under `core:rollMode`-style keys: dotted keys would be read as
 * nested paths by document updates.
 */
export const userStorageKey = (key: string) => key.replace(/\./g, ":");
export const fromUserStorageKey = (key: string) => key.replace(/:/g, ".");

/** A user setting's value for this user (or the default). */
export function userSetting<T = unknown>(user: UserDoc | undefined, key: string): T {
  const v = user?.settings?.[userStorageKey(key)];
  return (v === undefined ? SETTING_MAP.get(key)?.default : v) as T;
}
