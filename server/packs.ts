import type { BaseDoc, CompendiumDoc, DocType, FolderDoc, PackAction, PackEntry, UserDoc } from "../shared/protocol.ts";
import { OWNERSHIP, PARENT_TYPE } from "../shared/protocol.ts";
import { ownsActor } from "../shared/permissions.ts";
import { randomId } from "../shared/objects.ts";
import type { Change, World } from "./world.ts";

/** Children never carried into packs (per-user state). */
const SKIP_CHILDREN = new Set<DocType>(["FogExploration"]);
/** Top-level types an adventure can carry. */
const ADVENTURE_TYPES: DocType[] = ["Folder", "Actor", "Item", "JournalEntry", "RollTable", "Macro", "Playlist", "Scene"];

/** A document and everything under it, by type (parents before children). */
export function collectBundle(world: World, type: DocType, id: string, into: Partial<Record<DocType, BaseDoc[]>> = {}): Partial<Record<DocType, BaseDoc[]>> {
  const doc = world.get(type, id);
  if (!doc) return into;
  (into[type] ??= []).push(structuredClone(doc));
  for (const [child, parent] of Object.entries(PARENT_TYPE) as [DocType, DocType][]) {
    if (parent !== type || SKIP_CHILDREN.has(child)) continue;
    for (const c of world.all(child)) if (c._parent === id) collectBundle(world, child, c._id, into);
  }
  return into;
}

/** Flatten a bundle into creation order: parents (types without a parent) first. */
function ordered(docs: Partial<Record<DocType, BaseDoc[]>>): { type: DocType; doc: BaseDoc }[] {
  const all = Object.entries(docs) as [DocType, BaseDoc[]][];
  const depth = (t: DocType): number => (PARENT_TYPE[t] ? 1 + depth(PARENT_TYPE[t]!) : 0);
  // Folders first among top-level types so documents can land in them.
  return all.sort(([a], [b]) => depth(a) - depth(b) || (a === "Folder" ? -1 : b === "Folder" ? 1 : 0))
    .flatMap(([type, list]) => list.map(doc => ({ type, doc })));
}

/** Copy a bundle with fresh ids, keeping parent links inside it. */
function withNewIds(docs: Partial<Record<DocType, BaseDoc[]>>): Partial<Record<DocType, BaseDoc[]>> {
  const map = new Map<string, string>();
  for (const list of Object.values(docs)) for (const d of list ?? []) map.set(d._id, randomId());
  const out: Partial<Record<DocType, BaseDoc[]>> = {};
  for (const [type, list] of Object.entries(docs) as [DocType, BaseDoc[]][]) {
    out[type] = list.map(d => ({ ...structuredClone(d), _id: map.get(d._id)!, ...(d._parent ? { _parent: map.get(d._parent) ?? d._parent } : {}) }));
  }
  return out;
}

function entryFor(type: DocType, root: BaseDoc, docs: Partial<Record<DocType, BaseDoc[]>>, folder: string | null): PackEntry {
  const r = root as BaseDoc & { name?: string; img?: string | null; type?: string; sort?: number };
  return {
    _id: randomId(), name: r.name ?? "?", img: r.img ?? null,
    subtype: type === "Actor" || type === "Item" ? (r.type ?? null) : null,
    folder, sort: Number(r.sort) || 0, docs
  };
}

/**
 * Compendium actions. Reading needs the pack to be visible (or GM); changing it needs the GM and an
 * unlocked pack; importing into the world is for the GM, except items taken into one's own actor.
 * Returns data for the caller and the world changes to broadcast.
 */
