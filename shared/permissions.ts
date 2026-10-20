import { DOOR, DOOR_STATE, OWNERSHIP } from "./protocol.ts";
import type {
  ActiveEffectDoc, ActorDoc, AmbientLightDoc, BaseDoc, ChatMessageDoc, CombatantDoc, DocType, DrawingDoc, FogExplorationDoc, ItemDoc, JournalEntryDoc, NoteDoc,
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
    case "Token":
      return !(doc as TokenDoc).hidden || ownsActor((doc as TokenDoc).actorId, user, docs);
    case "ChatMessage": {
      const m = doc as ChatMessageDoc;
      return !m.whisper || m.author === user._id || m.whisper.includes(user._id);
    }
    case "AmbientLight":
      return !(doc as AmbientLightDoc).hidden;
    case "Tile":
      return !(doc as TileDoc).hidden;
    case "Drawing":
      return !(doc as DrawingDoc).hidden || (doc as DrawingDoc).author === user._id;
    case "Note": {
      // A pin shows to whoever can see its journal entry; pins without an entry are GM notes.
      const entry = docs.get("JournalEntry", (doc as NoteDoc).entryId ?? "") as JournalEntryDoc | undefined;
      return !!entry && ownershipLevel(entry.ownership, user) >= OWNERSHIP.LIMITED;
    }
    case "FogExploration":
      return (doc as FogExplorationDoc).user === user._id;
    case "Combatant":
      return !(doc as CombatantDoc).hidden || ownsActor((doc as CombatantDoc).actorId, user, docs);
    default:
      return true;
  }
}

/** Fields a player may change on a token they own. */
const PLAYER_TOKEN_FIELDS = new Set(["_id", "x", "y", "rotation", "elevation", "level", "delta"]);
const PLAYER_USER_FIELDS = new Set(["_id", "color", "hotbar"]);

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
    case "Drawing":
      // Anyone may draw; authors edit and delete their own drawings.
      return (doc as DrawingDoc).author === user._id ? null : deny;
    case "Combatant":
      // Owners may mark their own combatant defeated; initiative comes from server-side rolls.
      if (op !== "update" || !ownsActor((doc as CombatantDoc).actorId, user, docs)) return deny;
      return Object.keys(changes ?? {}).every(k => k === "_id" || k === "defeated") ? null : deny;
    default:
      return deny;
  }
}
