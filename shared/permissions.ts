import { DOOR, DOOR_STATE, OWNERSHIP, REGION_VISIBILITY } from "./protocol.ts";
import { worldSetting } from "./settings.ts";
import type {
  ActiveEffectDoc, ActorDoc, AmbientLightDoc, AmbientSoundDoc, CardsDoc, CompendiumDoc, JournalEntryPageDoc, MacroDoc, PlaylistDoc, RollTableDoc, BaseDoc, ChatMessageDoc, CombatantDoc, DocType, DrawingDoc, FogExplorationDoc, ItemDoc, JournalEntryDoc, NoteDoc, RegionDoc,
  Ownership, TileDoc, TokenDoc, UserDoc, WallDoc
} from "./protocol.ts";

/** Read access to other documents, used to resolve ownership through parents (Token → Actor, Item → Actor). */
export interface DocLookup {
  get(type: DocType, id: string): BaseDoc | undefined;
  all(type: DocType): BaseDoc[];
}

export function ownershipLevel(ownership: Ownership | undefined, user: UserDoc): number {
  if (user.role === "gm") return OWNERSHIP.OWNER;
  if (!ownership) return OWNERSHIP.NONE;
  return ownership[user._id] ?? ownership.default ?? OWNERSHIP.NONE;
}

/** Whether `user` controls a playlist (GM, or given owner rights on it). */
export function ownsPlaylist(playlistId: string | null | undefined, user: UserDoc, docs: DocLookup): boolean {
  if (user.role === "gm") return true;
  const p = playlistId ? (docs.get("Playlist", playlistId) as PlaylistDoc | undefined) : undefined;
  return !!p && ownershipLevel(p.ownership, user) >= OWNERSHIP.OWNER;
}

/** A journal page's level for `user`: its own setting, or the entry's when it inherits. */
export function pageLevel(page: JournalEntryPageDoc, user: UserDoc, docs: DocLookup): number {
  if (user.role === "gm") return OWNERSHIP.OWNER;
  const own = page.ownership?.[user._id] ?? page.ownership?.default ?? OWNERSHIP.INHERIT;
  if (own !== OWNERSHIP.INHERIT && own !== null) return own;
  const entry = docs.get("JournalEntry", page._parent ?? "") as JournalEntryDoc | undefined;
  return entry ? ownershipLevel(entry.ownership, user) : OWNERSHIP.NONE;
}

/** Ownership level of a macro: its author always owns it. */
export function macroLevel(macro: MacroDoc, user: UserDoc): number {
  if (macro.author && macro.author === user._id) return OWNERSHIP.OWNER;
  return ownershipLevel(macro.ownership, user);
}

/** Whether `user` may run a macro (Foundry: LIMITED or better). */
export function canRunMacro(macro: MacroDoc, user: UserDoc): boolean {
  return macroLevel(macro, user) >= OWNERSHIP.LIMITED;
}

export function ownsActor(actorId: string | null | undefined, user: UserDoc, docs: DocLookup): boolean {
  if (user.role === "gm") return true;
  if (!actorId) return false;
  const actor = docs.get("Actor", actorId) as ActorDoc | undefined;
  return !!actor && ownershipLevel(actor.ownership, user) >= OWNERSHIP.OWNER;
}

