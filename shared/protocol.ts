/**
 * Mesa wire protocol and document model.
 *
 * Everything in a world is a Document: a JSON object with an `_id`, stored under a document type.
 * Some types are children of another document (Tokens live in a Scene, Items live in an Actor);
 * those carry the parent's id in `_parent`.
 *
 * Clients never write state directly. They send a DocRequest over the `doc` socket event; the server
 * validates permissions, applies it, persists it, and broadcasts a DocEvent to every client that is
 * allowed to see the result.
 */

export type DocType =
  | "User" | "Actor" | "Item" | "ActiveEffect" | "Scene" | "Token" | "Wall" | "AmbientLight" | "FogExploration"
  | "Combat" | "Combatant" | "ChatMessage" | "JournalEntry" | "Folder" | "Setting";

export const DOC_TYPES: readonly DocType[] = [
  "User", "Actor", "Item", "ActiveEffect", "Scene", "Token", "Wall", "AmbientLight", "FogExploration",
  "Combat", "Combatant", "ChatMessage", "JournalEntry", "Folder", "Setting"
];

/** Child types whose parent is optional (world-level Items live in the Items directory). */
export const OPTIONAL_PARENT: ReadonlySet<DocType> = new Set<DocType>(["Item"]);

/** Child types and the type of their parent. Deleting a parent deletes its children. */
export const PARENT_TYPE: Partial<Record<DocType, DocType>> = {
  Item: "Actor",
  ActiveEffect: "Actor",
  Token: "Scene",
  Wall: "Scene",
  AmbientLight: "Scene",
  FogExploration: "Scene",
  Combatant: "Combat"
};

export interface BaseDoc {
  _id: string;
  _parent?: string;
  [key: string]: unknown;
}

/** Ownership levels, per user, on Actors and JournalEntries. */
export const OWNERSHIP = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 } as const;
export type Ownership = { default: number; [userId: string]: number | null };

export interface UserDoc extends BaseDoc {
  name: string;
  role: "gm" | "player";
  color: string;
  character: string | null;
  /** Server-only. Never sent to clients. */
  passwordHash?: string | null;
}

/** When a token shows its name / resource bars (same scale as Foundry's TOKEN_DISPLAY_MODES). */
export const DISPLAY = { NONE: 0, CONTROL: 10, OWNER_HOVER: 20, HOVER: 30, OWNER: 40, ALWAYS: 50 } as const;
export type DisplayMode = 0 | 10 | 20 | 30 | 40 | 50;

/** Token settings an actor gives to new tokens (Foundry's "prototype token"). */
export interface PrototypeToken {
  width: number;
  height: number;
  img: string | null;
  actorLink: boolean;
  disposition: -1 | 0 | 1;
  displayName: DisplayMode;
  displayBars: DisplayMode;
  bar1: { attribute: string | null };
  bar2: { attribute: string | null };
  sight: { enabled: boolean; range: number; angle: number };
  light: LightConfig;
}

export interface ActorDoc extends BaseDoc {
  name: string;
  type: string;
  img: string | null;
  system: Record<string, any>;
  ownership: Ownership;
  folder: string | null;
  token: PrototypeToken;
}

export interface ItemDoc extends BaseDoc {
  name: string;
  type: string;
  img: string | null;
  system: Record<string, any>;
  /** World-level items only (embedded items follow their actor). */
  ownership: Ownership;
  folder: string | null;
  sort: number;
}

export type EffectChangeType = "add" | "multiply" | "override" | "upgrade" | "downgrade";

/** A modification an active effect makes to actor data, e.g. {key: "system.defense.value", type: "add", value: "-5"}. */
export interface EffectChange {
  key: string;
  type: EffectChangeType;
  value: string;
}

