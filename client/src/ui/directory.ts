import type { BaseDoc, FolderDoc } from "../../../shared/protocol.ts";
import { game } from "../game.ts";
import { h } from "../dom.ts";
import { confirmDialog, prompt } from "./windows.ts";
import type { ContextEntry } from "./context-menu.ts";
import { bindContextMenu } from "./context-menu.ts";
import type { OwnedType } from "./sheet.ts";
import { deleteDoc, duplicateDoc, exportDoc, importDoc, openOwnership } from "./doc-actions.ts";
import { t } from "../i18n.ts";

type DirType = FolderDoc["type"];
const DOC_DRAG = "application/x-mesa-doc";
const FOLDER_DRAG = "application/x-mesa-folder";
/** Open folders (Foundry starts every folder closed). */
const COLLAPSED_KEY = "mesa.expandedFolders";
/** Foundry allows folders four levels deep. */
const MAX_DEPTH = 4;
/** "Procurar atores" etc. */
const SEARCH_LABELS: Partial<Record<DirType, string>> = {
  Actor: "Procurar atores", Item: "Procurar itens", Scene: "Procurar cenas", JournalEntry: "Procurar entradas",
  RollTable: "Procurar tabelas", Macro: "Procurar macros", Playlist: "Procurar playlists", Cards: "Procurar cartas"
};
const FULL_TEXT_KEY = "mesa.directoryFullText";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
const expanded = loadCollapsed();
function saveCollapsed(): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...expanded]));
  } catch {
    // Private mode etc.: collapse state just isn't remembered.
  }
}

export interface DirectoryOptions<T extends BaseDoc> {
  type: DirType;
  /** Documents shown at the top level of the directory (world-level ones). */
  docs: () => T[];
  /** Content of one entry row (the <li> is provided). */
  entry: (doc: T) => (Node | null | false)[];
  onOpen: (doc: T) => void;
  /** Extra drag data for an entry (e.g. actors can be dropped on the canvas). */
  dragData?: (doc: T, dt: DataTransfer) => void;
  /** Extra class for the entry row. */
  rowClass?: (doc: T) => string;
  /** Manual order (e.g. scene sort); the header's sort button toggles between this and A→Z. */
  sort?: (a: T, b: T) => number;
  empty: string;
  /** "Create X" button in the header (GM, or everyone with `everyone`); `folder` when created from a folder's menu. */
  create?: { label: string; icon: string; run: (folder?: string | null) => void; everyone?: boolean };
  /** Entries of this type's right-click menu, before the common ones (open, ownership, duplicate, export, delete). */
  contextOptions?: (doc: T) => ContextEntry<T>[];
  /** Has per-user ownership (adds "Permissões" to the menu). */
  ownership?: boolean;
  /** Who may use the common entries (default: the GM). */
  canManage?: (doc: T) => boolean;
  /** Image used as a banner background for the row (scene thumbnails). */
  banner?: (doc: T) => string | null;
}

/**
 * A document directory with folders, like Foundry's sidebar directories. Folders nest; GMs create,
 * rename, colour and delete them and drag entries or folders into them (drop on the list's empty
 * area to move to the top level). Players only see folders that contain something they can see.
 */
