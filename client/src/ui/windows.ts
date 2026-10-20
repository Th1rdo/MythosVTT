import { h } from "../dom.ts";

interface Win {
  el: HTMLElement;
  body: HTMLElement;
  onClose?: () => void;
}

const open = new Map<string, Win>();
let z = 100;

/**
 * Floating, draggable window. Re-opening the same key brings the existing window forward.
 * Returns the body element to fill, or null when it was already open.
 */
export function openWindow(key: string, title: string, opts: { width?: number; onClose?: () => void } = {}): HTMLElement | null {
  const existing = open.get(key);
  if (existing) {
    existing.el.style.zIndex = String(++z);
    return null;
  }
  const body = h("div.win-body");
  const titleEl = h("span.win-title", null, title);
  const el = h("section.win", { style: { width: `${opts.width ?? 420}px`, zIndex: String(++z) }, dataset: { key } },
    h("header.win-head", null, titleEl, h("button.icon", { title: "Fechar", onclick: () => closeWindow(key) }, "✕")),
    body
  );
  const count = open.size;
  el.style.left = `${80 + count * 28}px`;
  el.style.top = `${60 + count * 28}px`;
  el.addEventListener("pointerdown", () => (el.style.zIndex = String(++z)));
  dragBy(el.querySelector(".win-head")!, el);
  document.getElementById("windows")!.append(el);
  open.set(key, { el, body, onClose: opts.onClose });
  return body;
}

export function setWindowTitle(key: string, title: string): void {
  const t = open.get(key)?.el.querySelector(".win-title");
  if (t) t.textContent = title;
}

export function closeWindow(key: string): void {
  const w = open.get(key);
  if (!w) return;
  w.onClose?.();
  w.el.remove();
  open.delete(key);
}

export function isOpen(key: string): boolean {
  return open.has(key);
}

function dragBy(handle: HTMLElement, el: HTMLElement): void {
  handle.addEventListener("pointerdown", e => {
    if ((e.target as HTMLElement).closest("button")) return;
    const sx = e.clientX - el.offsetLeft;
    const sy = e.clientY - el.offsetTop;
    const move = (ev: PointerEvent) => {
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - sx))}px`;
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - sy))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

/** Simple modal prompt with fields; resolves to the values or null when cancelled. */
export function prompt(title: string, fields: { name: string; label: string; value?: string; type?: string }[]): Promise<Record<string, string> | null> {
  return new Promise(resolve => {
    const key = `prompt-${Math.random()}`;
    let done = false;
    const body = openWindow(key, title, { width: 340, onClose: () => !done && resolve(null) })!;
    const inputs = fields.map(f => h("input", { name: f.name, value: f.value ?? "", type: f.type ?? "text" }));
    const form = h("form.stack", {
      onsubmit: (e: Event) => {
        e.preventDefault();
        done = true;
        resolve(Object.fromEntries(inputs.map(i => [i.name, i.value])));
        closeWindow(key);
      }
    },
      fields.map((f, i) => h("label.field", null, h("span", null, f.label), inputs[i])),
      h("div.row.end", null, h("button.primary", { type: "submit" }, "OK"))
    );
    body.append(form);
    inputs[0]?.focus();
  });
}

export function confirmDialog(message: string, confirmLabel = "Apagar"): Promise<boolean> {
  return new Promise(resolve => {
    const key = `confirm-${Math.random()}`;
    let done = false;
    const body = openWindow(key, "Confirmar", { width: 320, onClose: () => !done && resolve(false) })!;
    const answer = (v: boolean) => {
      done = true;
      resolve(v);
      closeWindow(key);
    };
    body.append(
      h("p", null, message),
      h("div.row.end", null,
        h("button", { onclick: () => answer(false) }, "Cancelar"),
        h("button.danger", { onclick: () => answer(true) }, confirmLabel))
    );
  });
}

export interface MenuItem {
  label: string;
  icon: string;
  run: () => void;
}

/** A small right-click menu at the pointer; closes on any click elsewhere or Escape. */
export function contextMenu(e: MouseEvent, items: MenuItem[]): void {
  e.preventDefault();
  document.querySelector(".context-menu")?.remove();
  if (!items.length) return;
  const menu = h("menu.context-menu", null, items.map(it => h("li", null, h("button", {
    onclick: () => {
      close();
      it.run();
    }
  }, h("i", { className: it.icon }), " ", it.label))));
  document.body.append(menu);
  const { innerWidth: w, innerHeight: hgt } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, w - r.width - 4)}px`;
  menu.style.top = `${Math.min(e.clientY, hgt - r.height - 4)}px`;
  const away = (ev: Event) => {
    if (ev instanceof KeyboardEvent && ev.key !== "Escape") return;
    if (ev.target instanceof Node && menu.contains(ev.target) && !(ev instanceof KeyboardEvent)) return;
    close();
  };
  const close = () => {
    menu.remove();
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", away, true);
  };
  setTimeout(() => {
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", away, true);
  });
}
