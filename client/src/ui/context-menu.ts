import { h } from "../dom.ts";
import { hooks } from "../hooks.ts";
import { t } from "../i18n.ts";

/**
 * Right-click menus (Foundry's ContextMenu): a short list of actions for the thing under the pointer.
 * Entries can be grouped (a line between groups), hidden by a condition, and packages can add their own
 * through the `get<Name>ContextOptions(entries, target)` hook — e.g. `getActorContextOptions`.
 */
export interface ContextEntry<T = HTMLElement> {
  label: string;
  icon: string;
  /** Entries of the same group sit together; groups are separated by a line. */
  group?: string;
  /** Shown only when true (or when the function returns true for the target). */
  visible?: boolean | ((target: T) => boolean);
  onClick: (target: T) => unknown;
  /** Extra class, e.g. "danger" for destructive actions. */
  classes?: string;
}

let current: { el: HTMLElement; close: () => void } | null = null;

export function closeContextMenu(): boolean {
  if (!current) return false;
  current.close();
  return true;
}

/**
 * Open a menu at the pointer for `target`. `name` names the hook packages can use to add entries
 * (`get${name}ContextOptions`). Labels are Mesa's pt-PT strings, translated here.
 */
export function openContextMenu<T>(e: MouseEvent, entries: ContextEntry<T>[], target: T, name?: string): void {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();
  const list = [...entries];
  if (name) hooks.callAll(`get${name}ContextOptions`, list, target);
  const shown = list.filter(x => (typeof x.visible === "function" ? x.visible(target) : x.visible ?? true));
  if (!shown.length) return;

  // Group order = first appearance; ungrouped entries first.
  const groups = new Map<string, ContextEntry<T>[]>();
  for (const x of shown) {
    const g = x.group ?? "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(x);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : 0));
  const items: HTMLElement[] = [];
  ordered.forEach(([, xs], i) => {
    if (i > 0) items.push(h("li.context-separator", { role: "separator" }));
    for (const x of xs) {
      items.push(h("li", { role: "none" }, h("button.context-item", {
        role: "menuitem", className: `context-item${x.classes ? ` ${x.classes}` : ""}`,
        onclick: (ev: Event) => {
          ev.stopPropagation();
          closeContextMenu();
          x.onClick(target);
        }
      }, h("i", { className: x.icon }), h("span", null, t(x.label)))));
    }
  });
  const el = h("menu#context-menu", { role: "menu" }, items);
  document.body.append(el);

  // At the pointer; flips left/up when it would leave the window (Foundry opens upwards near the bottom).
  const r = el.getBoundingClientRect();
  const left = e.clientX + r.width > innerWidth - 4 ? Math.max(4, e.clientX - r.width) : e.clientX;
  const up = e.clientY + r.height > innerHeight - 4;
  el.style.left = `${left}px`;
  el.style.top = `${up ? Math.max(4, e.clientY - r.height) : e.clientY}px`;
  el.classList.toggle("expand-up", up);
  (el.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });

  const away = (ev: Event) => {
    if (ev.type === "keydown") {
      const k = (ev as KeyboardEvent).key;
      if (k === "Escape") {
        ev.stopPropagation();
        ev.preventDefault();
        return close();
      }
      if (k === "ArrowDown" || k === "ArrowUp") {
        ev.preventDefault();
        const buttons = [...el.querySelectorAll<HTMLButtonElement>("button")];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (k === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
      return;
    }
    if (ev.target instanceof Node && el.contains(ev.target)) return;
    close();
  };
  const close = () => {
    el.remove();
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", away, true);
    window.removeEventListener("wheel", away, true);
    window.removeEventListener("blur", close);
    if (current?.el === el) current = null;
  };
  current = { el, close };
  setTimeout(() => {
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", away, true);
    window.addEventListener("wheel", away, true);
    window.addEventListener("blur", close);
  });
}

/**
 * Right-click on any `selector` inside `container` opens a menu; `entries(target)` builds it for the
 * element that was clicked (re-rendered lists need no rebinding).
 */
export function bindContextMenu(container: HTMLElement, selector: string, entries: (target: HTMLElement) => ContextEntry[], name?: string): void {
  container.addEventListener("contextmenu", e => {
    const target = (e.target as HTMLElement).closest<HTMLElement>(selector);
    if (!target || !container.contains(target)) return;
    openContextMenu(e, entries(target), target, name);
  });
}
