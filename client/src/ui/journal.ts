import type { JournalEntryDoc, JournalEntryPageDoc, PageType, ShareImageEvent, UserDoc } from "../../../shared/protocol.ts";
import { OWNERSHIP, PAGE_FORMAT } from "../../../shared/protocol.ts";
import { ownershipLevel, pageLevel } from "../../../shared/permissions.ts";
import { randomId } from "../../../shared/objects.ts";
import { game, toast } from "../game.ts";
import { h, setChildren } from "../dom.ts";
import { enrich, markdown, toggleSecret } from "../enrich.ts";
import { browseFiles } from "./file-picker.ts";
import { ownershipEditor } from "./sheet.ts";
import { closeWindow, confirmDialog, openWindow, prompt, setWindowTitle } from "./windows.ts";

const DOC_DRAG = "application/x-mesa-doc";
const PAGE_TYPES: [PageType, string, string][] = [
  ["text", "Texto", "fa-solid fa-file-lines"], ["image", "Imagem", "fa-solid fa-image"],
  ["pdf", "PDF", "fa-solid fa-file-pdf"], ["video", "Vídeo", "fa-solid fa-film"]
];
const PAGE_OWNERSHIP: [number, string][] = [
  [OWNERSHIP.INHERIT, "Como a entrada"], [OWNERSHIP.NONE, "Ninguém"], [OWNERSHIP.LIMITED, "Ver"], [OWNERSHIP.OBSERVER, "Observar"], [OWNERSHIP.OWNER, "Dono"]
];

export const pagesOf = (entryId: string) => game.children<JournalEntryPageDoc>("JournalEntryPage", entryId)
  .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"));
const entryOwner = (j: JournalEntryDoc) => ownershipLevel(j.ownership, game.user) >= OWNERSHIP.OWNER;
const pageOwner = (p: JournalEntryPageDoc) => pageLevel(p, game.user, game) >= OWNERSHIP.OWNER;

/** YouTube/Vimeo links play in an embed; anything else as a video file. */
function videoEmbed(src: string): string | null {
  const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/.exec(src);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vimeo = /vimeo\.com\/(\d+)/.exec(src);
  return vimeo ? `https://player.vimeo.com/video/${vimeo[1]}` : null;
}

/** Big picture for everyone (GM "mostrar aos jogadores") or just for oneself. */
export function openImagePopout(src: string, title: string): void {
  const key = `image-${src}`;
  const body = openWindow(key, title || "Imagem", { width: 720 });
  if (!body) return;
  setChildren(body, h("div.image-popout", null, h("img", { src, alt: title })),
    game.isGM ? h("div.row.end", null, h("button", { onclick: () => shareImage(src, title) }, h("i.fa-solid.fa-share"), " Mostrar a todos")) : null);
}

export function shareImage(src: string, title: string): void {
  game.socket.emit("shareImage", { src, title } satisfies ShareImageEvent);
  toast("Imagem mostrada aos jogadores");
}

/** One page, read-only, enriched. */
function pageView(p: JournalEntryPageDoc): HTMLElement {
  const owner = pageOwner(p);
  const title = p.title?.show !== false ? h(`h${Math.min(6, Math.max(1, p.title?.level ?? 1))}` as "h1", { className: "page-title" }, p.name) : null;
  let content: Node | null = null;
  const src = p.src ?? "";
  switch (p.type) {
    case "text": {
      const html = p.text.format === PAGE_FORMAT.MARKDOWN ? markdown(p.text.markdown) : p.text.content;
      content = h("div.prose.journal", null, enrich(html, {
        onToggleSecret: owner && p.text.format !== PAGE_FORMAT.MARKDOWN
          ? i => game.update("JournalEntryPage", { _id: p._id, "text.content": toggleSecret(p.text.content, i) }, p._parent)
          : undefined
      }));
      break;
    }
    case "image":
      content = src ? h("figure.page-image", null,
        h("img", { src, alt: p.image?.caption || p.name, onclick: () => openImagePopout(src, p.name) }),
        p.image?.caption ? h("figcaption", null, p.image.caption) : null,
        game.isGM ? h("button.small", { onclick: () => shareImage(src, p.image?.caption || p.name) }, h("i.fa-solid.fa-share"), " Mostrar a todos") : null)
        : h("p.muted", null, "Sem imagem.");
      break;
    case "pdf":
      content = src ? h("iframe.page-pdf", { src, title: p.name }) : h("p.muted", null, "Sem PDF.");
      break;
    case "video": {
      const embed = src && videoEmbed(src);
      content = !src ? h("p.muted", null, "Sem vídeo.")
        : embed ? h("iframe.page-video", { src: embed, title: p.name, allow: "autoplay; encrypted-media; picture-in-picture", allowFullscreen: true })
        : h("video.page-video", { src, controls: p.video?.controls ?? true, loop: !!p.video?.loop, autoplay: !!p.video?.autoplay, volume: p.video?.volume ?? 0.5 });
      break;
    }
  }
  return h("article.journal-page", { dataset: { pageId: p._id } }, title, content);
}

