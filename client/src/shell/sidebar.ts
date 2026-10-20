import type { ChatMessageDoc } from "../../../shared/protocol.ts";
import { game } from "../game.ts";
import { h } from "../dom.ts";
import { chatInputBox, messageView } from "../ui/chat.ts";
import { settings } from "../settings.ts";
import { t } from "../i18n.ts";

export interface SidebarTab {
  id: string;
  icon: string;
  label: string;
  make: () => HTMLElement;
}

const STATE_KEY = "mesa.sidebar";

function readState(): { tab: string; expanded: boolean } {
  try {
    return { tab: "chat", expanded: true, ...JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}") };
  } catch {
    return { tab: "chat", expanded: true };
  }
}

/**
 * Right sidebar like Foundry v13's: a vertical strip of tab icons; clicking a tab opens its panel,
 * clicking the open tab (or the caret) collapses it. While the chat isn't showing, a chat box and
 * new-message notifications float at the bottom right.
 */
export function sidebar(tabs: SidebarTab[]): HTMLElement {
  const state = readState();
  if (!tabs.some(t => t.id === state.tab)) state.tab = tabs[0].id;
  const panels = new Map<string, HTMLElement>();
  const panelHost = h("section.sidebar-panel");
  const strip = h("nav.sidebar-tabs");
  const dock = chatDock(() => !(state.expanded && state.tab === "chat"));
  const root = h("aside#sidebar", null, strip, panelHost, dock.element);

  const save = () => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {
      // Not remembered in private mode.
    }
  };
  const render = () => {
    root.classList.toggle("expanded", state.expanded);
    strip.replaceChildren(h("menu", null,
      tabs.map(t => h("li", null, h("button", {
        className: `control-btn tab${state.expanded && t.id === state.tab ? " active" : ""}`,
        dataset: { tab: t.id },
        title: t.label,
        onclick: () => {
          if (state.expanded && state.tab === t.id) state.expanded = false;
          else {
            state.tab = t.id;
            state.expanded = true;
          }
          save();
          render();
        }
      }, h("i", { className: t.icon })))),
      h("li", null, h("button.control-btn.tab.collapse", {
        title: state.expanded ? t("Fechar barra lateral") : t("Abrir barra lateral"),
        onclick: () => {
          state.expanded = !state.expanded;
          save();
          render();
        }
      }, h("i", { className: `fa-solid fa-caret-${state.expanded ? "right" : "left"}` })))
    ));
    if (state.expanded) {
      if (!panels.has(state.tab)) panels.set(state.tab, tabs.find(t => t.id === state.tab)!.make());
      const tab = tabs.find(t => t.id === state.tab)!;
      panelHost.replaceChildren(h("header.panel-title", null, h("i", { className: tab.icon }), tab.label), panels.get(state.tab)!);
    } else panelHost.replaceChildren();
    dock.update();
  };
  render();
  return root;
}

/** Floating chat input + transient notifications for new messages. */
function chatDock(active: () => boolean): { element: HTMLElement; update: () => void } {
  const notes = h("div.chat-notes");
  const element = h("div.chat-dock", null, notes, chatInputBox());
  game.on("ChatMessage", e => {
    if (e.op !== "create" || !active() || !settings.get("core.chatNotifications")) return;
    for (const m of e.docs as ChatMessageDoc[]) {
      const note = messageView(m);
      note.classList.add("chat-note");
      notes.append(note);
      setTimeout(() => note.classList.add("fading"), 7000);
      setTimeout(() => note.remove(), 8000);
    }
    while (notes.childElementCount > 4) notes.firstElementChild?.remove();
  });
  return {
    element,
    update: () => {
      element.hidden = !active();
      if (!active()) return;
      notes.replaceChildren();
    }
  };
}
