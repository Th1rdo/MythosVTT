import type { BaseDoc, DocType } from "../shared/protocol.ts";
import { OWNERSHIP } from "../shared/protocol.ts";
import { isPlainObject, mergeDeep } from "../shared/objects.ts";

const NO_LIGHT = { bright: 0, dim: 0, color: null, alpha: 0.5, angle: 360, animation: { type: null, speed: 5, intensity: 5 } };

/** Default field values for each document type, applied on create. */
function defaults(type: DocType): Record<string, unknown> {
  switch (type) {
    case "User":
      return { name: "Jogador", role: "player", color: "#7c8cff", character: null, passwordHash: null };
    case "Actor":
      return { name: "Novo ator", type: "agent", img: null, system: {}, ownership: { default: OWNERSHIP.NONE }, token: { width: 1, height: 1, img: null } };
    case "Item":
      return { name: "Novo item", type: "item", img: null, system: {} };
    case "Scene":
      return {
        name: "Nova cena", img: null, width: 3000, height: 2000, backgroundColor: "#111111",
        grid: { size: 100, color: "#000000", alpha: 0.25, distance: 1.5, units: "m" },
        active: false, navigation: true, sort: 0,
        tokenVision: true,
        fog: { mode: 1, explored: "#000000", unexplored: "#000000" },
        environment: { darkness: 0, globalLight: true, globalLightThreshold: 0.5 }
      };
    case "Token":
      return {
        name: "Token", actorId: null, img: null, x: 0, y: 0, width: 1, height: 1, hidden: false, disposition: 0, rotation: 0,
        sight: { enabled: false, range: 0, angle: 360 },
        light: NO_LIGHT
      };
    case "Wall":
      return { c: [0, 0, 0, 0], move: 20, sight: 20, light: 20, sound: 20, dir: 0, door: 0, ds: 0 };
    case "AmbientLight":
      return { x: 0, y: 0, rotation: 0, walls: true, hidden: false, config: { ...NO_LIGHT, bright: 3, dim: 6, color: "#ffc070", alpha: 0.4 } };
    case "FogExploration":
      return { user: "", explored: "", timestamp: 0 };
    case "Combat":
      return { sceneId: null, round: 0, current: null, skipDefeated: true, sort: 0 };
    case "Combatant":
      return { actorId: null, tokenId: null, name: "", img: null, initiative: null, hidden: false, defeated: false };
    case "ChatMessage":
      return { author: "", speaker: { actor: null, alias: "" }, content: "", html: false, flavor: null, roll: null, whisper: null, timestamp: 0 };
    case "JournalEntry":
      return { name: "Nova entrada", content: "", ownership: { default: OWNERSHIP.NONE }, sort: 0 };
    case "Setting":
      return { key: "", value: null };
  }
}

const NUMBER_FIELDS: Partial<Record<DocType, string[]>> = {
  Token: ["x", "y", "width", "height", "rotation"],
  AmbientLight: ["x", "y", "rotation"],
  Combat: ["round", "sort"],
  Scene: ["width", "height", "sort"],
  JournalEntry: ["sort"]
};

const MAX_CONTENT = 200_000;
const MAX_FOG_IMAGE = 900_000;
const SENSES = new Set([0, 10, 20]);

/** Fill defaults for a new document. Throws on invalid shapes. */
export function prepareCreate(type: DocType, data: Record<string, unknown>, id: string, parent?: string): BaseDoc {
  if (!isPlainObject(data)) throw new Error("Dados inválidos");
  const doc: BaseDoc = { ...mergeDeep(defaults(type), data), _id: id };
  if (parent) doc._parent = parent;
  else delete doc._parent;
  validate(type, doc);
  return doc;
}

export function validate(type: DocType, doc: BaseDoc): void {
  for (const f of NUMBER_FIELDS[type] ?? []) {
    if (typeof doc[f] !== "number" || !Number.isFinite(doc[f])) throw new Error(`${type}.${f} tem de ser um número`);
  }
  if (typeof doc.name === "string" && doc.name.length > 200) throw new Error("Nome demasiado longo");
  if (typeof doc.content === "string" && doc.content.length > MAX_CONTENT) throw new Error("Conteúdo demasiado longo");
  if (type === "Wall") {
    const c = doc.c;
    if (!Array.isArray(c) || c.length !== 4 || !c.every(n => typeof n === "number" && Number.isFinite(n))) {
      throw new Error("Parede inválida: c tem de ser [x1, y1, x2, y2]");
    }
    for (const k of ["move", "sight", "light", "sound"]) if (!SENSES.has(doc[k] as number)) throw new Error(`Parede: ${k} inválido`);
    if (![0, 1, 2].includes(doc.dir as number) || ![0, 1, 2].includes(doc.door as number) || ![0, 1, 2].includes(doc.ds as number)) {
      throw new Error("Parede: dir/door/ds inválido");
    }
  }
  if (type === "Combatant" && doc.initiative !== null && (typeof doc.initiative !== "number" || !Number.isFinite(doc.initiative))) {
    throw new Error("Iniciativa tem de ser um número");
  }
  if (type === "FogExploration") {
    if (typeof doc.explored !== "string" || doc.explored.length > MAX_FOG_IMAGE) throw new Error("Nevoeiro inválido");
    if (doc.explored && !/^data:image\/(webp|png);base64,/.test(doc.explored)) throw new Error("Nevoeiro: formato de imagem inválido");
  }
}

/** Fill in fields added after a document was stored (older worlds, imports). */
export function normalize(type: DocType, doc: BaseDoc): BaseDoc {
  return mergeDeep(defaults(type), doc) as BaseDoc;
}
