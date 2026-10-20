import { game } from "./game.ts";

/**
 * Keyboard shortcuts. Actions are registered with default bindings (physical keys, `event.code`, so they
 * stay in place on any keyboard layout); each browser can rebind them (stored in localStorage). One
 * listener dispatches: when several actions share a key, they run by precedence until one handles it
 * (returns true) — e.g. C toggles combat for selected tokens, otherwise opens your character sheet.
 */
export type Modifier = "Control" | "Shift" | "Alt";
export interface Binding {
  key: string;
  modifiers?: Modifier[];
}

export interface KeyAction {
  id: string;
  name: string;
  category: string;
  /** Editable defaults. */
  bindings: Binding[];
  /** Always-on bindings that can't be changed (Delete, Escape…). */
  fixed?: Binding[];
  /** Modifiers that may be held without breaking the match (Shift for "free" moves). */
  allow?: Modifier[];
  gm?: boolean;
  /** Fire again while the key is held. */
  repeat?: boolean;
  /** Lower runs first. */
  precedence?: number;
  onDown: (e: KeyboardEvent) => boolean | void;
  onUp?: (e: KeyboardEvent) => void;
}

const KEY = "mesa.keybindings";
const actions = new Map<string, KeyAction>();
let custom: Record<string, Binding[]> = load();
const listeners = new Set<() => void>();

function load(): Record<string, Binding[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}
function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(custom));
  } catch {
    // Private mode: this visit only.
  }
  for (const fn of listeners) fn();
}

export function registerKey(action: KeyAction): void {
  actions.set(action.id, { precedence: 0, ...action });
}

export function keyActions(): KeyAction[] {
  return [...actions.values()].filter(a => !a.gm || game.isGM);
}

/** Current editable bindings of an action (custom or default). */
export function bindingsOf(id: string): Binding[] {
  return custom[id] ?? actions.get(id)?.bindings ?? [];
}

export function setBindings(id: string, bindings: Binding[] | null): void {
  if (bindings === null) delete custom[id];
  else custom[id] = bindings;
  save();
}

export function resetAllBindings(): void {
  custom = {};
  save();
}

export function onBindingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const MODIFIER_CODES = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);

/** The modifiers held in an event (Cmd counts as Control, as on Foundry for macOS). */
export function eventModifiers(e: KeyboardEvent | MouseEvent): Modifier[] {
  const out: Modifier[] = [];
  if (e.ctrlKey || e.metaKey) out.push("Control");
  if (e.shiftKey) out.push("Shift");
  if (e.altKey) out.push("Alt");
  return out;
}

/** A binding from a key press (null for a lone modifier). */
export function bindingFromEvent(e: KeyboardEvent): Binding | null {
  if (MODIFIER_CODES.has(e.code) || !e.code) return null;
  return { key: e.code, modifiers: eventModifiers(e) };
}

function matches(b: Binding, e: KeyboardEvent, allow: Modifier[] = []): boolean {
  if (b.key !== e.code) return false;
  const held = eventModifiers(e);
  const want = b.modifiers ?? [];
  return want.every(m => held.includes(m)) && held.every(m => want.includes(m) || allow.includes(m));
}

const LABELS: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Delete: "Del", Backspace: "⌫", Escape: "Esc", Space: "Espaço",
  Enter: "Enter", Tab: "Tab", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", PageUp: "PgUp", PageDown: "PgDn",
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\"
};
const MOD_LABELS: Record<Modifier, string> = { Control: "Ctrl", Shift: "Shift", Alt: "Alt" };

export function bindingLabel(b: Binding): string {
  const key = LABELS[b.key] ?? b.key.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ");
  return [...(b.modifiers ?? []).map(m => MOD_LABELS[m]), key].join("+");
}

const sameBinding = (a: Binding, b: Binding) =>
  a.key === b.key && [...(a.modifiers ?? [])].sort().join() === [...(b.modifiers ?? [])].sort().join();

/** Other actions using the same binding (to warn when rebinding). */
export function conflictsFor(id: string, b: Binding): KeyAction[] {
  return keyActions().filter(a => a.id !== id && [...(a.fixed ?? []), ...bindingsOf(a.id)].some(x => sameBinding(x, b)));
}

const held = new Set<string>();

function inTextField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  if (t?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return true;
  // Enter/Space on a focused button or link press it; leave them alone.
  return (e.code === "Enter" || e.code === "Space") && !!t?.closest?.("button, a[href], [role=button]");
}

/** Start listening (after the canvas, so a tool's own keys — Enter to close a polygon — come first). */
export function startKeybindings(): void {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
}

function onKeyDown(e: KeyboardEvent): void {
  if (inTextField(e)) return;
  const candidates = keyActions()
    .filter(a => [...(a.fixed ?? []), ...bindingsOf(a.id)].some(b => matches(b, e, a.allow)))
    .sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
  for (const a of candidates) {
    if (e.repeat && !a.repeat) continue;
    if (a.onDown(e) === true) {
      e.preventDefault();
      held.add(`${a.id}:${e.code}`);
      return;
    }
  }
}

function onKeyUp(e: KeyboardEvent): void {
  for (const a of actions.values()) {
    if (held.delete(`${a.id}:${e.code}`)) a.onUp?.(e);
  }
}
