/**
 * One-way importer: Foundry VTT world → Mesa world.
 *
 *   npm run import -- <path/to/FoundryData/worlds/<world>> [--id <mesa-id>] [--foundry-data <FoundryData dir>]
 *
 * Reads a *copy* of the Foundry databases, so it is safe to run while Foundry is open.
 *
 * Foundry storage (observed in v13/v14, see docs/foundry-analysis.md):
 *   <world>/data/<collection>/          one LevelDB per collection, utf8 keys, JSON values
 *   key "!actors!<id>"                  primary document
 *   key "!actors.items!<actor>.<item>"  embedded document; the parent keeps an array of child ids
 * Older worlds (≤ v10) use NeDB files instead: <world>/data/<collection>.db, one JSON doc per line,
 * with embedded documents stored inline.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClassicLevel } from "classic-level";
import { World } from "../world.ts";
import type { BaseDoc, RollResult, RollTerm } from "../../shared/protocol.ts";

type Raw = Record<string, any>;

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const [, v] = args.splice(i, 2);
  return v;
}
const mesaId = flag("id");
const foundryDataFlag = flag("foundry-data");
const source = args[0] && path.resolve(args[0]);
if (!source || !fs.existsSync(path.join(source, "world.json"))) {
  console.error("Usage: npm run import -- <path/to/foundry/world> [--id <mesa-id>] [--foundry-data <dir>]");
  process.exit(1);
}

const worldJson = JSON.parse(fs.readFileSync(path.join(source, "world.json"), "utf8"));
const foundryData = path.resolve(foundryDataFlag ?? path.join(source, "..", ".."));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-import-"));

// ---------------------------------------------------------------------------
// Reading Foundry collections

/** Primary docs of a collection, with embedded collections resolved into arrays of objects. */
async function readCollection(name: string): Promise<Raw[]> {
  const levelDir = path.join(source, "data", name);
  const nedbFile = path.join(source, "data", `${name}.db`);
  if (fs.existsSync(levelDir) && fs.statSync(levelDir).isDirectory()) return readLevel(name, levelDir);
  if (fs.existsSync(nedbFile)) return readNedb(nedbFile);
  return [];
}

async function readLevel(name: string, dir: string): Promise<Raw[]> {
  const copy = path.join(tmp, name);
  fs.cpSync(dir, copy, { recursive: true });
  fs.rmSync(path.join(copy, "LOCK"), { force: true });
  const db = new ClassicLevel<string, Raw>(copy, { keyEncoding: "utf8", valueEncoding: "json", createIfMissing: false });
  // sublevel ("actors", "scenes.tokens", "scenes.tokens.delta", …) → id path ("scene.token.delta") → doc
  const subs = new Map<string, Map<string, Raw>>();
  for await (const [key, value] of db.iterator()) {
    const m = /^!([^!]+)!(.+)$/.exec(key);
    if (!m || (m[1] !== name && !m[1].startsWith(name + "."))) continue;
    if (!subs.has(m[1])) subs.set(m[1], new Map());
    subs.get(m[1])!.set(m[2], value);
  }
  await db.close();

  // Embedded fields hold either an array of child ids or (for single embeds like a token's delta) one id.
  const attach = (doc: Raw, sub: string, idPath: string) => {
    for (const [childSub, children] of subs) {
      if (!childSub.startsWith(sub + ".") || childSub.slice(sub.length + 1).includes(".")) continue;
      const field = childSub.slice(sub.length + 1);
      const resolve = (id: string) => {
        const child = children.get(`${idPath}.${id}`);
        if (child) attach(child, childSub, `${idPath}.${id}`);
        return child;
      };
      if (Array.isArray(doc[field])) doc[field] = doc[field].map((c: unknown) => (typeof c === "string" ? resolve(c) : c)).filter(Boolean);
      else if (typeof doc[field] === "string") doc[field] = resolve(doc[field]) ?? null;
    }
  };
  const primary = [...(subs.get(name) ?? new Map()).entries()];
  for (const [id, doc] of primary) attach(doc, name, id);
  return primary.map(([, doc]) => doc);
}

function readNedb(file: string): Raw[] {
  const byId = new Map<string, Raw>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line);
    if (doc.$$deleted) byId.delete(doc._id);
    else if (!doc.$$indexCreated) byId.set(doc._id, doc);
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Assets: copy what the world references from the Foundry user Data folder.
// Paths that only exist inside the Foundry application (core icons etc.) are dropped:
// those are Foundry's own assets and aren't ours to copy.

