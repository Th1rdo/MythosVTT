import { game, toast } from "../game.ts";
import { h, pickFile, setChildren, upload } from "../dom.ts";
import { settings } from "../settings.ts";
import { closeWindow, openWindow, prompt } from "./windows.ts";

export type FileKind = "image" | "imagevideo" | "audio" | "video" | "pdf" | "any";

interface Listing {
  path: string;
  dirs: string[];
  files: { name: string; url: string; size: number; mtime: number }[];
}

const ACCEPT: Record<FileKind, string> = {
  image: "image/*", imagevideo: "image/*,video/webm,video/mp4", audio: ".mp3,.ogg,.oga,.opus,.flac,.aac,.wav,.webm,.m4a,audio/*",
  video: "video/webm,video/mp4,.m4v", pdf: "application/pdf,.pdf", any: "*/*"
};
const LAST_KEY = "mesa.filePicker";
let lastFolder: Record<string, string> = {};
try {
  lastFolder = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}");
} catch {
  // Not remembered in private mode.
}

const canBrowse = () => game.isGM || !!settings.get("core.playerBrowse");
const canUpload = () => game.isGM || !!settings.get("core.playerUpload");

/** The folder part of an /assets/… URL ("" for the root), when it's one of ours. */
function folderOf(url: string | null | undefined): string | null {
  const m = /^\/assets\/(.*)\/[^/]*$/.exec(url ?? "");
  return m ? decodeURIComponent(m[1]) : url?.startsWith("/assets/") ? "" : null;
}

const sizeLabel = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

/**
 * Pick a file from the world's assets (Foundry's FilePicker): folders, thumbnails, search, upload into
 * the current folder, new folder (GM), or type a URL. Resolves to the chosen path, or null.
 * Players who can't browse get a plain upload.
 */
export async function browseFiles(kind: FileKind, current?: string | null): Promise<string | null> {
  if (!canBrowse()) {
    if (!canUpload()) {
      toast("Não podes escolher nem carregar ficheiros (o mestre decide em Definições).", "warning");
      return null;
    }
    const file = await pickFile(ACCEPT[kind]);
    return file ? upload(file).catch(err => (toast(err.message, "error"), null)) : null;
  }
  return new Promise(resolve => {
    const key = `file-picker-${Math.random()}`;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
      closeWindow(key);
    };
    const body = openWindow(key, "Escolher ficheiro", { width: 680, onClose: () => finish(null) })!;
    let folder = folderOf(current) ?? lastFolder[kind] ?? "";
    let listing: Listing | null = null;
    let query = "";
    let thumbs = kind === "image" || kind === "imagevideo";
    let selected = current ?? "";
    const pathInput = h("input.grow", { value: selected, placeholder: "Caminho ou URL", oninput: (e: Event) => (selected = (e.target as HTMLInputElement).value) });

    const load = async (to: string) => {
      const res = await fetch(`/api/files?path=${encodeURIComponent(to)}&type=${kind}`);
      const json = await res.json();
      if (!res.ok) {
        if (to) return load(""); // a remembered folder that's gone
        toast(json.error ?? "Erro", "error");
        return;
      }
      listing = json;
      folder = json.path;
      lastFolder[kind] = folder;
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify(lastFolder));
      } catch {
        // ignore
      }
      render();
    };

    const render = () => {
      if (!listing) return;
      const crumbs = ["", ...folder.split("/").filter(Boolean)];
      const files = listing.files.filter(f => !query || f.name.toLowerCase().includes(query));
      const isImage = (n: string) => /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(n);
      setChildren(body,
        h("div.row.wrap.toolbar", null,
          h("nav.crumbs", null, crumbs.map((c, i) => {
            const to = crumbs.slice(1, i + 1).join("/");
            return h("button.link", { onclick: () => load(to) }, i === 0 ? h("i.fa-solid.fa-house") : c);
          }).flatMap((b, i) => (i ? [h("span.muted", null, "/"), b] : [b]))),
          h("span.grow"),
          h("input.dir-search", { type: "search", placeholder: "Procurar…", value: query, oninput: (e: Event) => { query = (e.target as HTMLInputElement).value.toLowerCase(); render(); } }),
          h("button.icon.small", { title: thumbs ? "Ver em lista" : "Ver miniaturas", onclick: () => { thumbs = !thumbs; render(); } },
            h("i", { className: thumbs ? "fa-solid fa-list" : "fa-solid fa-table-cells" })),
          game.isGM && h("button.small", {
            title: "Nova pasta aqui",
            onclick: async () => {
              const v = await prompt("Nova pasta", [{ name: "name", label: "Nome" }]);
              if (!v?.name.trim()) return;
              const res = await fetch("/api/files/folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: folder, name: v.name }) });
              const json = await res.json();
              if (!res.ok) return toast(json.error ?? "Erro", "error");
              load(json.path);
            }
          }, h("i.fa-solid.fa-folder-plus")),
          canUpload() && h("button.small", {
            title: "Carregar para esta pasta",
            onclick: async () => {
              const file = await pickFile(ACCEPT[kind]);
              if (!file) return;
              try {
                selected = await upload(file, folder);
                pathInput.value = selected;
                await load(folder);
              } catch (err) {
                toast((err as Error).message, "error");
              }
            }
          }, h("i.fa-solid.fa-upload"), " Carregar")),
        h("div", { className: `file-browser${thumbs ? " thumbs" : ""}` },
          listing.dirs.map(d => h("div.file-entry.dir", { onclick: () => load(folder ? `${folder}/${d}` : d) }, h("i.fa-solid.fa-folder"), h("span", null, d))),
          files.map(f => h("div", {
            className: `file-entry${f.url === selected ? " selected" : ""}`, title: `${f.name} · ${sizeLabel(f.size)}`,
            onclick: () => { selected = f.url; pathInput.value = f.url; render(); },
            ondblclick: () => finish(f.url)
          },
            thumbs && isImage(f.name) ? h("img", { src: f.url, loading: "lazy", alt: "" }) : h("i", { className: kindIcon(f.name) }),
            h("span", null, f.name))),
          !listing.dirs.length && !files.length ? h("p.muted", null, "Pasta vazia.") : null),
        h("div.row", null, pathInput,
          h("button", { onclick: () => finish(null) }, "Cancelar"),
          h("button.primary", { onclick: () => finish(selected.trim() || null) }, "Escolher")));
    };
    load(folder);
  });
}

function kindIcon(name: string): string {
  if (/\.(mp3|ogg|oga|opus|flac|aac|wav|m4a)$/i.test(name)) return "fa-solid fa-file-audio";
  if (/\.(webm|mp4|m4v)$/i.test(name)) return "fa-solid fa-file-video";
  if (/\.pdf$/i.test(name)) return "fa-solid fa-file-pdf";
  return "fa-solid fa-file-image";
}

/** A "browse" button for a path input: opens the picker and writes the choice into the input. */
export function browseButton(input: HTMLInputElement, kind: FileKind, onPick?: (path: string) => void): HTMLButtonElement {
  return h("button", {
    type: "button", title: "Escolher ficheiro",
    onclick: async () => {
      const v = await browseFiles(kind, input.value);
      if (v === null) return;
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      onPick?.(v);
    }
  }, h("i.fa-solid.fa-folder-open"));
}
