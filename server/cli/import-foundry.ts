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
import type { BaseDoc, RollResult } from "../../shared/protocol.ts";

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
  const primary = new Map<string, Raw>();
  const embedded = new Map<string, Map<string, Raw>>(); // "<embeddedName>" -> "<parentId>.<childId>" -> doc
  for await (const [key, value] of db.iterator()) {
    const m = /^!([^!]+)!(.+)$/.exec(key);
    if (!m) continue;
    const [, sub, id] = m;
    if (sub === name) primary.set(id, value);
    else if (sub.startsWith(name + ".")) {
      const emb = sub.slice(name.length + 1);
      if (!embedded.has(emb)) embedded.set(emb, new Map());
      embedded.get(emb)!.set(id, value);
    }
  }
  await db.close();
  for (const doc of primary.values()) {
    for (const [emb, children] of embedded) {
      const ids: unknown[] = Array.isArray(doc[emb]) ? doc[emb] : [];
      doc[emb] = ids.map(c => typeof c === "string" ? children.get(`${doc._id}.${c}`) : c).filter(Boolean);
    }
  }
  return [...primary.values()];
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

// ---------------------------------------------------------------------------
// Conversion

const counts: Record<string, number> = {};
function insert(type: Parameters<World["insertRaw"]>[0], docs: BaseDoc[]) {
  if (!docs.length) return;
  target.insertRaw(type, docs);
  counts[type] = (counts[type] ?? 0) + docs.length;
}

const users = await readCollection("users");
insert("User", users.map(u => ({
  _id: u._id,
  name: u.name,
  role: (u.role ?? 1) >= 3 ? "gm" : "player",
  color: typeof u.color === "string" ? u.color : "#7c8cff",
  character: u.character ?? null,
  passwordHash: null
})));

const actors = await readCollection("actors");
insert("Actor", actors.map(a => ({
  _id: a._id,
  name: a.name,
  type: a.type,
  img: asset(a.img),
  system: a.system ?? a.data ?? {},
  ownership: a.ownership ?? a.permission ?? { default: 0 },
  token: {
    width: a.prototypeToken?.width ?? a.token?.width ?? 1,
    height: a.prototypeToken?.height ?? a.token?.height ?? 1,
    img: asset(a.prototypeToken?.texture?.src ?? a.token?.img)
  }
})));
insert("Item", actors.flatMap(a => (a.items ?? []).map((i: Raw) => ({
  _id: i._id, _parent: a._id, name: i.name, type: i.type, img: asset(i.img), system: i.system ?? i.data ?? {}
}))));

const scenes = await readCollection("scenes");
insert("Scene", scenes.map(s => {
  const grid = typeof s.grid === "object" && s.grid ? s.grid : { size: s.grid, color: s.gridColor, alpha: s.gridAlpha, distance: s.gridDistance, units: s.gridUnits };
  return {
    _id: s._id,
    name: s.name,
    img: asset(s.background?.src ?? s.img),
    width: s.width ?? 3000,
    height: s.height ?? 2000,
    backgroundColor: s.backgroundColor ?? "#111111",
    grid: { size: grid.size ?? 100, color: grid.color ?? "#000000", alpha: grid.alpha ?? 0.2, distance: grid.distance ?? 1.5, units: grid.units ?? "m" },
    active: !!s.active,
    navigation: s.navigation ?? true,
    sort: s.navOrder ?? s.sort ?? 0,
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
    width: t.width ?? 1,
    height: t.height ?? 1,
    hidden: !!t.hidden,
    disposition: Math.max(-1, Math.min(1, t.disposition ?? 0)),
    rotation: t.rotation ?? 0,
    sight: {
      enabled: t.sight?.enabled ?? !!t.vision,
      range: Number(t.sight?.range ?? t.dimSight ?? 0) || 0,
      angle: t.sight?.angle ?? t.sightAngle ?? 360
    },
    light: lightConfig(t.light ?? { bright: t.brightLight, dim: t.dimLight, color: t.lightColor, angle: t.lightAngle })
  }));
}));

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
    ds: [0, 1, 2].includes(w.ds) ? w.ds : 0
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
    config: lightConfig(l.config ?? { bright: l.bright, dim: l.dim, color: l.tintColor, alpha: l.tintAlpha, angle: l.angle })
  }));
}));

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
  return { _id: j._id, name: j.name, content, ownership: j.ownership ?? j.permission ?? { default: 0 }, sort: j.sort ?? 0 };
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
    return { formula: String(r.formula ?? ""), total: r.total, terms: [] };
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