/** Active effect data. Stored as ActiveEffect documents on actors, or inline in an unlinked token's delta. */
export interface EffectData {
  _id: string;
  name: string;
  /** Emoji or image path. */
  icon: string;
  disabled: boolean;
  /** Condition ids this effect represents (see shared/conditions.ts). */
  statuses: string[];
  changes: EffectChange[];
  /** Rounds of combat it lasts (null = indefinite); startRound set when applied in combat. */
  duration: { rounds: number | null; startRound: number | null; combat: string | null };
  description: string;
}

export interface ActiveEffectDoc extends BaseDoc, Omit<EffectData, "_id"> {}

export interface FolderDoc extends BaseDoc {
  name: string;
  /** Which directory the folder belongs to. */
  type: "Actor" | "Item" | "JournalEntry" | "Scene";
  folder: string | null;
  color: string | null;
  sort: number;
}

export interface SceneDoc extends BaseDoc {
  name: string;
  img: string | null;
  width: number;
  height: number;
  backgroundColor: string;
  grid: { size: number; color: string; alpha: number; distance: number; units: string };
  active: boolean;
  navigation: boolean;
  sort: number;
  folder: string | null;
  /** When on, players only see what their tokens can see. */
  tokenVision: boolean;
  fog: { mode: FogMode; explored: string; unexplored: string };
  environment: {
    /** 0 = full daylight, 1 = pitch black. */
    darkness: number;
    /** Global illumination: the whole scene counts as lit while darkness ≤ globalLightThreshold. */
    globalLight: boolean;
    globalLightThreshold: number;
  };
}

export const FOG_MODE = { DISABLED: 0, INDIVIDUAL: 1, SHARED: 2 } as const;
export type FogMode = 0 | 1 | 2;

/** How strongly a wall restricts one sense. Same scale as Foundry's edge sense types. */
export const SENSE = { NONE: 0, LIMITED: 10, NORMAL: 20 } as const;
export type Sense = 0 | 10 | 20;
export const WALL_DIR = { BOTH: 0, LEFT: 1, RIGHT: 2 } as const;
export const DOOR = { NONE: 0, DOOR: 1, SECRET: 2 } as const;
export const DOOR_STATE = { CLOSED: 0, OPEN: 1, LOCKED: 2 } as const;

export interface WallDoc extends BaseDoc {
  /** Segment endpoints in scene pixels: [x1, y1, x2, y2]. */
  c: [number, number, number, number];
  move: Sense;
  sight: Sense;
  light: Sense;
  sound: Sense;
  /** One-way walls: LEFT/RIGHT block only when seen from that side of the segment (x1,y1 → x2,y2). */
  dir: 0 | 1 | 2;
  door: 0 | 1 | 2;
  ds: 0 | 1 | 2;
}

export interface LightConfig {
  /** Radii in scene distance units (e.g. metres). */
  bright: number;
  dim: number;
  color: string | null;
  /** Colour intensity 0–1. */
  alpha: number;
  /** Cone width in degrees (360 = all round). */
  angle: number;
  animation: { type: "torch" | "pulse" | "flicker" | null; speed: number; intensity: number };
}

export interface AmbientLightDoc extends BaseDoc {
  x: number;
  y: number;
  rotation: number;
  /** Whether walls block this light. */
  walls: boolean;
  hidden: boolean;
  config: LightConfig;
}

export interface FogExplorationDoc extends BaseDoc {
  user: string;
  /** PNG/WebP data URL of the explored mask at reduced resolution. */
  explored: string;
  timestamp: number;
}

export interface TokenDoc extends BaseDoc {
  name: string;
  actorId: string | null;
  img: string | null;
  /** Top-left corner in scene pixels. */
  x: number;
  y: number;
  /** Size in grid squares. */
  width: number;
  height: number;
  hidden: boolean;
  disposition: -1 | 0 | 1;
  /** Facing in degrees (0 = down, clockwise), used for vision/light cones. */
  rotation: number;
  sight: { enabled: boolean; /** distance units; 0 = sees only lit areas */ range: number; angle: number };
  light: LightConfig;
  elevation: number;
  /** Linked tokens share their actor; unlinked tokens are copies whose differences live in `delta`. */
  actorLink: boolean;
  delta: TokenDelta;
  displayName: DisplayMode;
  displayBars: DisplayMode;
  /** Paths into the actor's system data, e.g. "PV" → system.PV.{value,max}. */
  bar1: { attribute: string | null };
  bar2: { attribute: string | null };
}

