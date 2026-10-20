import type {
  ActorDoc, BaseDoc, CompendiumDoc, DocType, FolderDoc, ItemDoc, JournalEntryPageDoc, MacroDoc, PackAction, PackEntry, PackIndexEntry, PackType,
  PlaylistSoundDoc, SceneDoc, TableResultDoc
} from "../../../shared/protocol.ts";
import { PACK_TYPES } from "../../../shared/protocol.ts";
import { ITEM_TYPES } from "../../../shared/ordem.ts";
import { game, toast } from "../game.ts";
import { avatar, h, setChildren } from "../dom.ts";
import { enrich, markdown } from "../enrich.ts";
import { closeWindow, confirmDialog, openWindow, setWindowTitle } from "./windows.ts";

export const PACK_DRAG = "application/x-mesa-pack";
const DOC_DRAG = "application/x-mesa-doc";

export const PACK_LABELS: Record<PackType, [string, string]> = {
  Actor: ["Atores", "fa-solid fa-user"], Item: ["Itens", "fa-solid fa-suitcase"], JournalEntry: ["Diário", "fa-solid fa-book-open"],
  RollTable: ["Tabelas", "fa-solid fa-table-list"], Macro: ["Macros", "fa-solid fa-code"], Playlist: ["Playlists", "fa-solid fa-music"],
  Scene: ["Cenas", "fa-solid fa-map"], Adventure: ["Aventuras", "fa-solid fa-dungeon"]
};
const FOLDER_TYPES = new Set<PackType>(["Actor", "Item", "JournalEntry", "RollTable", "Macro", "Playlist", "Scene"]);

export async function packAction<T = unknown>(action: PackAction): Promise<T | undefined> {
  const res = await game.socket.timeout(30_000).emitWithAck("pack", action);
  if (!res.ok) {
    toast(res.error, "error");
    return undefined;
  }
  return res.result as T;
}

const subtypeLabel = (t: string | null) => (t ? ITEM_TYPES.find(([k]) => k === t)?.[1] ?? t : "");

export function compendiaPanel(): HTMLElement {
  const list = h("div.pack-list");
  let counts: Record<string, number> = {};
  const render = () => {
    const packs = game.all<CompendiumDoc>("Compendium");
    const byType = PACK_TYPES.map(t => [t, packs.filter(p => p.type === t).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"))] as const)
      .filter(([, l]) => l.length);
    setChildren(list,
      !packs.length ? h("p.muted", null, game.isGM ? "Sem compêndios. Cria um, ou importa os do sistema com npm run import-packs." : "O mestre ainda não partilhou compêndios.") : null,
      byType.map(([type, ps]) => h("section.pack-group", null,
        h("h4", null, h("i", { className: PACK_LABELS[type][1] }), " ", PACK_LABELS[type][0]),
        h("ul.doc-list", null, ps.map(p => h("li.entry", { onclick: () => openPack(p._id) },
          h("span.grow", null, p.name),
          p.source ? h("span.tag", { title: `Vem de ${p.source}` }, p.source) : null,
          h("span.muted.small", null, String(counts[p._id] ?? "…")),
          game.isGM ? h("i", { className: p.visibility ? "fa-solid fa-eye" : "fa-solid fa-eye-slash", title: p.visibility ? "Os jogadores veem" : "Só o mestre" }) : null,
          p.locked ? h("i.fa-solid.fa-lock", { title: "Trancado" }) : null
        ))))));
  };
  const refresh = async () => {
    counts = await game.socket.timeout(10_000).emitWithAck("packCounts").catch(() => counts);
    render();
  };
  game.on("Compendium", refresh);
  game.socket.on("packChanged", refresh);
  refresh();
  return h("div.panel", null,
    game.isGM ? h("div.dir-create", null, h("button", { onclick: createPack }, h("i.fa-solid.fa-book-atlas"), " Criar compêndio")) : null,
    list);
}

function createPack(): void {
  const key = "pack-new";
  const body = openWindow(key, "Novo compêndio", { width: 340 });
  if (!body) return;
  const name = h("input", { placeholder: "Nome" });
  const type = h("select", null, PACK_TYPES.filter(t => t !== "Scene").map(t => h("option", { value: t }, PACK_LABELS[t][0])));
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      await game.create("Compendium", { name: name.value.trim(), type: type.value, sort: Date.now() });
      closeWindow(key);
    }
  }, h("label.field", null, h("span", null, "Nome"), name), h("label.field", null, h("span", null, "Guarda"), type),
    h("div.row.end", null, h("button.primary", { type: "submit" }, "Criar"))));
  name.focus();
}