/** Simple rich-text editor: a contentEditable area with a toolbar. */
function htmlEditor(initial: string): { node: HTMLElement; read: () => string } {
  const area = h("div.prose.journal.editing", { contentEditable: "true" });
  area.innerHTML = initial;
  const cmd = (name: string, value?: string) => () => {
    area.focus();
    document.execCommand(name, false, value);
  };
  const wrapSecret = () => {
    area.focus();
    const sel = getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : "Segredo…";
    document.execCommand("insertHTML", false, `<section class="secret"><p>${text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</p></section><p></p>`);
  };
  const link = async () => {
    const sel = getSelection()?.getRangeAt(0).cloneRange();
    const v = await prompt("Ligação", [{ name: "url", label: "Endereço (https://…)" }]);
    if (!v?.url) return;
    area.focus();
    if (sel) {
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(sel);
    }
    document.execCommand("createLink", false, v.url);
  };
  const b = (icon: string, title: string, run: () => void) => h("button.icon", { type: "button", title, onmousedown: (e: Event) => e.preventDefault(), onclick: run }, h("i", { className: icon }));
  // Drop a document from the sidebar to insert a link to it.
  area.addEventListener("drop", e => {
    const raw = e.dataTransfer?.getData(DOC_DRAG);
    if (!raw) return;
    e.preventDefault();
    const { type, id } = JSON.parse(raw) as { type: string; id: string };
    const name = game.get<{ _id: string; name?: string }>(type as never, id)?.name ?? id;
    const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (range) {
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
    document.execCommand("insertText", false, `@UUID[${type}.${id}]{${name}}`);
  });
  const toolbar = h("div.editor-toolbar", null,
    b("fa-solid fa-bold", "Negrito", cmd("bold")), b("fa-solid fa-italic", "Itálico", cmd("italic")),
    b("fa-solid fa-heading", "Título", cmd("formatBlock", "h2")), b("fa-solid fa-paragraph", "Parágrafo", cmd("formatBlock", "p")),
    b("fa-solid fa-list-ul", "Lista", cmd("insertUnorderedList")), b("fa-solid fa-list-ol", "Lista numerada", cmd("insertOrderedList")),
    b("fa-solid fa-quote-left", "Citação", cmd("formatBlock", "blockquote")), b("fa-solid fa-link", "Ligação", link),
    b("fa-solid fa-user-secret", "Bloco secreto (só os donos veem)", wrapSecret),
    b("fa-solid fa-eraser", "Limpar formatação", cmd("removeFormat")),
    h("span.muted.small", null, "Arrasta documentos para criar ligações · [[1d20]] cria uma rolagem"));
  return { node: h("div.html-editor", null, toolbar, area), read: () => area.innerHTML };
}

/** Edit form for one page. */
function pageEditor(p: JournalEntryPageDoc, entry: JournalEntryDoc, done: () => void): HTMLElement {
  const name = h("input", { value: p.name });
  const type = h("select", null, PAGE_TYPES.map(([v, l]) => h("option", { value: v, selected: p.type === v }, l)));
  const showTitle = h("input", { type: "checkbox", checked: p.title?.show !== false });
  const level = h("select", null, [1, 2, 3].map(n => h("option", { value: String(n), selected: (p.title?.level ?? 1) === n }, `Título ${n}`)));
  const category = h("select", null, h("option", { value: "" }, "— sem categoria —"),
    (entry.categories ?? []).map(c => h("option", { value: c._id, selected: p.category === c._id }, c.name)));
  const ownership = entryOwner(entry) ? h("select", null, PAGE_OWNERSHIP.map(([v, l]) => h("option", { value: String(v), selected: (p.ownership?.default ?? -1) === v }, l))) : null;
  const format = h("select", null, [[1, "HTML"], [2, "Markdown"]].map(([v, l]) => h("option", { value: String(v), selected: (p.text?.format ?? 1) === v }, String(l))));
  const editor = htmlEditor(p.text?.content ?? "");
  const md = h("textarea.macro-command.code", { rows: 18, value: p.text?.markdown ?? "" });
  const src = h("input", { value: p.src ?? "", placeholder: "/assets/… ou URL (YouTube também, para vídeo)" });
  const caption = h("input", { value: p.image?.caption ?? "" });
  const loop = h("input", { type: "checkbox", checked: !!p.video?.loop });
  const autoplay = h("input", { type: "checkbox", checked: !!p.video?.autoplay });
  const body = h("div.stack");
  const accept: Record<PageType, string> = { text: "", image: "image/*", pdf: "application/pdf,.pdf", video: "video/*,.mp4,.webm" };
  const kinds: Record<PageType, "image" | "pdf" | "video"> = { text: "image", image: "image", pdf: "pdf", video: "video" };
  const pick = h("button", {
    type: "button", title: "Escolher ou carregar ficheiro",
    onclick: async () => {
      const chosen = await browseFiles(kinds[type.value as PageType], src.value);
      if (chosen) src.value = chosen;
    }
  }, h("i.fa-solid.fa-folder-open"));

  const renderBody = () => {
    const t = type.value as PageType;
    if (t === "text") {
      setChildren(body, h("label.field", null, h("span", null, "Formato"), format), Number(format.value) === 2 ? md : editor.node);
    } else {
      setChildren(body,
        h("label.field", null, h("span", null, "Ficheiro"), h("div.row", null, src, pick)),
        t === "image" ? h("label.field", null, h("span", null, "Legenda"), caption) : null,
        t === "video" ? h("div.row", null, h("label.row", null, loop, "Repetir"), h("label.row", null, autoplay, "Começar sozinho")) : null);
    }
  };
  type.addEventListener("change", renderBody);
  format.addEventListener("change", renderBody);
  renderBody();

  const save = async () => {
    const data: { _id: string } & Record<string, unknown> = {
      _id: p._id, name: name.value.trim() || p.name, type: type.value,
      title: { show: showTitle.checked, level: Number(level.value) }, category: category.value || null,
      text: { content: editor.read(), markdown: md.value, format: Number(format.value) },
      src: src.value.trim() || null, image: { caption: caption.value }, video: { ...p.video, loop: loop.checked, autoplay: autoplay.checked }
    };
    if (ownership) data.ownership = { ...p.ownership, default: Number(ownership.value) };
    await game.update("JournalEntryPage", data, entry._id);
    done();
  };
  return h("div.page-editor.stack", null,
    h("div.row.wrap", null, h("label.field.grow", null, h("span", null, "Nome"), name), h("label.field", null, h("span", null, "Tipo"), type),
      h("label.field", null, h("span", null, "Categoria"), category)),
    h("div.row.wrap", null, h("label.row", null, showTitle, "Mostrar título"), level,
      ownership ? h("label.row", null, "Quem vê:", ownership) : null),
    body,
    h("div.row.end", null,
      h("button.danger", {
        type: "button",
        onclick: async () => {
          if (!(await confirmDialog(`Apagar a página "${p.name}"?`))) return;
          await game.delete("JournalEntryPage", p._id, entry._id);
          done();
        }
      }, "Apagar página"),
      h("span.grow"),
      h("button", { type: "button", onclick: done }, "Cancelar"),
      h("button.primary", { type: "button", onclick: save }, "Guardar"))
  );
}

/**
 * A journal entry: pages listed on the left (grouped by category), the page (or all pages) on the
 * right. Owners add, edit, reorder and delete pages; the GM can show the entry to players.
 */
export function openJournal(entryId: string, opts: { pageId?: string | null; edit?: boolean } | boolean = {}): void {
  const o = typeof opts === "boolean" ? { edit: opts } : opts;
  const key = `journal-${entryId}`;
  const offs: (() => void)[] = [];
  let current: string | null = o.pageId ?? null;
  let editing: string | null = null;
  let all = false;
  const existing = document.querySelector<HTMLElement>(`.win[data-key="${key}"]`);
  const body = openWindow(key, game.get<JournalEntryDoc>("JournalEntry", entryId)?.name ?? "", { width: 820, onClose: () => offs.forEach(f => f()) });
  if (!body) {
    // Already open: jump to the requested page.
    if (o.pageId && existing) existing.dispatchEvent(new CustomEvent("mesa:page", { detail: o.pageId }));
    return;
  }

  const addPage = async (type: PageType = "text") => {
    const pages = pagesOf(entryId);
    const v = await prompt("Nova página", [{ name: "name", label: "Nome" }]);
    if (!v?.name.trim()) return;
    const [p] = await game.create<JournalEntryPageDoc>("JournalEntryPage", { name: v.name.trim(), type, sort: (pages.at(-1)?.sort ?? 0) + 1000 }, entryId);
    if (p) {
      current = p._id;
      editing = p._id;
      render();
    }
  };
  const move = (p: JournalEntryPageDoc, dir: -1 | 1) => {
    const pages = pagesOf(entryId);
    const i = pages.findIndex(x => x._id === p._id);
    const other = pages[i + dir];
    if (!other) return;
    // Swap sort keys (make them distinct first so equal sorts still move).
    game.update("JournalEntryPage", [{ _id: p._id, sort: other.sort }, { _id: other._id, sort: p.sort === other.sort ? other.sort + dir : p.sort }], entryId);
  };

  const render = () => {
    const j = game.get<JournalEntryDoc>("JournalEntry", entryId);
    if (!j) return closeWindow(key);
    // Don't throw away an edit in progress.
    if (editing && body.querySelector(".page-editor")?.contains(document.activeElement)) return;
    setWindowTitle(key, j.name);
    const pages = pagesOf(entryId);
    if (!current || !pages.some(p => p._id === current)) current = pages[0]?._id ?? null;
    const owner = entryOwner(j);
    const page = pages.find(p => p._id === current);

    const tocItem = (p: JournalEntryPageDoc) => h("li", {
      className: `toc-page${p._id === current ? " current" : ""}`,
      onclick: () => { current = p._id; editing = null; all ? scrollToPage(p._id) : render(); }
    },
      h("i", { className: PAGE_TYPES.find(([t]) => t === p.type)?.[2] ?? "fa-solid fa-file" }),
      h("span.grow", null, p.name),
      (p.ownership?.default ?? -1) !== OWNERSHIP.INHERIT && game.isGM ? h("i.fa-solid.fa-lock", { title: "Permissões próprias" }) : null,
      pageOwner(p) && h("span.toc-actions", null,
        h("button.icon.small", { title: "Subir", onclick: (e: Event) => { e.stopPropagation(); move(p, -1); } }, h("i.fa-solid.fa-chevron-up")),
        h("button.icon.small", { title: "Descer", onclick: (e: Event) => { e.stopPropagation(); move(p, 1); } }, h("i.fa-solid.fa-chevron-down")),
        h("button.icon.small", { title: "Editar", onclick: (e: Event) => { e.stopPropagation(); current = p._id; editing = p._id; all = false; render(); } }, h("i.fa-solid.fa-pen"))));
    const cats = [...(j.categories ?? [])].sort((a, b) => a.sort - b.sort);
    const uncategorised = pages.filter(p => !p.category || !cats.some(c => c._id === p.category));
    const toc = h("aside.journal-toc", null,
      h("ol", null,
        uncategorised.map(tocItem),
        cats.map(c => {
          const inCat = pages.filter(p => p.category === c._id);
          return inCat.length || owner ? h("li.toc-category", null, h("span", null, c.name), h("ol", null, inCat.map(tocItem))) : null;
        })),
      !pages.length && h("p.muted.small", null, "Sem páginas."),
      owner && h("div.toc-buttons", null,
        h("button.small", { onclick: () => addPage("text") }, h("i.fa-solid.fa-plus"), " Página"),
        h("button.small", {
          title: "Criar uma categoria para agrupar páginas",
          onclick: async () => {
            const v = await prompt("Nova categoria", [{ name: "name", label: "Nome" }]);
            if (v?.name.trim()) game.update("JournalEntry", { _id: entryId, categories: [...(j.categories ?? []), { _id: randomId(), name: v.name.trim(), sort: Date.now() }] });
          }
        }, h("i.fa-solid.fa-folder-plus"), " Categoria")));

    const main = h("div.journal-main");
    if (editing && page && pageOwner(page)) {
      main.append(pageEditor(page, j, () => { editing = null; render(); }));
    } else if (all) {
      main.append(...pages.map(pageView));
    } else if (page) {
      main.append(pageView(page));
    } else {
      main.append(h("p.muted", null, owner ? "Esta entrada ainda não tem páginas. Cria uma à esquerda." : "Nada para ler aqui."));
    }

    const toolbar = h("div.row.toolbar.journal-toolbar", null,
      h("button.small", { title: all ? "Ver uma página de cada vez" : "Ver todas as páginas seguidas", onclick: () => { all = !all; editing = null; render(); } },
        h("i", { className: all ? "fa-solid fa-file" : "fa-solid fa-copy" }), all ? " Uma página" : " Todas"),
      h("span.grow"),
      game.isGM && h("button.small", { title: "Abrir esta entrada (nesta página) para os jogadores", onclick: () => showToPlayers(j, current) }, h("i.fa-solid.fa-eye"), " Mostrar aos jogadores"),
      game.isGM && h("button.small.danger", {
        onclick: async () => { if (await confirmDialog(`Apagar "${j.name}" e todas as páginas?`)) game.delete("JournalEntry", entryId); }
      }, h("i.fa-solid.fa-trash")));

    setChildren(body, toolbar, h("div.journal-layout", null, toc, main), game.isGM ? ownershipEditor(j, "JournalEntry") : null);
    if (all && current) scrollToPage(current);
  };
  const scrollToPage = (id: string) => body.querySelector(`[data-page-id="${id}"]`)?.scrollIntoView({ block: "start" });

  body.closest(".win")?.addEventListener("mesa:page", e => {
    current = (e as CustomEvent<string>).detail;
    editing = null;
    render();
  });
  offs.push(game.on("JournalEntry", e => e.ids.includes(entryId) && render()));
  offs.push(game.on("JournalEntryPage", e => e.docs.some(d => d._parent === entryId) && render()));
  render();
  if (o.edit && current) {
    editing = current;
    render();
  }
}

/** GM: open this entry for players; offers to let them read it when they can't yet. */
async function showToPlayers(j: JournalEntryDoc, pageId: string | null): Promise<void> {
  const players = game.all<UserDoc>("User").filter(u => u.role !== "gm");
  const cannot = players.filter(u => ownershipLevel(j.ownership, u) < OWNERSHIP.LIMITED);
  let grant = false;
  if (cannot.length) {
    grant = await confirmDialog(`${cannot.map(u => u.name).join(", ")} ainda não pode${cannot.length > 1 ? "m" : ""} ver "${j.name}". Dar permissão de ver e mostrar?`, "Dar e mostrar");
    if (!grant && cannot.length === players.length) return;
  }
  const res = await game.socket.timeout(10_000).emitWithAck("showEntry", { entryId: j._id, pageId, users: null, grant });
  toast(res.ok ? "Mostrado aos jogadores" : res.error, res.ok ? "info" : "error");
}