/** Whether `user` may see `doc`. GMs see everything. */
export function canSee(type: DocType, doc: BaseDoc, user: UserDoc, docs: DocLookup): boolean {
  if (user.role === "gm") return true;
  switch (type) {
    case "Actor":
      return ownershipLevel((doc as ActorDoc).ownership, user) >= OWNERSHIP.LIMITED;
    case "Item": {
      if (!doc._parent) return ownershipLevel((doc as ItemDoc).ownership, user) >= OWNERSHIP.LIMITED;
      const actor = docs.get("Actor", doc._parent) as ActorDoc | undefined;
      return !!actor && ownershipLevel(actor.ownership, user) >= OWNERSHIP.OBSERVER;
    }
    case "ActiveEffect": {
      // Visible with the actor, or when one of its tokens is on the map (status icons show on tokens).
      const actor = docs.get("Actor", (doc as ActiveEffectDoc)._parent!) as ActorDoc | undefined;
      if (!actor) return false;
      if (ownershipLevel(actor.ownership, user) >= OWNERSHIP.LIMITED) return true;
      return (docs.all("Token") as TokenDoc[]).some(t => t.actorId === actor._id && t.actorLink && !t.hidden);
    }
    case "JournalEntry":
      return ownershipLevel((doc as JournalEntryDoc).ownership, user) >= OWNERSHIP.LIMITED;
    case "JournalEntryPage": {
      // Only within an entry the user can see.
      const entry = docs.get("JournalEntry", doc._parent ?? "") as JournalEntryDoc | undefined;
      if (!entry || ownershipLevel(entry.ownership, user) < OWNERSHIP.LIMITED) return false;
      return pageLevel(doc as JournalEntryPageDoc, user, docs) >= OWNERSHIP.LIMITED;
    }
    case "Token":
      return !(doc as TokenDoc).hidden || ownsActor((doc as TokenDoc).actorId, user, docs);
    case "ChatMessage": {
      const m = doc as ChatMessageDoc;
      return !m.whisper || m.author === user._id || m.whisper.includes(user._id);
    }
    case "AmbientLight":
      return !(doc as AmbientLightDoc).hidden;
    case "AmbientSound":
      return !(doc as AmbientSoundDoc).hidden;
    // Playlists and their tracks reach everyone (players must hear them); the directory only lists
    // the ones a player owns or that are playing.
    case "Tile":
      return !(doc as TileDoc).hidden;
    case "Drawing":
      return !(doc as DrawingDoc).hidden || (doc as DrawingDoc).author === user._id;
    case "Region": {
      // Players see templates and regions the GM made visible to everyone. Behaviours run on the server either way.
      const r = doc as RegionDoc;
      if (r.template?.author === user._id) return true;
      return !r.hidden && r.visibility === REGION_VISIBILITY.ALWAYS;
    }
    case "Note": {
      // A pin shows to whoever can see its journal entry; pins without an entry are GM notes.
      const entry = docs.get("JournalEntry", (doc as NoteDoc).entryId ?? "") as JournalEntryDoc | undefined;
      return !!entry && ownershipLevel(entry.ownership, user) >= OWNERSHIP.LIMITED;
    }
    case "FogExploration":
      return (doc as FogExplorationDoc).user === user._id;
    case "Macro":
      return canRunMacro(doc as MacroDoc, user);
    case "Compendium":
      return (doc as CompendiumDoc).visibility === 1;
    case "Cards":
      return ownershipLevel((doc as CardsDoc).ownership, user) >= OWNERSHIP.LIMITED;
    case "Card": {
      // A stack's cards are seen by its observers and owners (keeps hands private and deck order secret).
      const stack = docs.get("Cards", doc._parent ?? "") as CardsDoc | undefined;
      return !!stack && ownershipLevel(stack.ownership, user) >= OWNERSHIP.OBSERVER;
    }
    case "RollTable":
      return ownershipLevel((doc as RollTableDoc).ownership, user) >= OWNERSHIP.LIMITED;
    case "TableResult": {
      const table = docs.get("RollTable", doc._parent ?? "") as RollTableDoc | undefined;
      return !!table && ownershipLevel(table.ownership, user) >= OWNERSHIP.OBSERVER;
    }
    case "Combatant":
      return !(doc as CombatantDoc).hidden || ownsActor((doc as CombatantDoc).actorId, user, docs);
    default:
      return true;
  }
}

/** Fields a player may change on a token they own. */
const PLAYER_TOKEN_FIELDS = new Set(["_id", "x", "y", "rotation", "elevation", "level", "delta"]);
const PLAYER_USER_FIELDS = new Set(["_id", "color", "hotbar", "settings"]);

/**
 * Whether `user` may apply `op` to `doc` (for updates, `changes` is the requested diff).
 * Returns an error message, or null when allowed.
 */
