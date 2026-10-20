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
  | "User" | "Actor" | "Item" | "ActiveEffect" | "Scene" | "Level" | "Token" | "Tile" | "Drawing" | "Note" | "Region" | "Wall" | "AmbientLight" | "AmbientSound" | "FogExploration"
  | "Combat" | "Combatant" | "ChatMessage" | "JournalEntry" | "Folder" | "Setting" | "Playlist" | "PlaylistSound" | "Macro" | "RollTable" | "TableResult" | "JournalEntryPage";

export const DOC_TYPES: readonly DocType[] = [
  "User", "Actor", "Item", "ActiveEffect", "Scene", "Level", "Token", "Tile", "Drawing", "Note", "Region", "Wall", "AmbientLight", "AmbientSound", "FogExploration",
  "Combat", "Combatant", "ChatMessage", "JournalEntry", "Folder", "Setting", "Playlist", "PlaylistSound", "Macro", "RollTable", "TableResult", "JournalEntryPage"
];

/** Child types whose parent is optional (world-level Items live in the Items directory). */
export const OPTIONAL_PARENT: ReadonlySet<DocType> = new Set<DocType>(["Item"]);

/** Child types and the type of their parent. Deleting a parent deletes its children. */
export const PARENT_TYPE: Partial<Record<DocType, DocType>> = {
  Item: "Actor",
  ActiveEffect: "Actor",
  Token: "Scene",
  Level: "Scene",
  Tile: "Scene",
  Drawing: "Scene",
  Note: "Scene",
  Region: "Scene",
  Wall: "Scene",
  AmbientLight: "Scene",
  AmbientSound: "Scene",
  FogExploration: "Scene",
  Combatant: "Combat",
  PlaylistSound: "Playlist",
  TableResult: "RollTable",
  JournalEntryPage: "JournalEntry"
};

export interface BaseDoc {
  _id: string;
  _parent?: string;
  [key: string]: unknown;
}

/** Ownership levels, per user, on Actors and JournalEntries. INHERIT (journal pages): use the entry's. */
export const OWNERSHIP = { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 } as const;
export type Ownership = { default: number; [userId: string]: number | null };

