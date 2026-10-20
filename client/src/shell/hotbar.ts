import type { ActorDoc, HotbarEntry, ItemDoc, JournalEntryDoc, MacroDoc, RollTableDoc } from "../../../shared/protocol.ts";
import { drawTable } from "../ui/tables.ts";
import { OWNERSHIP } from "../../../shared/protocol.ts";
import { macroLevel } from "../../../shared/permissions.ts";
import { game, toast } from "../game.ts";
import { avatar, h, setChildren } from "../dom.ts";
import { ITEM_DRAG, openSheet } from "../ui/sheet.ts";
import { openItemSheet, rollItem, useItem } from "../ui/item-sheet.ts";
import { openJournal } from "../ui/journal.ts";
import { stateOf } from "../actors.ts";
import { audio } from "../audio/engine.ts";
import { registerKey } from "../keybindings.ts";
import { executeMacro } from "../macros.ts";
import { macroIcon, openMacroConfig } from "../ui/macros.ts";
import { confirmDialog, contextMenu } from "../ui/windows.ts";

const PAGES = 5;
const DOC_DRAG = "application/x-mesa-doc";
const LOCK_KEY = "mesa.hotbarLocked";
const SLOT_DRAG = "application/x-mesa-hotbar-slot";

/**
 * Hotbar (bottom centre): 10 slots × 5 pages, per user. Drop items, actors or journal entries on a
 * slot; click (or press 1–0) to use it: weapons attack, rituals/abilities post to chat, other items
 * open their sheet, actors open their sheet, journal entries open, macros run. Click an empty slot to
 * write a new macro there; right-click a slot for its menu; drag a slot onto another to move it.
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
    const doc = game.get<ActorDoc | ItemDoc | JournalEntryDoc | MacroDoc | RollTableDoc>(e.type, e.id);
    return doc ? { doc, img: (doc as ActorDoc).img ?? null, name: doc.name } : null;
  };

  const execute = (slot: number, fromClick = false) => {
    const e = slots()[slot];
    const info = entryInfo(e);
    if (!e || !info) {
      if (fromClick && !locked) openMacroConfig(undefined, slot);
      return;
    }
    if (e.type === "Macro") return executeMacro(info.doc as MacroDoc);
    if (e.type === "RollTable") return drawTable(e.id);
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
    const from = Number(dt?.getData(SLOT_DRAG));
    if (from) {
      if (from === slot) return;
      const moved = slots()[from] ?? null;
      const there = slots()[slot] ?? null;
      game.update("User", { _id: game.userId, [`hotbar.${slot}`]: moved, [`hotbar.${from}`]: there });
      return;
    }
    if (item) save(slot, { type: "Item", id: JSON.parse(item).id });
    else if (actor) save(slot, { type: "Actor", id: actor });
    else if (doc) {
      const { type, id } = JSON.parse(doc);
      if (type === "JournalEntry" || type === "Actor" || type === "Item" || type === "Macro" || type === "RollTable") save(slot, { type, id });
    }
  };

  const render = () => {
    const data = slots();
    const cells = Array.from({ length: 10 }, (_, i) => {
      const slot = (page - 1) * 10 + i + 1;
      const entry = data[slot];
      const info = entryInfo(entry);
      const macro = entry?.type === "Macro" && info ? (info.doc as MacroDoc) : null;
      return h("li", {
        className: info ? "slot filled" : "slot",
        title: info ? info.name : "Clica para criar uma macro, ou arrasta um item, ator, entrada ou macro para aqui",
        draggable: !!info && !locked,
        ondragstart: (e: DragEvent) => e.dataTransfer?.setData(SLOT_DRAG, String(slot)),
        onclick: () => execute(slot, true),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          if (!info) return;
          const mine = macro && macroLevel(macro, game.user) >= OWNERSHIP.OWNER;
          contextMenu(e, [
            ...(mine ? [{ label: "Editar macro", icon: "fa-solid fa-pen", run: () => openMacroConfig(macro!._id) }] : []),
            ...(!locked ? [{ label: "Tirar da barra", icon: "fa-solid fa-xmark", run: () => save(slot, null) }] : []),
            ...(mine ? [{
              label: "Apagar macro", icon: "fa-solid fa-trash",
              run: async () => { if (await confirmDialog(`Apagar a macro "${macro!.name}"?`)) { await game.delete("Macro", macro!._id); save(slot, null); } }
            }] : [])
          ]);
        },
        ondragover: (e: DragEvent) => e.preventDefault(),
        ondrop: (e: DragEvent) => onDrop(slot, e)
      },
        macro ? macroIcon(macro, 44) : info ? avatar(info.img, info.name, 44) : null,
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

  // Number keys 1–0 use the slots of the current page (rebindable).
  for (let i = 1; i <= 10; i++) {
    registerKey({
      id: `core.hotbar${i}`, name: `Usar a casa ${i} da barra de macros`, category: "Barra de macros",
      bindings: [{ key: `Digit${i % 10}` }],
      onDown: () => {
        execute((page - 1) * 10 + i);
        return true;
      }
    });
  }
  registerKey({ id: "core.hotbarNext", name: "Página seguinte da barra", category: "Barra de macros", bindings: [], onDown: () => { page = (page % PAGES) + 1; render(); return true; } });
  registerKey({ id: "core.hotbarPrevious", name: "Página anterior da barra", category: "Barra de macros", bindings: [], onDown: () => { page = ((page + PAGES - 2) % PAGES) + 1; render(); return true; } });
  audio.onChange(render);
  game.on("User", ev => ev.ids.includes(game.userId) && render());
  for (const t of ["Item", "Actor", "JournalEntry", "Macro", "RollTable"] as const) game.on(t, render);
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
