import type { BaseDoc, LinkType } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { h } from "../dom.ts";
import { openSheet } from "./sheet.ts";
import { openItemSheet } from "./item-sheet.ts";
import { openJournal } from "./journal.ts";

export const LINK_ICONS: Record<LinkType, string> = {
  Actor: "fa-solid fa-user", Item: "fa-solid fa-suitcase", JournalEntry: "fa-solid fa-book-open", RollTable: "fa-solid fa-table-list",
  Scene: "fa-solid fa-map", Macro: "fa-solid fa-code", Playlist: "fa-solid fa-music"
};

/** Open whatever a link points at (sheet, journal, table…). Macros run. */
export async function openLink(type: LinkType, id: string, pageId?: string): Promise<void> {
  const doc = game.get(type, id);
  if (!doc) return toast("Já não existe (ou não tens acesso).", "error");
  switch (type) {
    case "Actor": return openSheet(id);
    case "Item": return openItemSheet(id);
    case "JournalEntry": return openJournal(id, { pageId });
    case "RollTable": return (await import("./tables.ts")).openTableSheet(id);
    case "Scene": return game.isGM ? game.view(id) : undefined;
    case "Macro": return void (await import("../macros.ts")).executeMacro(doc as never);
    case "Playlist": return;
  }
}

/** A clickable chip naming a linked document. */
export function linkChip(type: LinkType, id: string, fallback = "?"): HTMLElement {
  const doc = game.get<BaseDoc & { name?: string }>(type, id);
  return h("a.doc-link", {
    className: `doc-link${doc ? "" : " broken"}`,
    title: doc ? `Abrir ${doc.name}` : "Já não existe",
    onclick: (e: Event) => { e.preventDefault(); openLink(type, id); }
  }, h("i", { className: LINK_ICONS[type] }), " ", doc?.name ?? fallback);
}