export interface UserDoc extends BaseDoc {
  name: string;
  role: "gm" | "player";
  color: string;
  character: string | null;
  /** Hotbar slots 1–50 (10 per page) → what they hold. */
  hotbar?: Record<string, HotbarEntry | null>;
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

export interface HotbarEntry {
  type: "Item" | "Actor" | "JournalEntry" | "Macro" | "RollTable";
  id: string;
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
  /** What applied it, e.g. "region:<id>" (removed when the token leaves that region). */
  origin?: string | null;
}

export interface ActiveEffectDoc extends BaseDoc, Omit<EffectData, "_id"> {}

export interface FolderDoc extends BaseDoc {
  name: string;
  /** Which directory the folder belongs to. */
  type: "Actor" | "Item" | "JournalEntry" | "Scene" | "Playlist" | "Macro" | "RollTable";
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
  /** type: Foundry's GRID_TYPES (0 gridless, 1 square, 2–5 hex). */
  grid: { type: number; size: number; color: string; alpha: number; distance: number; units: string };
  active: boolean;
  navigation: boolean;
  sort: number;
  folder: string | null;
  /** Level shown first (scenes with levels); null = the lowest. */
  initialLevel: string | null;
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

/**
 * A floor of a multi-level scene (Foundry v14 "Level"). Each level has its own background art and an
 * elevation band; tokens belong to one level, walls/lights/tiles list the levels they appear on.
 */
export interface LevelDoc extends BaseDoc {
  name: string;
  /** null bottom = -∞, null top = +∞. */
  elevation: { bottom: number | null; top: number | null };
  background: { src: string | null; color: string };
  foreground: { src: string | null };
  sort: number;
}

export interface TileDoc extends BaseDoc {
  img: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  alpha: number;
  hidden: boolean;
  locked: boolean;
  elevation: number;
  sort: number;
  /** Drawn above tokens (roofs, canopies). */
  foreground: boolean;
  /** Foreground tiles fade to `alpha` when a token the viewer controls is underneath. */
  occlusion: { fade: boolean; alpha: number };
  /** Levels the tile appears on (empty = all). */
  levels: string[];
}

/** A shape, text or freehand line drawn on the scene. Points are relative to (x, y). */
export interface DrawingDoc extends BaseDoc {
  author: string;
  shape: { type: "rectangle" | "ellipse" | "polygon" | "freehand" | "text"; width: number; height: number; points: number[] };
  x: number;
  y: number;
  rotation: number;
  strokeWidth: number;
  strokeColor: string;
  strokeAlpha: number;
  /** null = no fill. */
  fillColor: string | null;
  fillAlpha: number;
  text: string;
  fontSize: number;
  textColor: string;
  hidden: boolean;
  locked: boolean;
  sort: number;
  levels: string[];
}

/** A map pin linked to a journal entry. */
export interface NoteDoc extends BaseDoc {
  entryId: string | null;
  /** Page of the entry to open (null = the first). */
  pageId: string | null;
  x: number;
  y: number;
  /** Emoji (or short text) shown as the pin. */
  icon: string;
  iconSize: number;
  text: string;
  textColor: string;
  fontSize: number;
  /** Visible even where the viewer has no line of sight. */
  global: boolean;
  levels: string[];
}

/** Region shapes (Foundry v14 shape data; ring/emanation not supported yet). Angles in degrees. */
export type RegionShape =
  | { type: "rectangle"; x: number; y: number; width: number; height: number; rotation?: number }
  | { type: "circle"; x: number; y: number; radius: number }
  | { type: "ellipse"; x: number; y: number; radiusX: number; radiusY: number; rotation?: number }
  | { type: "cone"; x: number; y: number; radius: number; angle: number; rotation?: number }
  | { type: "line"; x: number; y: number; length: number; width: number; rotation?: number }
  | { type: "polygon"; points: number[] };

/** Who sees a region on the map (Foundry's REGION_VISIBILITY). */
export const REGION_VISIBILITY = { LAYER: 0, GAMEMASTER: 1, ALWAYS: 2 } as const;

export type RegionEvent = "tokenEnter" | "tokenExit";

/** Something a region does when tokens enter or leave it (Foundry "region behaviours"). */
export type RegionBehavior = { _id: string; name: string; disabled: boolean } & (
  | { type: "teleportToken"; system: { destinations: string[] } }
  | { type: "changeLevel"; system: Record<string, never> }
  | { type: "applyActiveEffect"; system: { effect: Omit<EffectData, "_id"> } }
  | { type: "displayScrollingText"; system: { text: string; color: string; events: RegionEvent[]; visibility: "all" | "gm" | "owner" } }
  | { type: "adjustDarkness"; system: { mode: "brighten" | "darken"; amount: number } }
  | { type: "toggleBehavior"; system: { events: RegionEvent[]; enable: string[]; disable: string[] } }
  /** Runs on a client: the moving user if they may run it, else the highest-ranked online user who may; or everyone. */
  | { type: "executeMacro"; system: { macroId: string | null; events: RegionEvent[]; everyone: boolean } }
);

/** Sent to the client(s) that should run a macro for a region behaviour. */
export interface RunMacroEvent {
  macroId: string;
  sceneId: string;
  regionId: string;
  tokenId: string | null;
  event: RegionEvent;
}

export interface RegionDoc extends BaseDoc {
  name: string;
  color: string;
  shapes: RegionShape[];
  elevation: { bottom: number | null; top: number | null };
  levels: string[];
  visibility: 0 | 1 | 2;
  hidden: boolean;
  behaviors: RegionBehavior[];
  /** Measured templates are regions owned by whoever placed them. */
  template: { author: string } | null;
  displayMeasurements: boolean;
}

export interface ScrollingTextEvent {
  sceneId: string;
  x: number;
  y: number;
  text: string;
  color: string;
}

/** Sent to the user who moved a token into a "change level" region. */
export interface LevelPromptEvent {
  sceneId: string;
  tokenId: string;
  regionName: string;
  levels: string[];
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
  /** Levels the wall applies to (empty = all). */
  levels: string[];
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
  levels: string[];
}

/** Volume channels every browser mixes separately (Foundry's AUDIO_CHANNELS). */
export type AudioChannel = "music" | "environment" | "interface";
export const AUDIO_CHANNELS: readonly AudioChannel[] = ["music", "environment", "interface"];

/** Audio filters a sound can be played through. */
export type SoundEffectType = "lowpass" | "highpass" | "reverb";

/** A looping (or one-shot) sound placed on the map, heard by tokens within its radius. */
export interface AmbientSoundDoc extends BaseDoc {
  name: string;
  x: number;
  y: number;
  elevation: number;
  levels: string[];
  /** Hearing radius in scene distance units. */
  radius: number;
  path: string | null;
  repeat: boolean;
  /** 0–1. */
  volume: number;
  /** On: walls that block sound stop it (the sound fills the space it can reach). Off: walls only muffle it. */
  walls: boolean;
  /** Fade out towards the edge of the radius. */
  easing: boolean;
  hidden: boolean;
  locked: boolean;
  /** Only audible while the scene's darkness is within this range. */
  darkness: { min: number; max: number };
  /** Filters: always (`base`) and while heard through a wall (`muffled`). Intensity 1–10. */
  effects: { base: { type: SoundEffectType | null; intensity: number }; muffled: { type: SoundEffectType | null; intensity: number } };
}

/** Playlist playback modes (same values as Foundry's PLAYLIST_MODES). */
export const PLAYLIST_MODE = { DISABLED: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 } as const;
export type PlaylistMode = -1 | 0 | 1 | 2;

export interface PlaylistDoc extends BaseDoc {
  name: string;
  description: string;
  channel: AudioChannel;
  mode: PlaylistMode;
  playing: boolean;
  /** Cross-fade in milliseconds applied to its tracks (null = none). */
  fade: number | null;
  folder: string | null;
  /** "a" alphabetical, "m" manual (by `sort`). */
  sorting: "a" | "m";
  /** Shuffle seed, re-rolled when playback starts so every client agrees on the same order. */
  seed: number;
  sort: number;
  ownership: Ownership;
}

/**
 * A track of a playlist. While `playing`, everyone hears it from position
 * `pausedTime + (now − startedAt)` (server clock), so late joiners land in the same place.
 */
export interface PlaylistSoundDoc extends BaseDoc {
  name: string;
  description: string;
  path: string | null;
  /** Empty = the playlist's channel. */
  channel: AudioChannel | "";
  playing: boolean;
  /** Seconds into the track where playback (re)starts; null = from the beginning. */
  pausedTime: number | null;
  /** Server time (ms) when the current playback began. */
  startedAt: number | null;
  repeat: boolean;
  volume: number;
  /** Fade in/out in ms (null = the playlist's). */
  fade: number | null;
  sort: number;
}

/** Server-side playlist actions (socket event `playlist`). */
export type PlaylistAction =
  | { action: "playAll" | "stopAll" | "next" | "previous" | "cycleMode"; playlistId: string }
  | { action: "play" | "pause" | "stop"; playlistId: string; soundId: string }
  /** A client heard a track reach its natural end. `startedAt` identifies which playback ended. */
  | { action: "ended"; playlistId: string; soundId: string; startedAt: number | null };

/** A one-off sound played for some or all users (socket event `playAudio`). */
export interface PlayAudioEvent {
  src: string;
  volume?: number;
  channel?: AudioChannel;
  loop?: boolean;
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
  /** Level the token stands on (scenes with levels). */
  level: string | null;
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

/** One die (or pool entry) as rolled. `count` replaces the value in the total (successes, min/max). */
export interface DieResult {
  value: number;
  active: boolean;
  discarded?: boolean;
  rerolled?: boolean;
  exploded?: boolean;
  success?: boolean;
  failure?: boolean;
  count?: number;
}

/**
 * What a roll card shows: one entry per group of dice (or pool), in formula order.
 * Older messages hold `{kind:"dice", keep, keepCount, sign, results: {value, kept}}` and `{kind:"number"}` terms.
 */
export type RollTerm =
  | { kind: "dice"; formula: string; count: number; faces: number | "f" | "c"; results: DieResult[]; total: number; flavor?: string | null }
  | { kind: "pool"; formula: string; results: DieResult[]; total: number; flavor?: string | null }
  | { kind: "dice"; count: number; faces: number; keep: "all" | "high" | "low"; keepCount: number; results: { value: number; kept: boolean }[]; sign: 1 | -1; formula?: undefined }
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
  /** Blind roll: only GMs see the result (the roller sees that they rolled). */
  blind: boolean;
  /** Rolls written inline as [[formula]] in the text, in order. */
  inline: RollResult[];
  /** A draw from a roll table: what came out. */
  table: TableDraw | null;
  timestamp: number;
}

export interface JournalEntryDoc extends BaseDoc {
  name: string;
  /** Before pages existed; moved into a first page when a world loads. */
  content: string;
  ownership: Ownership;
  folder: string | null;
  sort: number;
  /** Groups for the pages (Foundry v13 categories). */
  categories: { _id: string; name: string; sort: number }[];
}

export const PAGE_FORMAT = { HTML: 1, MARKDOWN: 2 } as const;
export type PageType = "text" | "image" | "pdf" | "video";

/** One page of a journal entry: text (HTML or Markdown), an image, a PDF or a video. */
export interface JournalEntryPageDoc extends BaseDoc {
  name: string;
  type: PageType;
  title: { show: boolean; level: number };
  text: { content: string; markdown: string; format: 1 | 2 };
  /** Image/PDF/video file or URL. */
  src: string | null;
  image: { caption: string };
  video: { controls: boolean; loop: boolean; autoplay: boolean; volume: number };
  category: string | null;
  sort: number;
  /** default −1 = same as the entry. */
  ownership: Ownership;
}

/** GM → players: open this journal entry (at a page). */
export interface ShowEntryEvent {
  entryId: string;
  pageId: string | null;
}

/** GM → players: look at this picture. */
export interface ShareImageEvent {
  src: string;
  title: string;
}

/**
 * A saved command. Chat macros are sent as if typed in the chat (one command per line when every line
 * starts with "/"); script macros are JavaScript run in the browser of whoever executes them.
 */
export interface MacroDoc extends BaseDoc {
  name: string;
  type: "chat" | "script";
  /** Who made it (always owns it). */
  author: string;
  /** Image path or emoji; null = default icon. */
  img: string | null;
  command: string;
  folder: string | null;
  sort: number;
  /** LIMITED lets others see and run it; OWNER lets them edit it. */
  ownership: Ownership;
}

/** Documents a table result (or chat card) can point at. */
export type LinkType = "Actor" | "Item" | "JournalEntry" | "RollTable" | "Scene" | "Macro" | "Playlist";
export const LINK_TYPES: readonly LinkType[] = ["Actor", "Item", "JournalEntry", "RollTable", "Scene", "Macro", "Playlist"];

/**
 * A random table. Each result covers a range of the formula's totals; with no formula, the range comes
 * from the results' weights and the formula is 1d(total weight). Without replacement, drawn results
 * stay out until the table is reset.
 */
export interface RollTableDoc extends BaseDoc {
  name: string;
  img: string | null;
  description: string;
  /** Empty = computed from the weights when drawing. */
  formula: string;
  replacement: boolean;
  displayRoll: boolean;
  folder: string | null;
  sort: number;
  /** LIMITED: listed; OBSERVER: see results and draw; OWNER: edit. */
  ownership: Ownership;
}

export interface TableResultDoc extends BaseDoc {
  type: "text" | "document";
  name: string;
  img: string | null;
  description: string;
  /** For document results (a nested RollTable is drawn from in turn). */
  document: { type: LinkType; id: string } | null;
  weight: number;
  range: [number, number];
  drawn: boolean;
}

export interface TableDraw {
  tableId: string;
  name: string;
  img: string | null;
  results: { name: string; description: string; img: string | null; document: { type: LinkType; id: string } | null; roll: number | null; from: string | null }[];
}

/** Server-side table actions (socket event `table`). */
export type TableAction =
  | { action: "draw"; tableId: string; count?: number; mode?: RollMode }
  | { action: "reset" | "normalize"; tableId: string };

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
/** Who sees a roll: everyone, the GMs (and the roller), only GMs (blind), or only the roller. */
export type RollMode = "public" | "gm" | "blind" | "self";

export interface RollRequest {
  formula: string;
  flavor?: string;
  speaker?: { actor: string | null; alias: string };
  mode?: RollMode;
  /** Older clients: same as mode "gm". */
  whisperGM?: boolean;
}

export interface PingEvent {
  userId: string;
  sceneId: string;
  x: number;
  y: number;
}
