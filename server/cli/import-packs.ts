/**
 * Foundry compendium packs → Mesa compendia, added to an existing Mesa world.
 *
 *   npm run import-packs -- <mesa-world-id> <foundry package dir> [<more package dirs>] [--foundry-data <Data dir>] [--only a,b]
 *
 * A package dir is a Foundry system, module or world folder (it has system.json / module.json / world.json).
 * Each Actor, Item, JournalEntry, RollTable, Macro, Playlist or Adventure pack becomes a locked Mesa
 * compendium (scenes are not converted yet). Running it again replaces the packs it made before.
 * Stop the Mesa server first (or restart it afterwards) so it sees the new packs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { World } from "../world.ts";
import type { BaseDoc, CompendiumDoc, DocType, PackEntry, PackType } from "../../shared/protocol.ts";
import { prepareCreate } from "../schema.ts";
import type { Bundle, ConvertContext, Raw } from "./foundry.ts";
import { Assets, convertActor, convertItem, convertJournal, convertMacro, convertPlaylist, convertTable, mergeBundles, readFoundryDb } from "./foundry.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const [, v] = args.splice(i, 2);
  return v;
}
const foundryDataFlag = flag("foundry-data");
const only = flag("only")?.split(",").map(s => s.trim()).filter(Boolean);
const [worldId, ...packageDirs] = args;
if (!worldId || !packageDirs.length || !World.exists(worldId)) {
  console.error("Usage: npm run import-packs -- <mesa-world-id> <foundry package dir> [...] [--foundry-data <dir>] [--only pack1,pack2]");
  process.exit(1);
}

/** Foundry's sublevel (collection) name per document type. */
const COLLECTIONS: Partial<Record<PackType, string>> = {
  Actor: "actors", Item: "items", JournalEntry: "journal", RollTable: "tables", Macro: "macros", Playlist: "playlists", Adventure: "adventures"
};

const world = World.open(worldId);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-packs-"));
let total = 0;

for (const dir of packageDirs.map(d => path.resolve(d))) {
  const manifestFile = ["system.json", "module.json", "world.json"].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
  if (!manifestFile) {
    console.error(`  ${dir}: no system.json / module.json / world.json — skipped`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const source = String(manifest.id ?? manifest.name ?? path.basename(dir));
  const foundryData = path.resolve(foundryDataFlag ?? path.join(dir, "..", ".."));
  const assets = new Assets(foundryData, world.assetsDir);
  console.log(`${manifest.title ?? source} (${source})`);

  for (const p of manifest.packs ?? []) {
    const type = (p.type ?? p.entity) as PackType;
    if (only && !only.includes(p.name)) continue;
    const collection = COLLECTIONS[type];
    if (!collection) {
      console.log(`  - ${p.label ?? p.name}: ${type} packs aren't converted yet — skipped`);
      continue;
    }
    const packPath = path.resolve(dir, p.path ?? `packs/${p.name}`);
    const parent = path.dirname(packPath);
    const base = path.basename(packPath).replace(/\.db$/, "");
    const raw = await readFoundryDb(parent, base, tmp, collection);
    const folders = (await readFoundryDb(parent, base, tmp, "folders")).filter(f => !f.type || f.type === type || type === "Adventure");
    const folderIds = new Set(folders.map(f => f._id));
    const ctx: ConvertContext = { asset: assets.asset, rewriteHtml: assets.rewriteHtml, folderOf: id => (typeof id === "string" && folderIds.has(id) ? id : null) };

    const entries: PackEntry[] = [];
    for (const r of raw) {
      const docs = convertEntry(type, r, ctx);
      if (!docs) continue;
      entries.push({
        _id: r._id, name: String(r.name ?? "?"), img: type === "Adventure" ? assets.asset(r.img) : ((docs[type as DocType]?.[0] as { img?: string | null })?.img ?? null),
        subtype: type === "Actor" || type === "Item" ? (r.type ?? null) : null,
        folder: ctx.folderOf(r.folder), sort: Number(r.sort) || 0,
        ...(type === "Adventure" ? { description: assets.rewriteHtml(r.description ?? "") } : {}),
        docs: normalizeDocs(docs)
      });
    }

    // Stable id per package + pack, so running again replaces rather than duplicates.
    const id = crypto.createHash("sha1").update(`${source}/${p.name}`).digest("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
    const pack: CompendiumDoc = {
      _id: id, name: String(p.label ?? p.name), type, visibility: 1, locked: true, source,
      folders: folders.map(f => ({ _id: f._id, name: String(f.name ?? "Pasta"), folder: typeof f.folder === "string" && folderIds.has(f.folder) ? f.folder : null, sort: Number(f.sort) || 0, color: f.color ?? null })),
      sort: Number(p.sort) || 0
    };
    world.insertRaw("Compendium", [prepareCreate("Compendium", pack, id)]);
    world.packs.deletePackEntries(id);
    world.packs.putPackEntries(id, entries);
    total += entries.length;
    console.log(`  - ${pack.name}: ${entries.length} ${type}`);
  }
  if (assets.dropped.size) console.log(`  (${assets.dropped.size} image(s) not found or Foundry built-ins, left out)`);
}

world.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${total} entries imported into "${worldId}". Restart the Mesa server to see new packs.`);

/** Foundry document → Mesa documents (scenes inside adventures aren't converted yet). */
function convertEntry(type: PackType, r: Raw, ctx: ConvertContext): Bundle | null {
  switch (type) {
    case "Actor": return convertActor(r, ctx);
    case "Item": return { Item: [convertItem(r, ctx)] };
    case "JournalEntry": return convertJournal(r, ctx);
    case "RollTable": return convertTable(r, ctx);
    case "Macro": return convertMacro(r, ctx);
    case "Playlist": return convertPlaylist(r, ctx);
    case "Adventure": {
      const folders: Bundle = { Folder: (r.folders ?? []).filter((f: Raw) => f.type !== "Scene" && f.type !== "Cards").map((f: Raw) => ({ _id: f._id, name: f.name, type: f.type, folder: f.folder ?? null, color: f.color ?? null, sort: f.sort ?? 0 })) };
      const keepFolder = { ...ctx, folderOf: (id: unknown) => (typeof id === "string" ? id : null) };
      return mergeBundles([
        folders,
        ...(r.actors ?? []).map((a: Raw) => convertActor(a, keepFolder)),
        { Item: (r.items ?? []).map((i: Raw) => convertItem(i, keepFolder)) },
        ...(r.journal ?? []).map((j: Raw) => convertJournal(j, keepFolder)),
        ...(r.tables ?? []).map((t: Raw) => convertTable(t, keepFolder)),
        ...(r.macros ?? []).map((m: Raw) => convertMacro(m, keepFolder)),
        ...(r.playlists ?? []).map((p: Raw) => convertPlaylist(p, keepFolder))
      ]);
    }
    default: return null;
  }
}

/** Fill defaults now so entries look like any other stored documents. */
function normalizeDocs(docs: Bundle): Partial<Record<DocType, BaseDoc[]>> {
  const out: Partial<Record<DocType, BaseDoc[]>> = {};
  for (const [t, list] of Object.entries(docs) as [DocType, BaseDoc[]][]) {
    out[t] = list.map(d => {
      const { _id, _parent, ...data } = d;
      return prepareCreate(t, data, _id, _parent);
    });
  }
  return out;
}
