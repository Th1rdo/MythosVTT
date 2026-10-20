import type { BaseDoc, FolderDoc } from "../../../shared/protocol.ts";
import { game } from "../game.ts";
import { h } from "../dom.ts";
import { confirmDialog, prompt } from "./windows.ts";

type DirType = FolderDoc["type"];
const DOC_DRAG = "application/x-mesa-doc";
const FOLDER_DRAG = "application/x-mesa-folder";
const COLLAPSED_KEY = "mesa.collapsedFolders";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
const collapsed = loadCollapsed();
function saveCollapsed(): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
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
  sort?: (a: T, b: T) => number;
  empty: string;
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
  const sort = opts.sort ?? ((a: T, b: T) => a.name.localeCompare(b.name, "pt"));

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
    const docs = opts.docs();
    const folders = game.all<FolderDoc>("Folder").filter(f => f.type === opts.type);
    const childrenOf = (id: string | null) => folders.filter(f => (f.folder ?? null) === id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"));
    const docsIn = (id: string | null) => docs.filter(d => (d.folder ?? null) === id || (id === null && d.folder && !folders.some(f => f._id === d.folder))).sort(sort);
    const hasContent = (id: string): boolean => docsIn(id).length > 0 || childrenOf(id).some(f => hasContent(f._id));

    const entryRow = (d: T) => h("li", {
      className: ["entry", opts.rowClass?.(d)].filter(Boolean).join(" "),
      draggable: true,
      ondragstart: (e: DragEvent) => {
        e.dataTransfer?.setData(DOC_DRAG, JSON.stringify({ type: opts.type, id: d._id }));
        if (e.dataTransfer) opts.dragData?.(d, e.dataTransfer);
      },
      onclick: () => opts.onOpen(d)
    }, ...opts.entry(d).filter((n): n is Node => !!n));

    const folderNode = (f: FolderDoc, depth: number): HTMLElement | null => {
      if (!game.isGM && !hasContent(f._id)) return null;
      const open = !collapsed.has(f._id);
      const head = h("div.folder-head", {
        style: { borderLeftColor: f.color ?? "transparent" },
        draggable: game.isGM,
        ondragstart: (e: DragEvent) => e.dataTransfer?.setData(FOLDER_DRAG, f._id),
        onclick: () => {
          if (open) collapsed.add(f._id);
          else collapsed.delete(f._id);
          saveCollapsed();
          render();
        }
      },
        h("span.chevron", null, open ? "▾" : "▸"),
        h("span.grow", null, "📁 ", f.name),
        game.isGM && h("button.icon.small", {
          title: "Nova subpasta",
          onclick: (e: Event) => { e.stopPropagation(); createFolder(opts.type, f._id); }
        }, "＋"),
        game.isGM && h("button.icon.small", {
          title: "Editar pasta",
          onclick: async (e: Event) => {
            e.stopPropagation();
            const v = await prompt("Pasta", [{ name: "name", label: "Nome", value: f.name }, { name: "color", label: "Cor", value: f.color ?? "#555555", type: "color" }]);
            if (v) game.update("Folder", { _id: f._id, name: v.name.trim() || f.name, color: v.color });
          }
        }, "✎"),
        game.isGM && h("button.icon.small", {
          title: "Apagar pasta (o conteúdo sobe um nível)",
          onclick: async (e: Event) => {
            e.stopPropagation();
            if (await confirmDialog(`Apagar a pasta "${f.name}"? O conteúdo fica na pasta de cima.`)) game.delete("Folder", f._id);
          }
        }, "✕")
      );
      acceptDrop(head, f._id);
      const inner = h("ul.doc-list");
      if (open) {
        inner.append(...childrenOf(f._id).map(c => folderNode(c, depth + 1)).filter((n): n is HTMLElement => !!n));
        inner.append(...docsIn(f._id).map(entryRow));
      }
      return h("li.folder", { style: { paddingLeft: depth ? "12px" : "0" } }, head, inner);
    };

    const top = [
      ...childrenOf(null).map(f => folderNode(f, 0)).filter((n): n is HTMLElement => !!n),
      ...docsIn(null).map(entryRow)
    ];
    list.replaceChildren(...top);
    if (!top.length) list.append(h("li.muted", null, opts.empty));
  };

  for (const t of [opts.type, "Folder"] as const) game.on(t, render);
  game.on("ready", render);
  render();
  return { element: list, render };
}

export async function createFolder(type: DirType, parent: string | null = null): Promise<void> {
  const v = await prompt("Nova pasta", [{ name: "name", label: "Nome" }]);
  if (v?.name.trim()) await game.create("Folder", { name: v.name.trim(), type, folder: parent, sort: Date.now() });
}
