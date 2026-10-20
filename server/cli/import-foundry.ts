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
import { World } from "../world.ts";
import type { Bundle, Raw } from "./foundry.ts";
import {
  Assets, convertActor, convertItem, convertJournal, convertMacro, convertPlaylist, convertTable, effectData, escapeHtml, lightConfig,
  mergeBundles, readFoundryDb, tokenSettings, unit
} from "./foundry.ts";
import type { BaseDoc, RollResult, RollTerm } from "../../shared/protocol.ts";


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

const readCollection = (name: string) => readFoundryDb(path.join(source, "data"), name, tmp);

// ---------------------------------------------------------------------------
// Assets: copy what the world references from the Foundry user Data folder.
// Paths that only exist inside the Foundry application (core icons etc.) are dropped:
// those are Foundry's own assets and aren't ours to copy.

const target = World.create({
  id: mesaId ?? worldJson.id,
  title: worldJson.title ?? worldJson.id,
  system: worldJson.system ?? "unknown"
});
const assets = new Assets(foundryData, target.assetsDir);
const { asset, rewriteHtml } = assets;

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

const FOLDER_TYPES = new Set(["Actor", "Item", "JournalEntry", "Scene", "Playlist", "Macro", "RollTable"]);
const folders = (await readCollection("folders")).filter(f => FOLDER_TYPES.has(f.type));
const folderIds = new Set(folders.map(f => f._id));
const folderOf = (id: unknown) => (typeof id === "string" && folderIds.has(id) ? id : null);
insert("Folder", folders.map(f => ({
  _id: f._id, name: f.name, type: f.type, folder: folderOf(f.folder), color: f.color ?? null, sort: f.sort ?? 0
})));

const ctx = { asset, rewriteHtml, folderOf };
const insertBundle = (b: Bundle) => {
  for (const [type, docs] of Object.entries(b) as [Parameters<typeof insert>[0], BaseDoc[]][]) insert(type, docs);
};

insertBundle(mergeBundles((await readCollection("actors")).map(a => convertActor(a, ctx))));
insert("Item", (await readCollection("items")).map(i => convertItem(i, ctx)));

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
    pageId: n.pageId ?? null,
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

insertBundle(mergeBundles((await readCollection("playlists")).map(p => convertPlaylist(p, ctx))));

insertBundle(mergeBundles((await readCollection("tables")).map(t => convertTable(t, ctx))));
insertBundle(mergeBundles(macros.map(m => convertMacro(m, ctx))));

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

insertBundle(mergeBundles((await readCollection("journal")).map(j => convertJournal(j, ctx))));

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

target.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`Imported "${worldJson.title}" → Mesa world "${target.meta.id}" (${target.dir})`);
for (const [type, n] of Object.entries(counts)) console.log(`  ${type.padEnd(13)} ${n}`);
console.log(`  assets copied ${assets.copied.size}`);
if (assets.dropped.size) {
  const sample = [...assets.dropped].slice(0, 8);
  console.log(`  assets skipped ${assets.dropped.size} (Foundry built-ins or missing files), e.g.\n    ` + sample.join("\n    "));
}
console.log(`\nPasswords are not imported. Set them with:\n  npm run world -- passwd ${target.meta.id} "<user name>" <password>`);
