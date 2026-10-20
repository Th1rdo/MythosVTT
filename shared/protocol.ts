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
  | "User" | "Actor" | "Item" | "Scene" | "Token" | "Wall" | "AmbientLight" | "FogExploration"
  | "ChatMessage" | "JournalEntry" | "Setting";

export const DOC_TYPES: readonly DocType[] = [
  "User", "Actor", "Item", "Scene", "Token", "Wall", "AmbientLight", "FogExploration", "ChatMessage", "JournalEntry", "Setting"
];

/** Child types and the type of their parent. Deleting a parent deletes its children. */
export const PARENT_TYPE: Partial<Record<DocType, DocType>> = {
  Item: "Actor",
  Token: "Scene",
  Wall: "Scene",
  AmbientLight: "Scene",
  FogExploration: "Scene"
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

export interface ActorDoc extends BaseDoc {
  name: string;
  type: string;
  img: string | null;
  system: Record<string, any>;
  ownership: Ownership;
  token: { width: number; height: number; img: string | null };
}

export interface ItemDoc extends BaseDoc {
  name: string;
  type: string;
  img: string | null;
  system: Record<string, any>;
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
}

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