/** A pack's contents: search, folders, preview, import; GMs drop sidebar documents in to add them. */
export function openPack(packId: string): void {
  const key = `pack-${packId}`;
  const offs: (() => void)[] = [];
  const pack0 = game.get<CompendiumDoc>("Compendium", packId);
  const body = openWindow(key, pack0?.name ?? "Compêndio", { width: 560, onClose: () => offs.forEach(f => f()) });
  if (!body) return;
  let index: PackIndexEntry[] = [];
  let query = "";
  const open = new Set<string>();
  const list = h("ul.doc-list.pack-entries");
  const search = h("input.dir-search", {
    type: "search", placeholder: "Procurar…",
    oninput: (e: Event) => { query = (e.target as HTMLInputElement).value.trim().toLocaleLowerCase("pt"); renderList(); }
  });

  const load = async () => {
    index = (await packAction<PackIndexEntry[]>({ action: "index", packId })) ?? [];
    render();
  };

  const entryRow = (pack: CompendiumDoc, e: PackIndexEntry) => h("li.entry", {
    draggable: true,
    ondragstart: (ev: DragEvent) => ev.dataTransfer?.setData(PACK_DRAG, JSON.stringify({ packId, entryId: e._id, type: pack.type })),
    onclick: () => previewEntry(packId, e._id)
  },
    avatar(e.img, e.name, 32),
    h("span.grow", null, e.name),
    e.subtype ? h("span.muted.small", null, subtypeLabel(e.subtype)) : null,
    game.isGM && h("button.icon.small", {
      title: pack.type === "Adventure" ? "Importar aventura" : "Importar para o mundo",
      onclick: (ev: Event) => { ev.stopPropagation(); importEntries(pack, [e._id]); }
    }, h("i.fa-solid.fa-file-import")),
    game.isGM && !pack.locked && h("button.icon.small", {
      title: "Apagar do compêndio",
      onclick: async (ev: Event) => {
        ev.stopPropagation();
        if (await confirmDialog(`Apagar "${e.name}" do compêndio?`)) packAction({ action: "delete", packId, entryIds: [e._id] });
      }
    }, "✕"));

  const renderList = () => {
    const pack = game.get<CompendiumDoc>("Compendium", packId);
    if (!pack) return;
    const matches = index.filter(e => !query || e.name.toLocaleLowerCase("pt").includes(query) || (e.subtype ?? "").toLowerCase().includes(query));
    const folderIds = new Set(pack.folders.map(f => f._id));
    const folderNode = (f: CompendiumDoc["folders"][number]): HTMLElement | null => {
      const inside = matches.filter(e => e.folder === f._id);
      const subs = pack.folders.filter(x => x.folder === f._id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt")).map(folderNode).filter(Boolean) as HTMLElement[];
      if (!inside.length && !subs.length) return null;
      const isOpen = !!query || open.has(f._id);
      return h("li.folder", null,
        h("div.folder-head", { style: { borderLeftColor: f.color ?? "transparent" }, onclick: () => { isOpen ? open.delete(f._id) : open.add(f._id); renderList(); } },
          h("span.chevron", null, isOpen ? "▾" : "▸"), h("span.grow", null, "📁 ", f.name), h("span.muted.small", null, String(inside.length))),
        isOpen ? h("ul.doc-list", null, subs, inside.map(e => entryRow(pack, e))) : null);
    };
    setChildren(list,
      pack.folders.filter(f => !f.folder || !folderIds.has(f.folder)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt")).map(folderNode),
      matches.filter(e => !e.folder || !folderIds.has(e.folder)).map(e => entryRow(pack, e)),
      !matches.length ? h("li.muted", null, index.length ? "Nada encontrado." : "Vazio.") : null);
  };

  const render = () => {
    const pack = game.get<CompendiumDoc>("Compendium", packId);
    if (!pack) return closeWindow(key);
    setWindowTitle(key, pack.name);
    const canChange = game.isGM && !pack.locked;
    const toggle = (data: Partial<CompendiumDoc>) => game.update("Compendium", { _id: packId, ...data });
    setChildren(body,
      h("div.row.wrap.toolbar", null,
        h("span.muted.small", null, `${PACK_LABELS[pack.type][0]} · ${index.length} entradas${pack.source ? ` · ${pack.source}` : ""}`),
        h("span.grow"),
        game.isGM && FOLDER_TYPES.has(pack.type) && index.length ? h("button.small", { onclick: () => importEntries(pack, index.map(e => e._id), true) }, h("i.fa-solid.fa-file-import"), " Importar tudo") : null,
        canChange && pack.type === "Adventure" ? h("button.small", { onclick: () => createAdventure(packId) }, h("i.fa-solid.fa-plus"), " Criar aventura") : null,
        game.isGM && h("button.small", { title: pack.visibility ? "Esconder dos jogadores" : "Mostrar aos jogadores", onclick: () => toggle({ visibility: pack.visibility ? 0 : 1 }) },
          h("i", { className: pack.visibility ? "fa-solid fa-eye" : "fa-solid fa-eye-slash" })),
        game.isGM && h("button.small", { title: pack.locked ? "Destrancar (permite mudar o conteúdo)" : "Trancar", onclick: () => toggle({ locked: !pack.locked }) },
          h("i", { className: pack.locked ? "fa-solid fa-lock" : "fa-solid fa-lock-open" })),
        canChange && h("button.small.danger", {
          title: "Apagar o compêndio",
          onclick: async () => { if (await confirmDialog(`Apagar o compêndio "${pack.name}" e tudo o que tem?`)) game.delete("Compendium", packId); }
        }, h("i.fa-solid.fa-trash"))),
      h("div.dir-search-row", null, h("i.fa-solid.fa-magnifying-glass"), search),
      canChange && pack.type !== "Adventure" ? h("p.muted.small.drop-hint", null, `Arrasta ${PACK_LABELS[pack.type][0].toLowerCase()} da barra lateral para aqui para os guardar.`) : null,
      list);
    renderList();
  };

  // GM: drop world documents in to store them.
  body.addEventListener("dragover", e => {
    const pack = game.get<CompendiumDoc>("Compendium", packId);
    if (game.isGM && pack && !pack.locked && e.dataTransfer?.types.includes(DOC_DRAG)) e.preventDefault();
  });
  body.addEventListener("drop", async e => {
    const raw = e.dataTransfer?.getData(DOC_DRAG);
    const pack = game.get<CompendiumDoc>("Compendium", packId);
    if (!raw || !pack || pack.locked || !game.isGM) return;
    e.preventDefault();
    const { type, id } = JSON.parse(raw) as { type: DocType; id: string };
    if (type !== pack.type) return toast(`Este compêndio guarda ${PACK_LABELS[pack.type][0].toLowerCase()}`, "error");
    const n = await packAction<number>({ action: "export", packId, docs: [{ type, id }] });
    if (n) toast("Guardado no compêndio");
  });
  offs.push(game.on("Compendium", e => e.ids.includes(packId) && (e.op === "delete" ? closeWindow(key) : render())));
  const onChanged = (id: string) => id === packId && load();
  game.socket.on("packChanged", onChanged);
  offs.push(() => game.socket.off("packChanged", onChanged));
  render();
  load();
}

async function importEntries(pack: CompendiumDoc, ids: string[], all = false): Promise<void> {
  let folder: string | null = null;
  if (pack.type === "Adventure") {
    // Adventures keep their ids: ask before replacing what's already in the world.
    const entries = (await Promise.all(ids.map(id => packAction<PackEntry>({ action: "get", packId: pack._id, entryId: id })))).filter(Boolean) as PackEntry[];
    const existing = entries.flatMap(e => Object.entries(e.docs).flatMap(([t, l]) => (l ?? []).filter(d => game.get(t as DocType, d._id))));
    let overwrite = false;
    if (existing.length) {
      overwrite = await confirmDialog(`${existing.length} documento(s) desta aventura já existem no mundo. Substituí-los pela versão da aventura?`, "Substituir");
    }
    const n = await packAction<number>({ action: "import", packId: pack._id, entryIds: ids, overwrite });
    if (n !== undefined) toast(`Aventura importada (${n} documentos)`);
    return;
  }
  if (all) {
    if (!(await confirmDialog(`Importar as ${ids.length} entradas de "${pack.name}" para uma pasta nova?`, "Importar"))) return;
    const [f] = await game.create<FolderDoc>("Folder", { name: pack.name, type: pack.type as FolderDoc["type"], sort: Date.now() });
    folder = f?._id ?? null;
  }
  const n = await packAction<number>({ action: "import", packId: pack._id, entryIds: ids, folder });
  if (n) toast(n === 1 ? "Importado para o mundo" : `${n} importados para o mundo`);
}

/** Read-only look at one entry, with import buttons. */
export async function previewEntry(packId: string, entryId: string): Promise<void> {
  const key = `pack-entry-${packId}-${entryId}`;
  const pack = game.get<CompendiumDoc>("Compendium", packId);
  if (!pack) return;
  const body = openWindow(key, "…", { width: 520 });
  if (!body) return;
  const e = await packAction<PackEntry>({ action: "get", packId, entryId });
  if (!e) return closeWindow(key);
  setWindowTitle(key, e.name);
  const root = e.docs[pack.type as DocType]?.[0] as (BaseDoc & Record<string, any>) | undefined;
  const of = <T extends BaseDoc>(t: DocType) => (e.docs[t] ?? []) as T[];
  let content: (Node | null)[] = [];
  switch (pack.type) {
    case "Item": {
      const item = root as ItemDoc;
      content = [h("div.prose", null, enrich(String(item?.system?.description ?? "")))];
      break;
    }
    case "Actor":
      content = [h("p.muted", null, (root as ActorDoc)?.type ?? ""), h("ul.doc-list", null, of<ItemDoc>("Item").map(i => h("li", null, avatar(i.img, i.name, 24), i.name)))];
      break;
    case "JournalEntry":
      content = of<JournalEntryPageDoc>("JournalEntryPage").sort((a, b) => a.sort - b.sort).map(p => h("article.journal-page", null, h("h3", null, p.name),
        p.type === "text" ? h("div.prose", null, enrich(p.text.format === 2 ? markdown(p.text.markdown) : p.text.content))
          : p.type === "image" && p.src ? h("img", { src: p.src, style: { maxWidth: "100%" } }) : h("p.muted", null, p.type)));
      break;
    case "RollTable":
      content = [root?.description ? h("div.prose", null, enrich(root.description)) : null, h("table.table-results", null, h("tbody", null,
        of<TableResultDoc>("TableResult").sort((a, b) => a.range[0] - b.range[0]).map(r => h("tr", null, h("td.range", null, r.range[0] === r.range[1] ? String(r.range[0]) : `${r.range[0]}–${r.range[1]}`), h("td", null, r.name))))),
        root?.formula ? h("p.muted.small", null, `Fórmula: ${root.formula}`) : null];
      break;
    case "Macro":
      content = [h("pre.macro-preview", null, (root as MacroDoc)?.command ?? "")];
      break;
    case "Playlist":
      content = [h("ul.doc-list", null, of<PlaylistSoundDoc>("PlaylistSound").map(s => h("li", null, h("i.fa-solid.fa-music"), " ", s.name)))];
      break;
    case "Scene":
      content = [(root as SceneDoc)?.img ? h("img", { src: (root as SceneDoc).img!, style: { maxWidth: "100%" } }) : null];
      break;
    case "Adventure":
      content = [e.description ? h("div.prose", null, enrich(e.description)) : null,
        h("ul.adventure-contents", null, (Object.entries(e.docs) as [DocType, BaseDoc[]][]).filter(([t]) => PACK_TYPES.includes(t as PackType) || t === "Folder")
          .map(([t, l]) => h("li", null, h("strong", null, `${PACK_LABELS[t as PackType]?.[0] ?? "Pastas"}: `), l.map(d => (d as { name?: string }).name ?? "?").join(", "))))];
      break;
  }
  const character = game.get<ActorDoc>("Actor", game.user.character);
  setChildren(body,
    h("div.row", null, avatar(e.img, e.name, 64), h("div.stack.grow", null, h("h3", null, e.name), e.subtype ? h("span.muted", null, subtypeLabel(e.subtype)) : null)),
    ...content,
    h("div.row.end", null,
      pack.type === "Item" && character && game.owns(character)
        ? h("button", { onclick: async () => { if (await packAction({ action: "importToActor", packId, entryId, actorId: character._id }) !== undefined) toast(`${e.name} dado a ${character.name}`); } },
          h("i.fa-solid.fa-user-plus"), ` Dar a ${character.name}`) : null,
      game.isGM ? h("button.primary", { onclick: () => importEntries(pack, [entryId]) }, h("i.fa-solid.fa-file-import"), pack.type === "Adventure" ? " Importar aventura" : " Importar para o mundo") : null));
}

/** GM: bundle folders (and scenes) of the world into an adventure. */
function createAdventure(packId: string): void {
  const key = `adventure-new-${packId}`;
  const body = openWindow(key, "Nova aventura", { width: 480 });
  if (!body) return;
  const name = h("input", { placeholder: "Nome da aventura" });
  const description = h("textarea", { rows: 3, placeholder: "Descrição" });
  const folders = game.all<FolderDoc>("Folder").filter(f => !f.folder).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "pt"));
  const folderBoxes = folders.map(f => [f._id, h("input", { type: "checkbox" })] as const);
  const scenes = game.all<SceneDoc>("Scene").filter(s => !s.folder).sort((a, b) => a.name.localeCompare(b.name, "pt"));
  const sceneBoxes = scenes.map(s => [s._id, h("input", { type: "checkbox" })] as const);
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const chosenFolders = folderBoxes.filter(([, b]) => b.checked).map(([id]) => id);
      const chosenScenes = sceneBoxes.filter(([, b]) => b.checked).map(([id]) => ({ type: "Scene" as const, id }));
      const n = await packAction<number>({ action: "exportAdventure", packId, name: name.value.trim() || "Aventura", description: description.value, folders: chosenFolders, docs: chosenScenes });
      if (n) {
        toast(`Aventura criada com ${n} documentos`);
        closeWindow(key);
      }
    }
  },
    h("label.field", null, h("span", null, "Nome"), name),
    h("label.field", null, h("span", null, "Descrição"), description),
    h("div.field", null, h("span", null, "Pastas (com tudo o que têm dentro)"),
      folders.length ? h("div.check-list", null, folders.map((f, i) => h("label.row", null, folderBoxes[i][1], `${f.name} `, h("span.muted.small", null, `(${f.type})`)))) : h("p.muted.small", null, "Sem pastas.")),
    h("div.field", null, h("span", null, "Cenas fora de pastas"),
      scenes.length ? h("div.check-list", null, scenes.map((s, i) => h("label.row", null, sceneBoxes[i][1], s.name))) : h("p.muted.small", null, "Nenhuma.")),
    h("div.row.end", null, h("button.primary", { type: "submit" }, "Criar aventura"))));
}
