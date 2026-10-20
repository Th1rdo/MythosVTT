import { DOOR, DOOR_STATE, OWNERSHIP } from "./protocol.ts";
import type {
  ActorDoc, AmbientLightDoc, BaseDoc, ChatMessageDoc, DocType, FogExplorationDoc, JournalEntryDoc, Ownership, TokenDoc, UserDoc, WallDoc
} from "./protocol.ts";

/** Read access to other documents, used to resolve ownership through parents (Token → Actor, Item → Actor). */
export interface DocLookup {
  get(type: DocType, id: string): BaseDoc | undefined;
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
      const actor = docs.get("Actor", doc._parent!) as ActorDoc | undefined;
      return !!actor && ownershipLevel(actor.ownership, user) >= OWNERSHIP.OBSERVER;
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
    case "FogExploration":
      return (doc as FogExplorationDoc).user === user._id;
    default:
      return true;
  }
}

/** Fields a player may change on a token they own. */
const PLAYER_TOKEN_FIELDS = new Set(["_id", "x", "y", "rotation"]);
const PLAYER_USER_FIELDS = new Set(["_id", "color"]);

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
    default:
      return deny;
  }
}