export function checkWrite(
  op: "create" | "update" | "delete",
  type: DocType,
  doc: BaseDoc,
  user: UserDoc,
  docs: DocLookup,
  changes?: Record<string, unknown>
): string | null {
  if (user.role === "gm") return null;
  const deny = "Sem permissão";
  switch (type) {
    case "ChatMessage":
      if (op === "update") return deny;
      return (doc as ChatMessageDoc).author === user._id ? null : deny;
    case "Actor":
      if (op !== "update") return deny;
      return ownsActor(doc._id, user, docs) ? null : deny;
    case "Item":
      return doc._parent && ownsActor(doc._parent, user, docs) ? null : deny;
    case "ActiveEffect":
      return ownsActor(doc._parent, user, docs) ? null : deny;
    case "Token":
      if (op !== "update" || !ownsActor((doc as TokenDoc).actorId, user, docs)) return deny;
      return Object.keys(changes ?? {}).every(k => PLAYER_TOKEN_FIELDS.has(k)) ? null : deny;
    case "User":
      if (op !== "update" || doc._id !== user._id) return deny;
      return Object.keys(changes ?? {}).every(k => PLAYER_USER_FIELDS.has(k)) ? null : deny;
    case "Wall": {
      // Players may open and close ordinary doors that aren't locked. Nothing else.
      const w = doc as WallDoc;
      if (op !== "update" || w.door !== DOOR.DOOR || w.ds === DOOR_STATE.LOCKED) return deny;
      const keys = Object.keys(changes ?? {}).filter(k => k !== "_id");
      const ds = changes?.ds;
      if (keys.length !== 1 || keys[0] !== "ds" || (ds !== DOOR_STATE.OPEN && ds !== DOOR_STATE.CLOSED)) return deny;
      return null;
    }
    case "FogExploration":
      return (doc as FogExplorationDoc).user === user._id && (op !== "update" || !("user" in (changes ?? {}))) ? null : deny;
    case "Region": {
      // Players may place, move and remove their own measured templates (regions with no behaviours).
      const r = doc as RegionDoc;
      if (r.template?.author !== user._id || r.behaviors?.length) return deny;
      if (op === "create" && !worldSetting(docs, "core.playerTemplates")) return "O mestre desligou os modelos para os jogadores";
      const allowed = new Set(["_id", "shapes", "color", "name"]);
      return op !== "update" || Object.keys(changes ?? {}).every(k => allowed.has(k)) ? null : deny;
    }
    case "Drawing":
      // Anyone may draw (unless the GM turned it off); authors edit and delete their own drawings.
      if (op === "create" && !worldSetting(docs, "core.playerDrawings")) return "O mestre desligou os desenhos para os jogadores";
      return (doc as DrawingDoc).author === user._id ? null : deny;
    case "Macro": {
      // Anyone makes macros (the server marks them as the author); owners edit, share and delete them.
      // Script macros need the world setting; without it players can't write or change scripts.
      const scripts = !!worldSetting(docs, "core.playerMacroScript");
      const touchesScript = (doc as MacroDoc).type === "script" || changes?.type === "script";
      if (!scripts && op !== "delete" && touchesScript && (op === "create" || "command" in (changes ?? {}) || "type" in (changes ?? {}))) {
        return "O mestre não deixa os jogadores fazer macros de script";
      }
      if (op === "create") return (doc as MacroDoc).author === user._id ? null : deny;
      if (macroLevel(doc as MacroDoc, user) < OWNERSHIP.OWNER) return deny;
      return op === "update" && "author" in (changes ?? {}) ? deny : null;
    }
    case "JournalEntry":
      // Owners edit their entries (not who else owns them); only the GM creates or deletes entries.
      if (op !== "update" || ownershipLevel((doc as JournalEntryDoc).ownership, user) < OWNERSHIP.OWNER) return deny;
      return "ownership" in (changes ?? {}) ? deny : null;
    case "JournalEntryPage": {
      const entry = docs.get("JournalEntry", doc._parent ?? "") as JournalEntryDoc | undefined;
      const owner = (entry && ownershipLevel(entry.ownership, user) >= OWNERSHIP.OWNER) || pageLevel(doc as JournalEntryPageDoc, user, docs) >= OWNERSHIP.OWNER;
      if (!owner) return deny;
      return op === "update" && "ownership" in (changes ?? {}) && !(entry && ownershipLevel(entry.ownership, user) >= OWNERSHIP.OWNER) ? deny : null;
    }
    case "RollTable":
      if (op !== "update" || ownershipLevel((doc as RollTableDoc).ownership, user) < OWNERSHIP.OWNER) return deny;
      return "ownership" in (changes ?? {}) ? deny : null;
    case "TableResult": {
      const table = docs.get("RollTable", doc._parent ?? "") as RollTableDoc | undefined;
      return table && ownershipLevel(table.ownership, user) >= OWNERSHIP.OWNER ? null : deny;
    }
    case "Playlist":
      // Owners run and edit their playlist; only the GM creates playlists or changes who owns them.
      if (op !== "update" || !ownsPlaylist(doc._id, user, docs)) return deny;
      return "ownership" in (changes ?? {}) ? deny : null;
    case "PlaylistSound":
      return ownsPlaylist(doc._parent, user, docs) ? null : deny;
    case "Combatant":
      // Owners may mark their own combatant defeated; initiative comes from server-side rolls.
      if (op !== "update" || !ownsActor((doc as CombatantDoc).actorId, user, docs)) return deny;
      return Object.keys(changes ?? {}).every(k => k === "_id" || k === "defeated") ? null : deny;
    default:
      return deny;
  }
}