export function directory<T extends BaseDoc & { name: string; folder?: string | null }>(opts: DirectoryOptions<T>): {
  element: HTMLElement;
  render: () => void;
} {
  const list = h("ul.doc-list.directory");
  const alpha = (a: T, b: T) => a.name.localeCompare(b.name, "pt");
  let alphabetical = !opts.sort;
  let query = "";
  // Foundry's two search modes: the name only, or every text the document holds.
  let fullText = (() => { try { return localStorage.getItem(FULL_TEXT_KEY) === "1"; } catch { return false; } })();
  const sortFn = () => (alphabetical ? alpha : opts.sort ?? alpha);
  const fold = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt");
  const matches = (d: T) => {
    if (!query) return true;
    const q = fold(query);
    return fold(d.name).includes(q) || (fullText && fold(JSON.stringify(d)).includes(q));
  };

  const searchMode = h("button.icon.search-mode", {
    onclick: () => {
      fullText = !fullText;
      try { localStorage.setItem(FULL_TEXT_KEY, fullText ? "1" : "0"); } catch { /* not remembered */ }
      paintMode();
      render();
    }
  });
  const paintMode = () => {
    searchMode.title = fullText ? t("Procurar em todo o texto (clicar: só o nome)") : t("Procurar só no nome (clicar: em todo o texto)");
    searchMode.replaceChildren(h("i", { className: fullText ? "fa-solid fa-file-magnifying-glass" : "fa-solid fa-magnifying-glass" }));
  };
  paintMode();
  const search = h("input.dir-search", {
    type: "search", placeholder: t(SEARCH_LABELS[opts.type] ?? "Procurar…"),
    oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value.trim().toLocaleLowerCase("pt");
      render();
    }
  });
  const sortBtn = h("button.icon", { onclick: () => { alphabetical = !alphabetical; render(); } });
  const header = h("header.dir-header", null,
    (game.isGM || opts.create?.everyone) && h("div.dir-create", null,
      opts.create && h("button", { onclick: () => opts.create!.run() }, h("i", { className: opts.create.icon }), " ", t(opts.create.label)),
      game.isGM && h("button", { onclick: () => createFolder(opts.type) }, h("i.fa-solid.fa-folder"), " ", t("Criar pasta"))),
    h("div.dir-search-row", null,
      searchMode,
      search,
      opts.sort ? sortBtn : null,
      h("button.icon", {
        title: t("Fechar todas as pastas"),
        onclick: () => {
          for (const f of game.all<FolderDoc>("Folder")) if (f.type === opts.type) expanded.delete(f._id);
          saveCollapsed();
          render();
        }
      }, h("i.fa-solid.fa-folder-tree")))
  );

  const moveTo = async (e: DragEvent, folderId: string | null) => {
    if (!game.isGM) return;
    const doc = e.dataTransfer?.getData(DOC_DRAG);
    const folder = e.dataTransfer?.getData(FOLDER_DRAG);
    if (doc) {
      const { type, id } = JSON.parse(doc) as { type: string; id: string };
      if (type !== opts.type) return;
      e.preventDefault();
      e.stopPropagation();
      await game.update(opts.type, { _id: id, folder: folderId });
    } else if (folder) {
      e.preventDefault();
      e.stopPropagation();
      // Don't drop a folder into itself or one of its descendants.
      for (let f: string | null = folderId; f; f = game.get<FolderDoc>("Folder", f)?.folder ?? null) if (f === folder) return;
      await game.update("Folder", { _id: folder, folder: folderId });
    }
  };
  const acceptDrop = (el: HTMLElement, folderId: string | null) => {
    el.addEventListener("dragover", e => {
      if (game.isGM && (e.dataTransfer?.types.includes(DOC_DRAG) || e.dataTransfer?.types.includes(FOLDER_DRAG))) {
        e.preventDefault();
        el.classList.add("drop-target");
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", e => {
      el.classList.remove("drop-target");
      moveTo(e, folderId);
    });
  };
  acceptDrop(list, null);

  const render = () => {
    sortBtn.title = alphabetical ? "Ordem: A→Z (clicar para manual)" : "Ordem: manual (clicar para A→Z)";
    sortBtn.replaceChildren(h("i", { className: alphabetical ? "fa-solid fa-arrow-down-a-z" : "fa-solid fa-sort" }));
    const docs = opts.docs().filter(matches);
    const folders = game.all<FolderDoc>("Folder").filter(f => f.type === opts.type);
    const childrenOf = (id: string | null) => folders.filter(f => (f.folder ?? null) === id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"));
    const docsIn = (id: string | null) => docs.filter(d => (d.folder ?? null) === id || (id === null && d.folder && !folders.some(f => f._id === d.folder))).sort(sortFn());
    const hasContent = (id: string): boolean => docsIn(id).length > 0 || childrenOf(id).some(f => hasContent(f._id));
    // While searching, folders open up and empty ones hide.
    const searching = !!query;

    const entryRow = (d: T) => h("li", {
      dataset: { id: d._id },
      className: ["entry", opts.rowClass?.(d), opts.banner && "banner"].filter(Boolean).join(" "),
      style: opts.banner?.(d) ? { backgroundImage: `linear-gradient(rgba(0,0,0,.35), rgba(0,0,0,.35)), url("${opts.banner(d)}")` } : undefined,
      draggable: true,
      ondragstart: (e: DragEvent) => {
        e.dataTransfer?.setData(DOC_DRAG, JSON.stringify({ type: opts.type, id: d._id }));
        if (e.dataTransfer) opts.dragData?.(d, e.dataTransfer);
      },
      onclick: () => opts.onOpen(d)
    }, ...opts.entry(d).filter((n): n is Node => !!n));

    const folderNode = (f: FolderDoc, depth: number): HTMLElement | null => {
      if ((!game.isGM || searching) && !hasContent(f._id)) return null;
      const open = searching || expanded.has(f._id);
      const head = h("header.folder-head", {
        dataset: { folder: f._id },
        className: `folder-head${f.color ? " coloured" : ""}`,
        style: f.color ? { backgroundColor: f.color } : undefined,
        draggable: game.isGM,
        ondragstart: (e: DragEvent) => e.dataTransfer?.setData(FOLDER_DRAG, f._id),
        onclick: () => {
          if (open) expanded.delete(f._id);
          else expanded.add(f._id);
          saveCollapsed();
          render();
        }
      },
        h("i", { className: `fa-solid ${open ? "fa-folder-open" : "fa-folder"} fa-fw` }),
        h("span.folder-name", null, f.name),
        // Foundry's folder buttons: a subfolder (while depth allows) and a new entry inside.
        game.isGM && depth + 1 < MAX_DEPTH && h("button.icon.folder-create", {
          title: t("Criar subpasta"), onclick: (e: Event) => { e.stopPropagation(); createFolder(opts.type, f._id); }
        }, h("i.fa-solid.fa-folder-plus")),
        (game.isGM || opts.create?.everyone) && opts.create && h("button.icon.folder-create", {
          title: t(opts.create.label), onclick: (e: Event) => { e.stopPropagation(); expanded.add(f._id); saveCollapsed(); opts.create!.run(f._id); }
        }, h("i", { className: opts.create.icon }), h("i.fa-solid.fa-plus.plus-badge"))
      );
      acceptDrop(head, f._id);
      const inner = h("ul.doc-list.subdirectory", { style: f.color ? { borderLeftColor: f.color } : undefined });
      if (open) {
        inner.append(...childrenOf(f._id).map(c => folderNode(c, depth + 1)).filter((n): n is HTMLElement => !!n));
        inner.append(...docsIn(f._id).map(entryRow));
      }
      return h("li", { className: `folder${open ? " expanded" : ""}`, dataset: { depth: String(depth) } }, head, inner);
    };

    const top = [
      ...childrenOf(null).map(f => folderNode(f, 0)).filter((n): n is HTMLElement => !!n),
      ...docsIn(null).map(entryRow)
    ];
    list.replaceChildren(...top);
    if (!top.length) list.append(h("li.muted", null, opts.empty));
  };

  // ---- Right-click menus (Foundry's directory context options)
  const manage = (d: T) => opts.canManage?.(d) ?? game.isGM;
  const docOf = (el: HTMLElement) => game.get<T>(opts.type, el.dataset.id);
  bindContextMenu(list, "li.entry[data-id]", el => {
    const d = docOf(el);
    if (!d) return [];
    const common: ContextEntry<T>[] = [
      { label: "Abrir", icon: "fa-solid fa-folder-open", onClick: () => opts.onOpen(d) },
      { label: "Permissões", icon: "fa-solid fa-lock", group: "manage", visible: !!opts.ownership && game.isGM,
        onClick: () => openOwnership(opts.type as OwnedType, d._id) },
      { label: "Duplicar", icon: "fa-regular fa-copy", group: "manage", visible: manage(d), onClick: () => duplicateDoc(opts.type, d._id) },
      { label: "Exportar dados", icon: "fa-solid fa-file-export", group: "data", visible: manage(d), onClick: () => exportDoc(opts.type, d._id) },
      { label: "Importar dados", icon: "fa-solid fa-file-import", group: "data", visible: manage(d), onClick: () => importDoc(opts.type, d._id) },
      { label: "Apagar", icon: "fa-solid fa-trash", group: "delete", classes: "danger", visible: manage(d), onClick: () => deleteDoc(opts.type, d._id) }
    ];
    const extra = opts.contextOptions?.(d) ?? [];
    const wrap = (x: ContextEntry<T>): ContextEntry<HTMLElement> => ({ ...x, visible: typeof x.visible === "function" ? () => (x.visible as (t: T) => boolean)(d) : x.visible, onClick: () => x.onClick(d) });
    return [...[common[0], ...extra, ...common.slice(1)].map(wrap)];
  }, opts.type);

  bindContextMenu(list, ".folder-head[data-folder]", el => {
    const f = game.get<FolderDoc>("Folder", el.dataset.folder);
    if (!f || !game.isGM) return [];
    const docsInside = (id: string): string[] => [
      ...opts.docs().filter(d => d.folder === id).map(d => d._id),
      ...game.all<FolderDoc>("Folder").filter(x => x.folder === id).flatMap(x => docsInside(x._id))
    ];
    const foldersInside = (id: string): string[] => game.all<FolderDoc>("Folder").filter(x => x.folder === id).flatMap(x => [x._id, ...foldersInside(x._id)]);
    return [
      { label: "Editar pasta", icon: "fa-solid fa-pen-to-square", onClick: async () => {
        const v = await prompt(t("Pasta"), [{ name: "name", label: t("Nome"), value: f.name }, { name: "color", label: t("Cor"), value: f.color ?? "#555555", type: "color" }]);
        if (v) game.update("Folder", { _id: f._id, name: v.name.trim() || f.name, color: v.color });
      } },
      { label: "Criar subpasta", icon: "fa-solid fa-folder-plus", onClick: () => createFolder(opts.type, f._id) },
      ...(opts.create ? [{ label: opts.create.label, icon: opts.create.icon, onClick: () => opts.create!.run(f._id) }] : []),
      { label: "Remover pasta", icon: "fa-solid fa-folder-minus", group: "delete", onClick: async () => {
        if (await confirmDialog(t("Remover a pasta «{nome}»? O conteúdo fica na pasta de cima.", { nome: f.name }), t("Remover"))) game.delete("Folder", f._id);
      } },
      { label: "Apagar tudo", icon: "fa-solid fa-dumpster", group: "delete", classes: "danger", onClick: async () => {
        const docs = docsInside(f._id);
        if (!(await confirmDialog(t("Apagar a pasta «{nome}», as subpastas e os {n} documentos lá dentro? Isto não se pode desfazer.", { nome: f.name, n: docs.length })))) return;
        if (docs.length) await game.delete(opts.type, docs);
        await game.delete("Folder", [...foldersInside(f._id).reverse(), f._id]);
      } }
    ];
  }, "Folder");

  for (const t of [opts.type, "Folder"] as const) game.on(t, render);
  game.on("ready", render);
  render();
  return { element: h("div.directory-wrap", null, header, list), render };
}

export async function createFolder(type: DirType, parent: string | null = null): Promise<void> {
  const v = await prompt(t("Nova pasta"), [{ name: "name", label: t("Nome") }, { name: "color", label: t("Cor"), value: "#4a3a63", type: "color" }]);
  if (v?.name.trim()) await game.create("Folder", { name: v.name.trim(), type, folder: parent, color: v.color || null, sort: Date.now() });
}
