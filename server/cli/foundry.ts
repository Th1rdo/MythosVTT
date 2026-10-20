/**
 * Reading Foundry VTT data and turning Foundry documents into Mesa documents. Shared by the world
 * importer (import-foundry.ts) and the compendium importer (import-packs.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { ClassicLevel } from "classic-level";
import type { BaseDoc, DocType } from "../../shared/protocol.ts";

export type Raw = Record<string, any>;
/** Documents of several types that belong together (a document and its children). */
export type Bundle = Partial<Record<DocType, BaseDoc[]>>;

// ---------------------------------------------------------------------------
// Reading

/**
 * Primary documents of one Foundry database, with embedded collections resolved into arrays of objects.
 * `dir` holds either `<name>/` (LevelDB, v11+) or `<name>.db` (NeDB, ≤ v10). LevelDB is read from a copy in
 * `tmp` because Foundry may have it open (locked).
 */
export async function readFoundryDb(dir: string, name: string, tmp: string, sublevel = name): Promise<Raw[]> {
  const levelDir = path.join(dir, name);
  const nedbFile = path.join(dir, `${name}.db`);
  if (fs.existsSync(levelDir) && fs.statSync(levelDir).isDirectory()) return readLevel(levelDir, sublevel, tmp);
  if (fs.existsSync(nedbFile)) return readNedb(nedbFile);
  return [];
}

