import type { BaseDoc, LinkType, RollMode } from "../../shared/protocol.ts";
import { LINK_TYPES } from "../../shared/protocol.ts";
import { game } from "./game.ts";
import { h, safeHtml } from "./dom.ts";
import { LINK_ICONS, openLink } from "./ui/links.ts";
import { speaker, withActorData } from "./ui/chat.ts";

/**
 * Rich text for journals, chat cards and descriptions (sanitised HTML in, live elements out):
 *   @UUID[Actor.<id>]{label}   @UUID[JournalEntry.<id>.JournalEntryPage.<id>]   @Actor[<id or name>]{label}
 *                              → a chip that opens the document (or page)
 *   [[1d20+5]]  [[/gr 1d20]]{Furtividade}
 *                              → a button that rolls in the chat (the server rolls; modes as in the chat commands)
 *   http(s)://…                → a link that opens in a new tab
 *   <section class="secret">   → shown to owners with a frame (the server never sends unrevealed ones to others)
 */

const LINK = /@(UUID|Actor|Item|JournalEntry|RollTable|Scene|Macro|Playlist)\[([^\]#]+)(?:#([^\]]+))?\](?:\{([^}]+)\})?/g;
const ROLL = /\[\[(?:\/([a-z]+)\s+)?([^\]]+?)\]\](?:\{([^}]+)\})?/gi;
const URL = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;
const MODES: Record<string, RollMode | undefined> = { r: undefined, roll: undefined, pr: "public", gr: "gm", gmroll: "gm", br: "blind", blindroll: "blind", sr: "self", selfroll: "self" };

export interface EnrichOptions {
  /** Called when a secret block's reveal button is pressed (owners only); index = secret's position. */
  onToggleSecret?: (index: number) => void;
}

/** Resolve "Type.id" / "Type.id.JournalEntryPage.id" / legacy id-or-name into something we can open. */
function resolveLink(kind: string, target: string): { type: LinkType; id: string; pageId?: string } | null {
  if (kind === "UUID") {
    const parts = target.split(".");
    if (parts[0] === "Compendium") return null;
    const [type, id, sub, subId] = parts as [LinkType, string, string?, string?];
    if (!LINK_TYPES.includes(type)) return null;
    return { type, id, pageId: sub === "JournalEntryPage" ? subId : undefined };
  }
  const type = kind as LinkType;
  if (game.get(type, target)) return { type, id: target };
  const byName = game.all<BaseDoc & { name?: string }>(type).find(d => d.name === target);
  return byName ? { type, id: byName._id } : null;
}

function linkNode(kind: string, target: string, label: string | undefined): HTMLElement {
  const link = resolveLink(kind, target);
  const doc = link ? game.get<BaseDoc & { name?: string }>(link.type, link.id) : undefined;
  const page = link?.pageId ? game.get<BaseDoc & { name?: string }>("JournalEntryPage", link.pageId) : undefined;
  const name = label ?? page?.name ?? doc?.name ?? target;
  if (!link || !doc) return h("span.doc-link.broken", { title: "Ligação partida (ou sem acesso)" }, h("i.fa-solid.fa-link-slash"), " ", name);
  return h("a.doc-link", {
    title: `Abrir ${doc.name ?? ""}`, draggable: true,
    ondragstart: (e: DragEvent) => e.dataTransfer?.setData("application/x-mesa-doc", JSON.stringify({ type: link.type, id: link.id })),
    onclick: (e: Event) => { e.preventDefault(); openLink(link.type, link.id, link.pageId); }
  }, h("i", { className: link.pageId ? "fa-solid fa-file-lines" : LINK_ICONS[link.type] }), " ", name);
}

function rollNode(command: string | undefined, formula: string, label: string | undefined): HTMLElement {
  const mode = MODES[(command ?? "r").toLowerCase()];
  return h("a.inline-roll.deferred", {
    title: `Rolar ${formula}${!mode || mode === "public" ? "" : ` (${mode === "gm" ? "mestre" : mode === "blind" ? "às cegas" : "só eu"})`}`,
    onclick: (e: Event) => {
      e.preventDefault();
      const as = speaker();
      game.roll({ formula: withActorData(formula.trim(), as.actor), flavor: label, speaker: as, mode });
    }
  }, h("i.fa-solid.fa-dice-d20"), " ", label ?? formula.trim());
}

/** Replace matches of `re` inside every text node under `root` with nodes from `make`. */
function replaceText(root: Node, re: RegExp, make: (m: RegExpExecArray) => Node | null): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // Leave code and existing links alone.
    acceptNode: n => (n.parentElement?.closest("a, code, pre, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.data;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last = 0;
    const parts: Node[] = [];
    while ((m = re.exec(text))) {
      const made = make(m);
      if (!made) continue;
      parts.push(document.createTextNode(text.slice(last, m.index)), made);
      last = m.index + m[0].length;
    }
    if (!parts.length) continue;
    parts.push(document.createTextNode(text.slice(last)));
    node.replaceWith(...parts);
  }
}

export function enrich(html: string, opts: EnrichOptions = {}): DocumentFragment {
  const frag = safeHtml(html);
  replaceText(frag, LINK, m => linkNode(m[1], m[2], m[4]));
  replaceText(frag, ROLL, m => rollNode(m[1], m[2], m[3]));
  replaceText(frag, URL, m => h("a.external", { href: m[0], target: "_blank", rel: "noopener noreferrer" }, m[0]));
  for (const a of frag.querySelectorAll<HTMLAnchorElement>("a[href^='http']")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  // Secret blocks: framed, with a reveal toggle for owners.
  [...frag.querySelectorAll<HTMLElement>("section.secret")].forEach((sec, i) => {
    if (!opts.onToggleSecret) return;
    const revealed = sec.classList.contains("revealed");
    sec.prepend(h("button.secret-toggle", {
      type: "button", title: revealed ? "Esconder outra vez dos jogadores" : "Revelar aos jogadores",
      onclick: () => opts.onToggleSecret!(i)
    }, h("i", { className: revealed ? "fa-solid fa-eye" : "fa-solid fa-eye-slash" }), revealed ? " Revelado" : " Segredo"));
  });
  return frag;
}

/** Toggle "revealed" on the n-th secret block of some HTML. */
export function toggleSecret(html: string, index: number): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll("section.secret")[index]?.classList.toggle("revealed");
  return doc.body.innerHTML;
}

// ---------------------------------------------------------------------------
// Markdown → HTML (headings, emphasis, lists, quotes, code, links, images, rules). Output is sanitised by `enrich`.

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function inline(s: string): string {
  const codes: string[] = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/\*([^*]+)\*|(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, (_, a, pre, b) => (a !== undefined ? `<em>${a}</em>` : `${pre}<em>${b}</em>`))
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

export function markdown(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
    if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ""));
      i--;
      out.push(`<blockquote>${markdown(quote.join("\n"))}</blockquote>`);
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (para.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(item[2]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return out.join("\n");
}