const target = World.create({
  id: mesaId ?? worldJson.id,
  title: worldJson.title ?? worldJson.id,
  system: worldJson.system ?? "unknown"
});
const copied = new Set<string>();
const dropped = new Set<string>();

function asset(src: unknown): string | null {
  if (typeof src !== "string" || !src) return null;
  if (/^(https?:|data:)/i.test(src)) return src;
  let rel: string;
  try {
    rel = decodeURIComponent(src.replace(/^\/+/, "").split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const file = path.resolve(foundryData, rel);
  if (!file.startsWith(foundryData + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    dropped.add(rel);
    return null;
  }
  const dest = path.join(target.assetsDir, "foundry", rel);
  if (!copied.has(rel)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    copied.add(rel);
  }
  return "/assets/foundry/" + rel.split("/").map(encodeURIComponent).join("/");
}

function rewriteHtml(html: unknown): string {
  return String(html ?? "").replace(/(src|href)="([^"]+)"/g, (whole, attr, url) => {
    if (/^(https?:|data:|#|mailto:)/i.test(url) || !/\.\w{2,5}($|[?#])/.test(url)) return whole;
    const mapped = asset(url.replace(/&amp;/g, "&"));
    return mapped ? `${attr}="${mapped}"` : whole;
  });
}

// Foundry pads the canvas around the scene by `padding` (default 0.25 of each side), rounded up to whole
// grid squares, and placeable coordinates include that offset. Mesa scenes have no padding.
function sceneOffset(s: Raw): { padX: number; padY: number } {
  const size = (typeof s.grid === "object" ? s.grid?.size : s.grid) ?? 100;
  const padding = s.padding ?? 0.25;
  return {
    padX: Math.ceil(((s.width ?? 0) * padding) / size) * size,
    padY: Math.ceil(((s.height ?? 0) * padding) / size) * size
  };
}

const ANIMATIONS: Record<string, "torch" | "pulse" | "flicker"> = {
  torch: "torch", flame: "torch", fairy: "flicker", flickering: "flicker", pulse: "pulse", chroma: "pulse",
  wave: "pulse", fog: "pulse", sunburst: "pulse", dome: "pulse", emanation: "pulse", hexa: "pulse",
  ghost: "flicker", energy: "flicker", vortex: "pulse", witchwave: "pulse", rainbowswirl: "pulse", radialrainbow: "pulse",
  siren: "pulse", smokepatch: "pulse", starlight: "flicker", grid: "pulse", revolving: "pulse"
};

function lightConfig(l: Raw | undefined) {
  return {
    bright: Number(l?.bright) || 0,
    dim: Number(l?.dim) || 0,
    color: typeof l?.color === "string" ? l.color : null,
    alpha: typeof l?.alpha === "number" ? l.alpha : 0.5,
    angle: typeof l?.angle === "number" ? l.angle : 360,
    animation: {
      type: ANIMATIONS[l?.animation?.type ?? ""] ?? null,
      speed: l?.animation?.speed ?? 5,
      intensity: l?.animation?.intensity ?? 5
    }
  };
}

// Foundry core status ids → Mesa's Ordem Paranormal conditions.
const STATUS_MAP: Record<string, string> = {
  dead: "morto", unconscious: "inconsciente", prone: "caido", blind: "cego", deaf: "surdo", stun: "atordoado",
  paralysis: "paralisado", restrain: "agarrado", bleeding: "sangrando", poison: "envenenado", invisible: "invisivel",
  burning: "em-chamas", fear: "apavorado", sleep: "inconsciente", frozen: "paralisado"
};
// Foundry ≤ v13 numeric change modes and v14 string types → Mesa change types.
const MODE_MAP: Record<string, string> = { "1": "multiply", "2": "add", "3": "downgrade", "4": "upgrade", "5": "override", multiply: "multiply", add: "add", subtract: "add", downgrade: "downgrade", upgrade: "upgrade", override: "override" };

function effectData(e: Raw) {
  const rawChanges: Raw[] = e.system?.changes ?? e.changes ?? [];
  const changes = rawChanges
    .map(c => ({ key: String(c.key ?? ""), type: MODE_MAP[String(c.type ?? c.mode)], value: String(c.type === "subtract" ? -Number(c.value) : c.value ?? "") }))
    .filter(c => c.key && c.type);
  const rounds = e.duration?.rounds ?? (e.duration?.units === "rounds" ? e.duration?.value : null) ?? null;
  return {
    _id: e._id,
    name: e.name ?? e.label ?? "Efeito",
    icon: "✨",
    disabled: !!e.disabled,
    statuses: [...new Set<string>((e.statuses ?? []).map((id: string) => STATUS_MAP[id] ?? id))],
    changes,
    duration: { rounds: typeof rounds === "number" && rounds > 0 ? rounds : null, startRound: null, combat: null },
    description: String(e.description ?? "")
  };
}

const DISPLAY_OK = new Set([0, 10, 20, 30, 40, 50]);
const display = (v: unknown, fallback: number) => (typeof v === "number" && DISPLAY_OK.has(v) ? v : fallback);

/** Token settings shared by placed tokens and prototype tokens. */
function tokenSettings(t: Raw) {
  return {
    width: t.width ?? 1,
    height: t.height ?? 1,
    disposition: Math.max(-1, Math.min(1, t.disposition ?? 0)),
    actorLink: !!t.actorLink,
    displayName: display(t.displayName, 30),
    displayBars: display(t.displayBars, 40),
    bar1: { attribute: t.bar1?.attribute ?? null },
    bar2: { attribute: t.bar2?.attribute ?? null },
    sight: {
      enabled: t.sight?.enabled ?? !!t.vision,
      range: Number(t.sight?.range ?? t.dimSight ?? 0) || 0,
      angle: t.sight?.angle ?? t.sightAngle ?? 360
    },
    light: lightConfig(t.light ?? { bright: t.brightLight, dim: t.dimLight, color: t.lightColor, angle: t.lightAngle })
  };
}

// ---------------------------------------------------------------------------
// Conversion

const counts: Record<string, number> = {};
function insert(type: Parameters<World["insertRaw"]>[0], docs: BaseDoc[]) {
  if (!docs.length) return;
  target.insertRaw(type, docs);
  counts[type] = (counts[type] ?? 0) + docs.length;
}

const users = await readCollection("users");
// Foundry hotbars only hold macros (slot → macro id); macros are imported below.
const macros = await readCollection("macros");
const macroIds = new Set(macros.map(m => m._id));
const hotbarOf = (u: Raw) => Object.fromEntries(Object.entries(u.hotbar ?? {})
  .filter(([slot, id]) => /^\d+$/.test(slot) && typeof id === "string" && macroIds.has(id))
  .map(([slot, id]) => [slot, { type: "Macro", id }]));
insert("User", users.map(u => ({
  _id: u._id,
  name: u.name,
  role: (u.role ?? 1) >= 3 ? "gm" : "player",
  color: typeof u.color === "string" ? u.color : "#7c8cff",
  character: u.character ?? null,
  hotbar: hotbarOf(u),
  passwordHash: null
})));

const FOLDER_TYPES = new Set(["Actor", "Item", "JournalEntry", "Scene", "Playlist", "Macro"]);
const folders = (await readCollection("folders")).filter(f => FOLDER_TYPES.has(f.type));
const folderIds = new Set(folders.map(f => f._id));
const folderOf = (id: unknown) => (typeof id === "string" && folderIds.has(id) ? id : null);
insert("Folder", folders.map(f => ({
  _id: f._id, name: f.name, type: f.type, folder: folderOf(f.folder), color: f.color ?? null, sort: f.sort ?? 0
})));

const actors = await readCollection("actors");
insert("Actor", actors.map(a => ({
  _id: a._id,
  name: a.name,
  type: a.type,
  img: asset(a.img),
  system: a.system ?? a.data ?? {},
  ownership: a.ownership ?? a.permission ?? { default: 0 },
  folder: folderOf(a.folder),
  token: { ...tokenSettings(a.prototypeToken ?? a.token ?? {}), img: asset(a.prototypeToken?.texture?.src ?? a.token?.img) }
})));
insert("Item", actors.flatMap(a => (a.items ?? []).map((i: Raw) => ({
  _id: i._id, _parent: a._id, name: i.name, type: i.type, img: asset(i.img), system: i.system ?? i.data ?? {}
}))));
insert("ActiveEffect", actors.flatMap(a => (a.effects ?? []).map((e: Raw) => ({ ...effectData(e), _parent: a._id }))));

const worldItems = await readCollection("items");
insert("Item", worldItems.map(i => ({
  _id: i._id, name: i.name, type: i.type, img: asset(i.img), system: i.system ?? i.data ?? {},
  ownership: i.ownership ?? i.permission ?? { default: 0 }, folder: folderOf(i.folder), sort: i.sort ?? 0
})));

const scenes = await readCollection("scenes");
// Foundry v14 scenes keep their art in Levels. A scene with a single level is just a plain scene in
// Mesa (its background becomes the scene's); scenes with several levels keep them.
const multiLevel = (s: Raw) => Array.isArray(s.levels) && s.levels.length > 1;
const singleLevel = (s: Raw): Raw | null => (Array.isArray(s.levels) && s.levels.length === 1 ? s.levels[0] : null);
const levelIds = (s: Raw) => new Set<string>(multiLevel(s) ? s.levels.map((l: Raw) => l._id) : []);
const keepLevels = (s: Raw, list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => levelIds(s).has(id as string)) : []);

insert("Scene", scenes.map(s => {
  const grid = typeof s.grid === "object" && s.grid ? s.grid : { size: s.grid, color: s.gridColor, alpha: s.gridAlpha, distance: s.gridDistance, units: s.gridUnits };
  const only = singleLevel(s);
  return {
    _id: s._id,
    name: s.name,
    img: asset(s.background?.src ?? only?.background?.src ?? s.img),
    initialLevel: multiLevel(s) && levelIds(s).has(s.initialLevel) ? s.initialLevel : null,
    width: s.width ?? 3000,
    height: s.height ?? 2000,
    backgroundColor: s.backgroundColor ?? only?.background?.color ?? "#111111",
    grid: {
      type: [0, 1, 2, 3, 4, 5].includes(grid.type ?? s.gridType) ? grid.type ?? s.gridType : 1,
      size: grid.size ?? 100, color: grid.color ?? "#000000", alpha: grid.alpha ?? 0.2, distance: grid.distance ?? 1.5, units: grid.units ?? "m"
    },
    active: !!s.active,
    navigation: s.navigation ?? true,
    sort: s.navOrder ?? s.sort ?? 0,
    folder: folderOf(s.folder),
    tokenVision: s.tokenVision ?? true,
    fog: {
      mode: typeof s.fog?.mode === "number" ? s.fog.mode : s.fogExploration === false ? 0 : 1,
      explored: s.fog?.colors?.explored ?? "#000000",
      unexplored: s.fog?.colors?.unexplored ?? "#000000"
    },
    environment: {
      darkness: s.environment?.darknessLevel ?? s.darkness ?? 0,
      globalLight: s.environment?.globalLight?.enabled ?? s.globalLight ?? false,
      globalLightThreshold: s.environment?.globalLight?.darkness?.max ?? s.globalLightThreshold ?? 1
    }
  };
}));
insert("Level", scenes.filter(multiLevel).flatMap(s => s.levels.map((l: Raw, i: number) => ({
  _id: l._id,
  _parent: s._id,
  name: l.name ?? `Nível ${i + 1}`,
  elevation: { bottom: l.elevation?.bottom ?? null, top: l.elevation?.top ?? null },
  background: { src: asset(l.background?.src), color: l.background?.color ?? "#999999" },
  foreground: { src: asset(l.foreground?.src) },
  sort: l.sort ?? i
}))));

insert("Tile", scenes.flatMap(s => {
  const { padX, padY } = sceneOffset(s);
  return (s.tiles ?? []).map((t: Raw) => {
    const modes: unknown[] = t.occlusion?.modes ?? (t.occlusion?.mode ? [t.occlusion.mode] : []);
    return {
      _id: t._id,
      _parent: s._id,
      img: asset(t.texture?.src ?? t.img),
      x: (t.x ?? 0) - padX,
      y: (t.y ?? 0) - padY,
      width: Math.max(1, Math.round(t.width ?? 100)),
      height: Math.max(1, Math.round(t.height ?? 100)),
      rotation: t.rotation ?? 0,
      alpha: t.alpha ?? 1,
      hidden: !!t.hidden,
      locked: !!t.locked,
      elevation: t.elevation ?? 0,
      sort: t.sort ?? t.z ?? 0,
      // v12 and older had an explicit overhead flag; v13+ tiles that occlude are roofs.
      foreground: !!t.overhead || modes.length > 0,
      occlusion: { fade: modes.length > 0, alpha: t.occlusion?.alpha ?? 0.25 },
      levels: keepLevels(s, t.levels)
    };
  });
}));

// Foundry shape types: r rectangle, e ellipse, p polygon (smoothed polygons are freehand lines).
const SHAPES: Record<string, string> = { r: "rectangle", e: "ellipse", p: "polygon", c: "ellipse" };
insert("Drawing", scenes.flatMap(s => {
  const { padX, padY } = sceneOffset(s);
  return (s.drawings ?? []).map((d: Raw) => {
    const raw = d.shape?.type ?? d.type ?? "r";
    let type = SHAPES[raw] ?? "rectangle";
    if (type === "polygon" && (d.bezierFactor ?? 0) > 0) type = "freehand";
    if (d.text && !(d.shape?.width > 0)) type = "text";
    return {
      _id: d._id,
      _parent: s._id,
      author: d.author ?? "",
      shape: { type, width: d.shape?.width ?? d.width ?? 0, height: d.shape?.height ?? d.height ?? 0, points: d.shape?.points ?? d.points?.flat?.() ?? [] },
      x: (d.x ?? 0) - padX,
      y: (d.y ?? 0) - padY,
      rotation: d.rotation ?? 0,
      strokeWidth: d.strokeWidth ?? 8,
      strokeColor: d.strokeColor ?? "#ffffff",
      strokeAlpha: d.strokeAlpha ?? 1,
      fillColor: d.fillType ? d.fillColor ?? "#ffffff" : null,
      fillAlpha: d.fillAlpha ?? 0.5,
      text: d.text ?? "",
      fontSize: d.fontSize ?? 48,
      textColor: d.textColor ?? "#ffffff",
      hidden: !!d.hidden,
      locked: !!d.locked,
      sort: d.sort ?? d.z ?? 0,
      levels: keepLevels(s, d.levels)
    };
  });
}));

insert("Note", scenes.flatMap(s => {
  const { padX, padY } = sceneOffset(s);
  return (s.notes ?? []).map((n: Raw) => ({
    _id: n._id,
    _parent: s._id,
    entryId: n.entryId ?? null,
    x: (n.x ?? 0) - padX,
    y: (n.y ?? 0) - padY,
    icon: "📌",
    iconSize: n.iconSize ?? 40,
    text: n.text ?? "",
    textColor: n.textColor ?? "#ffffff",
    fontSize: n.fontSize ?? 24,
    global: !!n.global,
    levels: keepLevels(s, n.levels)
  }));
}));

// Regions (v12+). Shape type names match Mesa's; ring/emanation/token/grid shapes aren't supported yet.
const lastId = (uuid: unknown) => (typeof uuid === "string" ? uuid.split(".").at(-1) ?? "" : "");
function regionBehavior(b: Raw): Raw | null {
  const sys = b.system ?? {};
  const base = { _id: b._id, name: b.name ?? "", disabled: !!b.disabled };
  const events = (list: unknown) => {
    const ev = new Set(Array.isArray(list) ? list : []);
    const out = [ev.has("tokenEnter") || ev.has("tokenMoveIn") ? "tokenEnter" : null, ev.has("tokenExit") || ev.has("tokenMoveOut") ? "tokenExit" : null].filter(Boolean);
    return out.length ? out : ["tokenEnter"];
  };
  switch (b.type) {
    case "teleportToken": return { ...base, type: "teleportToken", system: { destinations: (sys.destinations ?? []).map(lastId).filter(Boolean) } };
    case "changeLevel": return { ...base, type: "changeLevel", system: {} };
    case "applyActiveEffect":
      return { ...base, type: "applyActiveEffect", system: { effect: { name: b.name || "Efeito da região", icon: "✨", disabled: false, statuses: [], changes: [], duration: { rounds: null, startRound: null, combat: null }, description: "" } } };
    case "displayScrollingText":
      return { ...base, type: "displayScrollingText", system: { text: sys.text ?? "", color: sys.color ?? "#ffffff", events: events(sys.events), visibility: "all" } };
    case "adjustDarknessLevel":
      return { ...base, type: "adjustDarkness", system: { mode: sys.mode === 2 ? "darken" : "brighten", amount: typeof sys.modifier === "number" ? (sys.mode === 2 ? sys.modifier : 1 - sys.modifier) : 1 } };
    case "toggleBehavior":
      return { ...base, type: "toggleBehavior", system: { events: events(sys.events), enable: (sys.enable ?? []).map(lastId), disable: (sys.disable ?? []).map(lastId) } };
    default: return null;
  }
}
insert("Region", scenes.flatMap(s => {
  const { padX, padY } = sceneOffset(s);
  return (s.regions ?? []).map((r: Raw) => {
    const shapes = (r.shapes ?? []).flatMap((sh: Raw) => {
      if (sh.type === "polygon") return [{ type: "polygon", points: (sh.points ?? []).map((n: number, i: number) => n - (i % 2 ? padY : padX)) }];
      if (!["rectangle", "circle", "ellipse", "cone", "line"].includes(sh.type)) return [];
      return [{ ...sh, x: (sh.x ?? 0) - padX, y: (sh.y ?? 0) - padY, gridBased: undefined, anchorX: undefined, anchorY: undefined, hole: undefined }];
    });
    return {
      _id: r._id,
      _parent: s._id,
      name: r.name ?? "Região",
      color: r.color ?? "#d9534f",
      shapes,
      elevation: { bottom: r.elevation?.bottom ?? null, top: r.elevation?.top ?? null },
      levels: keepLevels(s, r.levels),
      visibility: [0, 1, 2].includes(r.visibility) ? r.visibility : r.visibility === 3 ? 2 : 0,
      hidden: !!r.hidden,
      behaviors: (r.behaviors ?? []).map(regionBehavior).filter(Boolean),
      template: null,
      displayMeasurements: !!r.displayMeasurements
    };
  }).filter((r: Raw) => r.shapes.length);
}));

insert("Token", scenes.flatMap(s => {
  const { padX, padY } = sceneOffset(s);
  return (s.tokens ?? []).map((t: Raw) => ({
    _id: t._id,
    _parent: s._id,
    name: t.name ?? "",
    actorId: t.actorId ?? null,
    img: asset(t.texture?.src ?? t.img),
    x: (t.x ?? 0) - padX,
    y: (t.y ?? 0) - padY,
    hidden: !!t.hidden,
    rotation: t.rotation ?? 0,
    elevation: t.elevation ?? 0,
    level: multiLevel(s) && levelIds(s).has(t.level) ? t.level : null,
    ...tokenSettings(t),
    delta: tokenDelta(t)
  }));
}));

/** An unlinked token's differences from its actor (older Foundry used `actorData`). */
function tokenDelta(t: Raw) {
  if (t.actorLink) return {};
  const d: Raw = (t.delta && typeof t.delta === "object" ? t.delta : t.actorData) ?? {};
  const out: Raw = {};
  if (d.name && d.name !== t.name) out.name = d.name;
  if (d.img) out.img = asset(d.img);
  if (d.system && Object.keys(d.system).length) out.system = d.system;
  else if (d.data && Object.keys(d.data).length) out.system = d.data;
  if (Array.isArray(d.effects) && d.effects.length) out.effects = d.effects.filter((e: unknown) => e && typeof e === "object").map(effectData);
  return out;
}

const SENSE_OK = new Set([0, 10, 20]);
// Foundry's proximity/distance senses (30/40) need thresholds Mesa doesn't model yet; treat them as limited.
const sense = (v: unknown) => (typeof v === "number" ? (SENSE_OK.has(v) ? v : v > 20 ? 10 : 20) : 20);

insert("Wall", scenes.flatMap(s => {
  const { padX, padY } = sceneOffset(s);
  return (s.walls ?? []).filter((w: Raw) => Array.isArray(w.c) && w.c.length === 4).map((w: Raw) => ({
    _id: w._id,
    _parent: s._id,
    c: [w.c[0] - padX, w.c[1] - padY, w.c[2] - padX, w.c[3] - padY],
    move: w.move === 0 ? 0 : 20,
    sight: sense(w.sight ?? w.sense),
    light: sense(w.light ?? w.sense),
    sound: sense(w.sound),
    dir: [0, 1, 2].includes(w.dir) ? w.dir : 0,
    door: [0, 1, 2].includes(w.door) ? w.door : 0,
    ds: [0, 1, 2].includes(w.ds) ? w.ds : 0,
    levels: keepLevels(s, w.levels)
  }));
}));

insert("AmbientLight", scenes.flatMap(s => {
  const { padX, padY } = sceneOffset(s);
  return (s.lights ?? []).map((l: Raw) => ({
    _id: l._id,
    _parent: s._id,
    x: (l.x ?? 0) - padX,
    y: (l.y ?? 0) - padY,
    rotation: l.rotation ?? 0,
    walls: l.walls ?? true,
    hidden: !!l.hidden,
    levels: keepLevels(s, l.levels),
    config: lightConfig(l.config ?? { bright: l.bright, dim: l.dim, color: l.tintColor, alpha: l.tintAlpha, angle: l.angle })
  }));
}));

const SOUND_EFFECTS = new Set(["lowpass", "highpass", "reverb"]);
const soundEffect = (e: Raw | undefined, fallback: string | null) => ({
  type: SOUND_EFFECTS.has(e?.type) ? e!.type : fallback,
  intensity: Math.min(10, Math.max(1, Math.round(Number(e?.intensity) || 5)))
});
const unit = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

// Ambient sounds: radius is in scene units in both. Files that only exist in Foundry's app are dropped.
insert("AmbientSound", scenes.flatMap(s => {
  const { padX, padY } = sceneOffset(s);
  return (s.sounds ?? []).map((a: Raw) => ({
    _id: a._id,
    _parent: s._id,
    name: a.name ?? "",
    x: Math.round((a.x ?? 0) - padX),
    y: Math.round((a.y ?? 0) - padY),
    elevation: a.elevation ?? 0,
    levels: keepLevels(s, a.levels),
    radius: Math.max(0, a.radius ?? 0),
    path: asset(a.path),
    repeat: !!a.repeat,
    volume: unit(a.volume, 0.5),
    walls: a.walls ?? true,
    easing: a.easing ?? true,
    hidden: !!a.hidden,
    locked: !!a.locked,
    darkness: { min: unit(a.darkness?.min, 0), max: unit(a.darkness?.max, 1) },
    effects: { base: soundEffect(a.effects?.base, null), muffled: soundEffect(a.effects?.muffled, null) }
  }));
}));

// Playlists arrive stopped; tracks keep a paused position if they had one.
const CHANNELS = new Set(["music", "environment", "interface"]);
const playlists = await readCollection("playlists");
insert("Playlist", playlists.map(p => ({
  _id: p._id, name: p.name ?? "Playlist", description: p.description ?? "",
  channel: CHANNELS.has(p.channel) ? p.channel : "music",
  mode: [-1, 0, 1, 2].includes(p.mode) ? p.mode : 0,
  playing: false, fade: typeof p.fade === "number" && p.fade > 0 ? Math.min(60_000, p.fade) : null,
  folder: folderOf(p.folder), sorting: p.sorting === "m" ? "m" : "a", seed: p.seed ?? 0, sort: p.sort ?? 0,
  ownership: p.ownership ?? { default: 0 }
})));
insert("PlaylistSound", playlists.flatMap(p => (p.sounds ?? []).map((t: Raw) => ({
  _id: t._id, _parent: p._id, name: t.name ?? "Faixa", description: t.description ?? "",
  path: asset(t.path), channel: CHANNELS.has(t.channel) ? t.channel : "",
  playing: false, pausedTime: typeof t.pausedTime === "number" && t.pausedTime > 0 ? t.pausedTime : null, startedAt: null,
  repeat: !!t.repeat, volume: unit(t.volume, 0.5),
  fade: typeof t.fade === "number" && t.fade > 0 ? Math.min(60_000, t.fade) : null, sort: t.sort ?? 0
}))));

// Macros keep their command as-is: Foundry script macros call Foundry's API and need adapting to Mesa's.
insert("Macro", macros.map(m => ({
  _id: m._id, name: m.name ?? "Macro", type: m.type === "script" ? "script" : "chat",
  author: typeof m.author === "string" ? m.author : "", img: asset(m.img), command: typeof m.command === "string" ? m.command : "",
  folder: folderOf(m.folder), sort: m.sort ?? 0, ownership: m.ownership ?? { default: 0 }
})));

// Combats: Foundry stores the turn as an index into its sorted order (initiative desc, then id).
const combats = await readCollection("combats");
const sceneIds = new Set(scenes.map(s => s._id));
insert("Combat", combats.map((c, i) => {
  const order = [...(c.combatants ?? [])].sort((a: Raw, b: Raw) =>
    ((b.initiative ?? -Infinity) - (a.initiative ?? -Infinity)) || (a._id > b._id ? 1 : -1));
  return {
    _id: c._id,
    sceneId: sceneIds.has(c.scene) ? c.scene : null,
    round: c.round ?? 0,
    current: c.round > 0 && typeof c.turn === "number" ? order[c.turn]?._id ?? null : null,
    skipDefeated: true,
    sort: c.sort ?? i
  };
}));
insert("Combatant", combats.flatMap(c => (c.combatants ?? []).map((x: Raw) => ({
  _id: x._id,
  _parent: c._id,
  actorId: x.actorId ?? null,
  tokenId: x.tokenId ?? null,
  name: x.name ?? "",
  img: asset(x.img),
  initiative: typeof x.initiative === "number" ? x.initiative : null,
  hidden: !!x.hidden,
  defeated: !!x.defeated
}))));

const journal = await readCollection("journal");
insert("JournalEntry", journal.map(j => {
  const pages: Raw[] = [...(j.pages ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const content = pages.length
    ? pages.map(p => {
        const title = pages.length > 1 && p.title?.show !== false ? `<h2>${escapeHtml(p.name ?? "")}</h2>` : "";
        if (p.type === "image" && p.src) {
          const src = asset(p.src);
          return title + (src ? `<p><img src="${src}"></p>` : "");
        }
        if (p.type === "text") return title + rewriteHtml(p.text?.content);
        return title + `<p><em>(página "${escapeHtml(p.type)}" não importada)</em></p>`;
      }).join("\n")
    : rewriteHtml(j.content);
  return { _id: j._id, name: j.name, content, ownership: j.ownership ?? j.permission ?? { default: 0 }, folder: folderOf(j.folder), sort: j.sort ?? 0 };
}));

const messages = await readCollection("messages");
insert("ChatMessage", messages.map(m => ({
  _id: m._id,
  author: m.author ?? m.user ?? "",
  speaker: { actor: m.speaker?.actor ?? null, alias: m.speaker?.alias ?? "" },
  content: rewriteHtml(m.content),
  html: true,
  flavor: m.flavor ?? null,
  roll: importRoll(m.rolls?.[0] ?? m.roll),
  whisper: Array.isArray(m.whisper) && m.whisper.length ? m.whisper : null,
  timestamp: m.timestamp ?? 0
})));

function importRoll(raw: unknown): RollResult | null {
  if (!raw) return null;
  try {
    const r = typeof raw === "string" ? JSON.parse(raw) : raw as Raw;
    if (typeof r.total !== "number") return null;
    // Keep the dice of Foundry's die terms (Die, FateDie, Coin) for the roll card.
    const terms: RollTerm[] = (Array.isArray(r.terms) ? r.terms : [])
      .filter((t: Raw) => Array.isArray(t?.results) && ["Die", "FateDie", "Coin"].includes(t.class))
      .map((t: Raw) => ({
        kind: "dice" as const,
        formula: `${t.number ?? 1}d${t.class === "FateDie" ? "F" : t.class === "Coin" ? "c" : t.faces}${(t.modifiers ?? []).join("")}`,
        count: Number(t.number) || 1,
        faces: t.class === "FateDie" ? "f" as const : t.class === "Coin" ? "c" as const : Number(t.faces) || 6,
        results: t.results.map((x: Raw) => ({
          value: Number(x.result) || 0, active: x.active !== false,
          ...(x.discarded ? { discarded: true } : {}), ...(x.rerolled ? { rerolled: true } : {}), ...(x.exploded ? { exploded: true } : {}),
          ...(x.success ? { success: true } : {}), ...(x.failure ? { failure: true } : {}), ...(typeof x.count === "number" ? { count: x.count } : {})
        })),
        total: t.results.reduce((sum: number, x: Raw) => (x.active === false ? sum : sum + (typeof x.count === "number" ? x.count : Number(x.result) || 0)), 0),
        flavor: t.options?.flavor ?? null
      }));
    return { formula: String(r.formula ?? ""), total: r.total, terms };
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

target.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`Imported "${worldJson.title}" → Mesa world "${target.meta.id}" (${target.dir})`);
for (const [type, n] of Object.entries(counts)) console.log(`  ${type.padEnd(13)} ${n}`);
console.log(`  assets copied ${copied.size}`);
if (dropped.size) {
  const sample = [...dropped].slice(0, 8);
  console.log(`  assets skipped ${dropped.size} (Foundry built-ins or missing files), e.g.\n    ` + sample.join("\n    "));
}
console.log(`\nPasswords are not imported. Set them with:\n  npm run world -- passwd ${target.meta.id} "<user name>" <password>`);