async function readLevel(dir: string, name: string, tmp: string): Promise<Raw[]> {
  const copy = fs.mkdtempSync(path.join(tmp, `${path.basename(dir)}-`));
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
// Assets: copy what the data references from the Foundry user Data folder. Paths that only exist inside
// the Foundry application (core icons etc.) are dropped: those are Foundry's own and aren't ours to copy.

export class Assets {
  readonly copied = new Set<string>();
  readonly dropped = new Set<string>();
  #foundryData: string;
  #assetsDir: string;

  constructor(foundryData: string, assetsDir: string) {
    this.#foundryData = foundryData;
    this.#assetsDir = assetsDir;
  }

  asset = (src: unknown): string | null => {
    if (typeof src !== "string" || !src) return null;
    if (/^(https?:|data:)/i.test(src)) return src;
    let rel: string;
    try {
      rel = decodeURIComponent(src.replace(/^\/+/, "").split(/[?#]/)[0]);
    } catch {
      return null;
    }
    const file = path.resolve(this.#foundryData, rel);
    if (!file.startsWith(this.#foundryData + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      this.dropped.add(rel);
      return null;
    }
    const dest = path.join(this.#assetsDir, "foundry", rel);
    if (!this.copied.has(rel)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      this.copied.add(rel);
    }
    return "/assets/foundry/" + rel.split("/").map(encodeURIComponent).join("/");
  };

  rewriteHtml = (html: unknown): string => String(html ?? "").replace(/(src|href)="([^"]+)"/g, (whole, attr, url) => {
    if (/^(https?:|data:|#|mailto:)/i.test(url) || !/\.\w{2,5}($|[?#])/.test(url)) return whole;
    const mapped = this.asset(url.replace(/&amp;/g, "&"));
    return mapped ? `${attr}="${mapped}"` : whole;
  });
}

// ---------------------------------------------------------------------------
// Small converters

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** A 0–1 number, or the default. */
export const unit = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

const ANIMATIONS: Record<string, "torch" | "pulse" | "flicker"> = {
  torch: "torch", flame: "torch", fairy: "flicker", flickering: "flicker", pulse: "pulse", chroma: "pulse",
  wave: "pulse", fog: "pulse", sunburst: "pulse", dome: "pulse", emanation: "pulse", hexa: "pulse",
  ghost: "flicker", energy: "flicker", vortex: "pulse", witchwave: "pulse", rainbowswirl: "pulse", radialrainbow: "pulse",
  siren: "pulse", smokepatch: "pulse", starlight: "flicker", grid: "pulse", revolving: "pulse"
};

export function lightConfig(l: Raw | undefined) {
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

export function effectData(e: Raw) {
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
export function tokenSettings(t: Raw) {
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
// Whole documents (with their children)

export interface ConvertContext {
  asset: (src: unknown) => string | null;
  rewriteHtml: (html: unknown) => string;
  /** Map a folder id to one that exists in the target (or null). */
  folderOf: (id: unknown) => string | null;
}

const CHANNELS = new Set(["music", "environment", "interface"]);
const LINKABLE = new Set(["Actor", "Item", "JournalEntry", "RollTable", "Scene", "Macro", "Playlist"]);
const PAGE_TYPES = new Set(["text", "image", "pdf", "video"]);

/** Roll-table results point at world documents by UUID ("Actor.abc…"); compendium links are dropped. */
function resultLink(r: Raw): { type: string; id: string } | null {
  const uuid = typeof r.documentUuid === "string" ? r.documentUuid : r.documentCollection && r.documentId ? `${r.documentCollection}.${r.documentId}` : "";
  const m = /^(\w+)\.([A-Za-z0-9]{16})$/.exec(uuid);
  return m && LINKABLE.has(m[1]) ? { type: m[1], id: m[2] } : null;
}

export function convertItem(i: Raw, ctx: ConvertContext, parent?: string): BaseDoc {
  const base = { _id: i._id, name: i.name, type: i.type, img: ctx.asset(i.img), system: i.system ?? i.data ?? {} };
  if (parent) return { ...base, _parent: parent };
  return { ...base, ownership: i.ownership ?? i.permission ?? { default: 0 }, folder: ctx.folderOf(i.folder), sort: i.sort ?? 0 };
}

export function convertActor(a: Raw, ctx: ConvertContext): Bundle {
  return {
    Actor: [{
      _id: a._id, name: a.name, type: a.type, img: ctx.asset(a.img), system: a.system ?? a.data ?? {},
      ownership: a.ownership ?? a.permission ?? { default: 0 }, folder: ctx.folderOf(a.folder),
      token: { ...tokenSettings(a.prototypeToken ?? a.token ?? {}), img: ctx.asset(a.prototypeToken?.texture?.src ?? a.token?.img) }
    }],
    Item: (a.items ?? []).map((i: Raw) => convertItem(i, ctx, a._id)),
    ActiveEffect: (a.effects ?? []).map((e: Raw) => ({ ...effectData(e), _parent: a._id }))
  };
}

/** Entries keep their pages and categories; pre-v10 entries keep their content (Mesa turns it into a first page). */
export function convertJournal(j: Raw, ctx: ConvertContext): Bundle {
  return {
    JournalEntry: [{
      _id: j._id, name: j.name, content: j.pages?.length ? "" : ctx.rewriteHtml(j.content),
      ownership: j.ownership ?? j.permission ?? { default: 0 }, folder: ctx.folderOf(j.folder), sort: j.sort ?? 0,
      categories: (j.categories ?? []).map((c: Raw) => ({ _id: c._id, name: c.name ?? "", sort: c.sort ?? 0 }))
    }],
    JournalEntryPage: (j.pages ?? []).map((p: Raw) => ({
      _id: p._id, _parent: j._id, name: p.name ?? "Página",
      // Types Mesa doesn't have (system pages) become text pages with what text they carry.
      type: PAGE_TYPES.has(p.type) ? p.type : "text",
      title: { show: p.title?.show ?? true, level: Math.min(6, Math.max(1, Number(p.title?.level) || 1)) },
      text: {
        content: ctx.rewriteHtml(p.text?.content ?? (PAGE_TYPES.has(p.type) ? "" : `<p><em>(página "${escapeHtml(String(p.type))}" do sistema)</em></p>`)),
        markdown: typeof p.text?.markdown === "string" ? p.text.markdown : "", format: p.text?.format === 2 ? 2 : 1
      },
      src: p.src ? ctx.asset(p.src) ?? (/^https?:/i.test(p.src) ? p.src : null) : null,
      image: { caption: p.image?.caption ?? "" },
      video: { controls: p.video?.controls ?? true, loop: !!p.video?.loop, autoplay: !!p.video?.autoplay, volume: typeof p.video?.volume === "number" ? p.video.volume : 0.5 },
      category: typeof p.category === "string" ? p.category : null, sort: p.sort ?? 0,
      ownership: p.ownership ?? { default: -1 }
    }))
  };
}

export function convertTable(t: Raw, ctx: ConvertContext): Bundle {
  return {
    RollTable: [{
      _id: t._id, name: t.name ?? "Tabela", img: ctx.asset(t.img), description: typeof t.description === "string" ? t.description : "",
      formula: typeof t.formula === "string" ? t.formula : "", replacement: t.replacement ?? true, displayRoll: t.displayRoll ?? true,
      folder: ctx.folderOf(t.folder), sort: t.sort ?? 0, ownership: t.ownership ?? { default: 0 }
    }],
    TableResult: (t.results ?? []).map((r: Raw) => {
      const document = resultLink(r);
      const range = Array.isArray(r.range) && r.range.length === 2 ? r.range.map((n: unknown) => Math.round(Number(n) || 1)) : [1, 1];
      return {
        _id: r._id, _parent: t._id, type: document ? "document" : "text",
        // v13 split "text" into name + description; older results only have text.
        name: r.name ?? (document ? "" : r.text ?? ""), description: r.description ?? (document ? r.text ?? "" : ""),
        img: ctx.asset(r.img), document, weight: Math.max(1, Math.round(Number(r.weight) || 1)),
        range: [Math.min(range[0], range[1]), Math.max(range[0], range[1])], drawn: !!r.drawn
      };
    })
  };
}

/** Macros keep their command as-is: Foundry script macros call Foundry's API and need adapting to Mesa's. */
export function convertMacro(m: Raw, ctx: ConvertContext): Bundle {
  return {
    Macro: [{
      _id: m._id, name: m.name ?? "Macro", type: m.type === "script" ? "script" : "chat",
      author: typeof m.author === "string" ? m.author : "", img: ctx.asset(m.img), command: typeof m.command === "string" ? m.command : "",
      folder: ctx.folderOf(m.folder), sort: m.sort ?? 0, ownership: m.ownership ?? { default: 0 }
    }]
  };
}

/** Playlists arrive stopped; tracks keep a paused position if they had one. */
export function convertPlaylist(p: Raw, ctx: ConvertContext): Bundle {
  return {
    Playlist: [{
      _id: p._id, name: p.name ?? "Playlist", description: p.description ?? "",
      channel: CHANNELS.has(p.channel) ? p.channel : "music",
      mode: [-1, 0, 1, 2].includes(p.mode) ? p.mode : 0,
      playing: false, fade: typeof p.fade === "number" && p.fade > 0 ? Math.min(60_000, p.fade) : null,
      folder: ctx.folderOf(p.folder), sorting: p.sorting === "m" ? "m" : "a", seed: p.seed ?? 0, sort: p.sort ?? 0,
      ownership: p.ownership ?? { default: 0 }
    }],
    PlaylistSound: (p.sounds ?? []).map((t: Raw) => ({
      _id: t._id, _parent: p._id, name: t.name ?? "Faixa", description: t.description ?? "",
      path: ctx.asset(t.path), channel: CHANNELS.has(t.channel) ? t.channel : "",
      playing: false, pausedTime: typeof t.pausedTime === "number" && t.pausedTime > 0 ? t.pausedTime : null, startedAt: null,
      repeat: !!t.repeat, volume: unit(t.volume, 0.5),
      fade: typeof t.fade === "number" && t.fade > 0 ? Math.min(60_000, t.fade) : null, sort: t.sort ?? 0
    }))
  };
}

const face = (f: Raw | undefined, ctx: ConvertContext) => ({ name: String(f?.name ?? ""), text: ctx.rewriteHtml(f?.text ?? ""), img: ctx.asset(f?.img) });

/**
 * Card stacks. Foundry gives a dealt copy the same id as the deck's card; Mesa ids are unique, so copies
 * found after their original get a fresh id and remember the original in `source`. `takenIds` is shared
 * across stacks; `newId` makes ids.
 */
export function convertCards(s: Raw, ctx: ConvertContext, takenIds: Set<string>, newId: () => string): Bundle {
  const type = ["deck", "hand", "pile"].includes(s.type) ? s.type : "deck";
  const available = (s.cards ?? []).filter((c: Raw) => type !== "deck" || !c.drawn || (typeof c.origin === "string" && c.origin !== s._id)).length;
  return {
    Cards: [{
      _id: s._id, name: s.name ?? "Cartas", type, description: ctx.rewriteHtml(s.description ?? ""), img: ctx.asset(s.img), available,
      displayCount: !!s.displayCount, folder: ctx.folderOf(s.folder), sort: s.sort ?? 0, ownership: s.ownership ?? { default: 0 }
    }],
    Card: (s.cards ?? []).map((c: Raw) => {
      const copy = takenIds.has(c._id);
      const id = copy ? newId() : c._id;
      takenIds.add(id);
      const faces = (c.faces ?? []).map((f: Raw) => face(f, ctx));
      const origin = typeof c.origin === "string" && c.origin !== s._id ? c.origin : null;
      return {
        _id: id, _parent: s._id, name: c.name ?? "Carta", description: ctx.rewriteHtml(c.description ?? ""), suit: String(c.suit ?? ""),
        value: typeof c.value === "number" ? c.value : null, back: face(c.back, ctx), faces: faces.length ? faces : [{ name: c.name ?? "", text: "", img: null }],
        face: typeof c.face === "number" && c.face < Math.max(1, faces.length) ? c.face : null,
        drawn: type === "deck" && !origin ? !!c.drawn : false, origin, source: origin ? c._id : null, sort: c.sort ?? 0
      };
    })
  };
}

/** Merge bundles type by type. */
export function mergeBundles(bundles: Bundle[]): Bundle {
  const out: Bundle = {};
  for (const b of bundles) for (const [t, docs] of Object.entries(b) as [DocType, BaseDoc[]][]) (out[t] ??= []).push(...docs);
  return out;
}
