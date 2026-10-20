import type { ActorDoc, HotbarEntry, ItemDoc, JournalEntryDoc } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { avatar, h, setChildren } from "../dom.ts";
import { ITEM_DRAG, openSheet } from "../ui/sheet.ts";
import { openItemSheet, rollItem, useItem } from "../ui/item-sheet.ts";
import { openJournal } from "../ui/panels.ts";
import { stateOf } from "../actors.ts";
import { audio } from "../audio/engine.ts";

const PAGES = 5;
const DOC_DRAG = "application/x-mesa-doc";
const LOCK_KEY = "mesa.hotbarLocked";

/**
 * Hotbar (bottom centre): 10 slots × 5 pages, per user. Drop items, actors or journal entries on a
 * slot; click (or press 1–0) to use it: weapons attack, rituals/abilities post to chat, other items
 * open their sheet, actors open their sheet, journal entries open. Macros arrive in Phase 6.
 */
export function hotbar(): HTMLElement {
  const el = h("aside#hotbar");
  let page = 1;
  let locked = readLocked();
  let collapsed = false;

  const slots = () => (game.user.hotbar ?? {}) as Record<string, HotbarEntry | null>;
  const save = (slot: number, entry: HotbarEntry | null) => game.update("User", { _id: game.userId, [`hotbar.${slot}`]: entry });

  const entryInfo = (e: HotbarEntry | null | undefined) => {
    if (!e) return null;
    const doc = game.get<ActorDoc | ItemDoc | JournalEntryDoc>(e.type, e.id);
    return doc ? { doc, img: (doc as ActorDoc).img ?? null, name: doc.name } : null;
  };

  const execute = (slot: number) => {
    const e = slots()[slot];
    const info = entryInfo(e);
    if (!e || !info) return;
    if (e.type === "Actor") return openSheet(e.id);
    if (e.type === "JournalEntry") return openJournal(e.id);
    const item = info.doc as ItemDoc;
    const owner = item._parent ? stateOf({ actorId: item._parent }) : null;
    if (owner && item.type === "armament") return rollItem(item, owner.derived, "attack");
    if (owner && (item.type === "ritual" || item.type === "ability")) return useItem(item, owner.derived);
    openItemSheet(item._id);
  };

  const onDrop = (slot: number, ev: DragEvent) => {
    ev.preventDefault();
    if (locked) return toast("A barra está trancada");
    const dt = ev.dataTransfer;
    const item = dt?.getData(ITEM_DRAG);
    const doc = dt?.getData(DOC_DRAG);
    const actor = dt?.getData("application/x-mesa-actor");
    if (item) save(slot, { type: "Item", id: JSON.parse(item).id });
    else if (actor) save(slot, { type: "Actor", id: actor });
    else if (doc) {
      const { type, id } = JSON.parse(doc);
      if (type === "JournalEntry" || type === "Actor" || type === "Item") save(slot, { type, id });
    }
  };

  const render = () => {
    const data = slots();
    const cells = Array.from({ length: 10 }, (_, i) => {
      const slot = (page - 1) * 10 + i + 1;
      const info = entryInfo(data[slot]);
      return h("li", {
        className: info ? "slot filled" : "slot",
        title: info ? info.name : "Arrasta um item, ator ou entrada para aqui",
        onclick: () => execute(slot),
        oncontextmenu: (e: Event) => {
          e.preventDefault();
          if (!locked && info) save(slot, null);
        },
        ondragover: (e: DragEvent) => e.preventDefault(),
        ondrop: (e: DragEvent) => onDrop(slot, e)
      },
        info ? avatar(info.img, info.name, 44) : null,
        h("span.key", null, String((i + 1) % 10)));
    });
    el.className = collapsed ? "collapsed" : "";
    setChildren(el, 
      h("div.hotbar-side", null,
        h("button.control-btn.small", {
          className: `control-btn small${audio.settings.muted ? " active" : ""}`,
          title: audio.settings.muted ? "Ligar o som" : "Silenciar tudo",
          onclick: () => audio.setMuted(!audio.settings.muted)
        }, h("i", { className: audio.settings.muted ? "fa-solid fa-volume-xmark" : "fa-solid fa-volume-high" })),
        h("button.control-btn.small", { title: collapsed ? "Mostrar barra" : "Esconder barra", onclick: () => { collapsed = !collapsed; render(); } }, h("i.fa-solid.fa-bars"))),
      collapsed ? null : h("menu.slots", null, cells),
      collapsed ? null : h("div.hotbar-side.right", null,
        h("div.pages", null,
          h("button.icon", { title: "Página seguinte", onclick: () => { page = (page % PAGES) + 1; render(); } }, h("i.fa-solid.fa-caret-up")),
          h("span.page", null, String(page)),
          h("button.icon", { title: "Página anterior", onclick: () => { page = ((page + PAGES - 2) % PAGES) + 1; render(); } }, h("i.fa-solid.fa-caret-down"))),
        h("div.hotbar-buttons", null,
          h("button.control-btn.small", { title: locked ? "Destrancar" : "Trancar", onclick: () => { locked = !locked; writeLocked(locked); render(); } },
            h("i", { className: `fa-solid fa-lock${locked ? "" : "-open"}` })),
          h("button.control-btn.small", {
            title: "Limpar esta página",
            onclick: () => {
              if (locked) return;
              const updates: Record<string, null> = {};
              for (let i = 1; i <= 10; i++) updates[`hotbar.${(page - 1) * 10 + i}`] = null;
              game.update("User", { _id: game.userId, ...updates });
            }
          }, h("i.fa-solid.fa-trash"))))
    );
  };

  // Number keys 1–0 use the slots of the current page.
  window.addEventListener("keydown", e => {
    if ((e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!/^[0-9]$/.test(e.key)) return;
    execute((page - 1) * 10 + (e.key === "0" ? 10 : Number(e.key)));
  });
  audio.onChange(render);
  game.on("User", ev => ev.ids.includes(game.userId) && render());
  for (const t of ["Item", "Actor", "JournalEntry"] as const) game.on(t, render);
  render();
  return el;
}

function readLocked(): boolean {
  try {
    return localStorage.getItem(LOCK_KEY) === "1";
  } catch {
    return false;
  }
}
function writeLocked(v: boolean): void {
  try {
    localStorage.setItem(LOCK_KEY, v ? "1" : "0");
  } catch {
    // Not remembered in private mode.
  }
}