/** What an unlinked token changes relative to its base actor. */
export interface TokenDelta {
  name?: string | null;
  img?: string | null;
  system?: Record<string, any>;
  effects?: EffectData[];
}

export interface CombatDoc extends BaseDoc {
  /** Scene the encounter belongs to (null = not tied to a scene). */
  sceneId: string | null;
  /** 0 = not started yet. */
  round: number;
  /** Id of the combatant whose turn it is (Mesa tracks the turn by id, not list position). */
  current: string | null;
  skipDefeated: boolean;
  sort: number;
}

export interface CombatantDoc extends BaseDoc {
  actorId: string | null;
  tokenId: string | null;
  name: string;
  img: string | null;
  initiative: number | null;
  hidden: boolean;
  defeated: boolean;
}

/** Server-side combat actions (socket event `combat`). */
export type CombatAction =
  | { action: "start" | "end" | "nextTurn" | "previousTurn" | "nextRound" | "previousRound" | "resetInitiative"; combatId: string }
  | { action: "rollInitiative"; combatId: string; combatantIds: string[] }
  | { action: "rollAll" | "rollNPCs"; combatId: string }
  /** Add or remove tokens (GM) or one's own tokens (players) from the scene's encounter. */
  | { action: "toggleTokens"; sceneId: string; tokenIds: string[] };

export interface RollResult {
  formula: string;
  total: number;
  terms: RollTerm[];
}

export type RollTerm =
  | { kind: "dice"; count: number; faces: number; keep: "all" | "high" | "low"; keepCount: number; results: { value: number; kept: boolean }[]; sign: 1 | -1 }
  | { kind: "number"; value: number; sign: 1 | -1 };

export interface ChatMessageDoc extends BaseDoc {
  author: string;
  speaker: { actor: string | null; alias: string };
  content: string;
  /** Imported/system messages may carry trusted-ish HTML (sanitized on render); player text is plain. */
  html: boolean;
  flavor: string | null;
  roll: RollResult | null;
  /** Ids of users who may see this message; null = everyone. */
  whisper: string[] | null;
  timestamp: number;
}

export interface JournalEntryDoc extends BaseDoc {
  name: string;
  content: string;
  ownership: Ownership;
  folder: string | null;
  sort: number;
}

export interface SettingDoc extends BaseDoc {
  key: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Socket messages

export type DocRequest =
  | { op: "create"; type: DocType; parent?: string; data: Record<string, unknown>[] }
  | { op: "update"; type: DocType; parent?: string; updates: ({ _id: string } & Record<string, unknown>)[] }
  | { op: "delete"; type: DocType; parent?: string; ids: string[] };

export type DocResponse = { ok: true; result: BaseDoc[] | string[] } | { ok: false; error: string };

/** Broadcast to clients after a change. For deletes `result` holds ids. */
export type DocEvent =
  | { op: "create" | "update"; type: DocType; result: BaseDoc[]; userId: string }
  | { op: "delete"; type: DocType; result: string[]; userId: string };

export interface WorldSnapshot {
  world: { id: string; title: string; system: string };
  userId: string;
  docs: Partial<Record<DocType, BaseDoc[]>>;
  online: string[];
}

/** Chat request for a roll: the server rolls so results can't be forged by the client. */
export interface RollRequest {
  formula: string;
  flavor?: string;
  speaker?: { actor: string | null; alias: string };
  whisperGM?: boolean;
}

export interface PingEvent {
  userId: string;
  sceneId: string;
  x: number;
  y: number;
}