export function runPackAction(world: World, user: UserDoc, a: PackAction): { result: unknown; changes: Change[] } {
  const pack = world.get("Compendium", a?.packId) as CompendiumDoc | undefined;
  if (!pack) throw new Error("Compêndio não existe");
  const gm = user.role === "gm";
  if (!gm && pack.visibility !== 1) throw new Error("Sem permissão");
  const store = world.packs;
  const needGM = () => {
    if (!gm) throw new Error("Sem permissão");
  };
  const needUnlocked = () => {
    needGM();
    if (pack.locked) throw new Error("O compêndio está trancado (destranca-o para o mudar)");
  };
  const entry = (id: string) => {
    const e = store.packEntry(pack._id, id);
    if (!e) throw new Error("Entrada não existe");
    return e;
  };

  switch (a.action) {
    case "index":
      return { result: store.packIndex(pack._id), changes: [] };

    case "get":
      return { result: entry(a.entryId), changes: [] };

    case "import": {
      needGM();
      const changes: Change[] = [];
      for (const id of a.entryIds.slice(0, 500)) {
        const e = entry(id);
        if (pack.type === "Adventure") {
          // Adventures keep their ids so links between their documents still work.
          changes.push(...world.importDocs(ordered(e.docs), !!a.overwrite));
          continue;
        }
        const fresh = withNewIds(e.docs);
        const root = fresh[pack.type as DocType]?.[0];
        if (root) {
          Object.assign(root, { folder: a.folder ?? null });
          if ("ownership" in root) root.ownership = { default: OWNERSHIP.NONE };
        }
        changes.push(...world.importDocs(ordered(fresh), false));
      }
      return { result: changes.filter(c => c.after && !c.after._parent && c.type !== "Folder").length, changes };
    }

    case "importToActor": {
      if (pack.type !== "Item") throw new Error("Só itens podem ir para uma personagem");
      if (!ownsActor(a.actorId, user, world) || !world.get("Actor", a.actorId)) throw new Error("Sem permissão");
      const e = entry(a.entryId);
      const item = e.docs.Item?.[0];
      if (!item) throw new Error("Entrada vazia");
      const { _id, _parent, ownership, folder, sort, ...data } = structuredClone(item) as BaseDoc & Record<string, unknown>;
      void _id; void _parent; void ownership; void folder; void sort;
      const changes = world.applyAsSystem({ op: "create", type: "Item", parent: a.actorId, data: [data] });
      return { result: changes[0]?.after?._id ?? null, changes };
    }

    case "export": {
      needUnlocked();
      if (pack.type === "Adventure") throw new Error("Usa “criar aventura” para este compêndio");
      const entries = a.docs.filter(d => d.type === pack.type).map(d => {
        const root = world.get(d.type, d.id);
        if (!root) throw new Error(`${d.type} ${d.id} não existe`);
        return entryFor(d.type, root, collectBundle(world, d.type, d.id), a.folder ?? null);
      });
      if (!entries.length) throw new Error(`Este compêndio só guarda ${pack.type}`);
      store.putPackEntries(pack._id, entries);
      return { result: entries.length, changes: [] };
    }

    case "exportAdventure": {
      needUnlocked();
      if (pack.type !== "Adventure") throw new Error("Este compêndio não é de aventuras");
      // Folders chosen, their subfolders, and every document inside them.
      const folders = new Set<string>(a.folders);
      for (let grew = true; grew;) {
        grew = false;
        for (const f of world.all<FolderDoc>("Folder")) if (f.folder && folders.has(f.folder) && !folders.has(f._id)) {
          folders.add(f._id);
          grew = true;
        }
      }
      const docs: Partial<Record<DocType, BaseDoc[]>> = {};
      for (const id of folders) collectBundle(world, "Folder", id, docs);
      const seen = new Set<string>();
      const add = (type: DocType, id: string) => {
        if (seen.has(`${type}:${id}`)) return;
        seen.add(`${type}:${id}`);
        collectBundle(world, type, id, docs);
      };
      for (const type of ADVENTURE_TYPES) {
        if (type === "Folder") continue;
        for (const d of world.all(type)) if (!d._parent && d.folder && folders.has(d.folder as string)) add(type, d._id);
      }
      for (const d of a.docs) if (ADVENTURE_TYPES.includes(d.type) && d.type !== "Folder") add(d.type, d.id);
      const count = Object.entries(docs).filter(([t]) => t !== "Folder").reduce((n, [, l]) => n + (l ?? []).filter(d => !d._parent).length, 0);
      if (!count) throw new Error("A aventura está vazia");
      const e: PackEntry = {
        _id: randomId(), name: String(a.name || "Aventura").slice(0, 200), img: a.img ?? null, subtype: null, folder: null,
        sort: Date.now(), description: String(a.description ?? "").slice(0, 20_000), docs
      };
      store.putPackEntries(pack._id, [e]);
      return { result: count, changes: [] };
    }

    case "delete":
      needUnlocked();
      store.deletePackEntries(pack._id, a.entryIds);
      return { result: a.entryIds.length, changes: [] };

    case "move": {
      needUnlocked();
      if (a.folder && !pack.folders.some(f => f._id === a.folder)) throw new Error("Pasta não existe");
      const moved = a.entryIds.map(entry).map(e => ({ ...e, folder: a.folder }));
      store.putPackEntries(pack._id, moved);
      return { result: moved.length, changes: [] };
    }
  }
  throw new Error("Ação desconhecida");
}

/** Number of entries per pack the user can see (for the sidebar). */
export function packCounts(world: World, user: UserDoc): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of world.all<CompendiumDoc>("Compendium")) if (user.role === "gm" || p.visibility === 1) out[p._id] = world.packs.packCount(p._id);
  return out;
}

