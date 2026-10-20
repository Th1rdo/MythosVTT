import type { BaseDoc, DocType, ModuleMessage, PackageInfo } from "../../shared/protocol.ts";
import type { SettingDef, SettingScope, SettingType } from "../../shared/settings.ts";
import { registerSetting } from "../../shared/settings.ts";
import { randomId } from "../../shared/objects.ts";
import { game, notify, toast } from "./game.ts";
import { hooks } from "./hooks.ts";
import { lang, t } from "./i18n.ts";
import { settings } from "./settings.ts";
import type { KeyAction } from "./keybindings.ts";
import { registerKey } from "./keybindings.ts";
import type { Board } from "./canvas/board.ts";
import { closeWindow, confirmDialog, openWindow, prompt } from "./ui/windows.ts";
import { browseFiles } from "./ui/file-picker.ts";
import { openSheet } from "./ui/sheet.ts";
import { openImagePopout, openJournal } from "./ui/journal.ts";
import { send } from "./ui/chat.ts";

/**
 * Loading packages and the API they get (`window.mesa`, also passed to nothing in particular — packages
 * are plain ES modules that read the global, as Foundry modules read `game`/`Hooks`). Packages load after
 * the world snapshot and before the `init` hook: styles, then language files, then scripts in dependency order.
 */

/** Package strings for the current language, merged in load order. */
const strings = new Map<string, string>();

function pickLanguage(list: PackageInfo["languages"]): PackageInfo["languages"][number] | undefined {
  const base = lang.split("-")[0];
  return list.find(l => l.lang === lang) ?? list.find(l => l.lang.split("-")[0] === base) ?? list.find(l => l.lang === "en") ?? list[0];
}

/** Foundry-style language files nest keys ({"A": {"B": "x"}} = "A.B"). */
function flatten(obj: unknown, prefix = "", out = strings): void {
  if (typeof obj === "string") out.set(prefix, obj);
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
}

const url = (p: PackageInfo, file: string) => `/modules/${p.id}/${file.split("/").map(encodeURIComponent).join("/")}`;

export async function loadPackages(list: PackageInfo[]): Promise<void> {
  mesa.packages = list;
  for (const p of list) {
    for (const css of p.styles) {
      const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: url(p, css) });
      link.dataset.package = p.id;
      document.head.append(link);
    }
  }
  await Promise.all(list.map(async p => {
    const l = pickLanguage(p.languages);
    if (!l) return;
    try {
      flatten(await fetch(url(p, l.path)).then(r => r.json()));
    } catch {
      console.warn(`Package ${p.id}: could not read ${l.path}`);
    }
  }));
  for (const p of list) {
    for (const file of p.esmodules) {
      try {
        await import(/* @vite-ignore */ url(p, file));
      } catch (err) {
        console.error(`Package ${p.id} failed to load ${file}:`, err);
        notify(t("O módulo «{titulo}» não carregou: {erro}", { titulo: p.title, erro: err instanceof Error ? err.message : String(err) }), "error");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The API

interface SettingOptions {
  name: string;
  hint?: string;
  scope?: SettingScope;
  /** "boolean" | "number" | "string" | "object", or a full SettingType; `choices` makes a select. */
  type?: "boolean" | "number" | "string" | "object" | SettingType;
  choices?: Record<string, string>;
  range?: { min: number; max: number; step?: number };
  default: unknown;
  /** Show it in Definições → Módulos (default true unless the type is "object"). */
  config?: boolean;
  reload?: boolean;
  onChange?: (value: unknown) => void;
}

const titleOf = (pkg: string) => mesa.packages.find(p => p.id === pkg)?.title ?? pkg;

function settingType(o: SettingOptions): SettingType {
  if (o.choices) return { kind: "select", choices: Object.entries(o.choices) };
  if (typeof o.type === "object") return o.type;
  if (o.type === "number") return o.range ? { kind: "number", ...o.range, range: true } : { kind: "number" };
  return { kind: o.type ?? (typeof o.default === "boolean" ? "boolean" : typeof o.default === "number" ? "number" : typeof o.default === "string" ? "string" : "object") } as SettingType;
}

const socketListeners = new Map<string, Set<(data: unknown, userId: string) => void>>();
let socketBound = false;
function bindSocket(): void {
  if (socketBound) return;
  socketBound = true;
  game.socket.on("module", (m: ModuleMessage) => {
    for (const fn of socketListeners.get(m.id) ?? []) {
      try {
        fn(m.data, m.userId ?? "");
      } catch (err) {
        console.error(`Package ${m.id} socket listener failed:`, err);
      }
    }
  });
}

const getPath = (obj: unknown, path: string): unknown => path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);

export const mesa = {
  version: "0.1.0",
  game,
  hooks,
  /** The map; null until the canvas exists (use the canvasReady hook). */
  board: null as Board | null,
  /** Packages running in this world. */
  packages: [] as PackageInfo[],

  /** Mesa's own strings (pt-PT source → current language). */
  t,
  i18n: {
    lang,
    has: (key: string) => strings.has(key),
    /** A package string by key, from its language file (the key itself when missing). */
    localize: (key: string) => strings.get(key) ?? key,
    format: (key: string, data: Record<string, unknown> = {}) =>
      (strings.get(key) ?? key).replace(/\{(\w+)\}/g, (m, k: string) => (k in data ? String(data[k]) : m))
  },

  settings: {
    /** Register `<pkg>.<name>`; world settings are the GM's, user settings follow the account, client ones stay in this browser. */
    register(pkg: string, name: string, o: SettingOptions): SettingDef {
      const type = settingType(o);
      const def = registerSetting({
        key: `${pkg}.${name}`, scope: o.scope ?? "world", category: "modules", group: titleOf(pkg), name: o.name, hint: o.hint, type,
        default: o.default, reload: o.reload, hidden: o.config === false || (o.config === undefined && type.kind === "object")
      });
      if (o.onChange) settings.onChange(def.key, o.onChange);
      return def;
    },
    get: <T = unknown>(key: string) => settings.get<T>(key),
    set: (key: string, value: unknown) => settings.set(key, value),
    onChange: (key: string, fn: (value: unknown) => void) => settings.onChange(key, fn)
  },

  keybindings: {
    /** Register `<pkg>.<id>`: bindings by physical key (`KeyG`, `Digit1`…), rebindable in Definições → Teclas. */
    register(pkg: string, id: string, action: Omit<KeyAction, "id" | "category"> & { category?: string }): void {
      registerKey({ ...action, id: `${pkg}.${id}`, category: action.category ?? titleOf(pkg) });
    }
  },

  socket: {
    /** Send to everyone else in the world (or `users`); needs "socket": true in module.json. */
    emit(pkg: string, data: unknown, users?: string[]): void {
      game.socket.emit("module", { id: pkg, data, users } satisfies ModuleMessage);
    },
    on(pkg: string, fn: (data: unknown, userId: string) => void): () => void {
      bindSocket();
      if (!socketListeners.has(pkg)) socketListeners.set(pkg, new Set());
      socketListeners.get(pkg)!.add(fn);
      return () => socketListeners.get(pkg)!.delete(fn);
    }
  },

  /** Package data on any document, under flags.<pkg>.<key>. */
  flags: {
    get: (doc: BaseDoc | undefined, pkg: string, key: string) => getPath((doc as { flags?: unknown } | undefined)?.flags, `${pkg}.${key}`),
    set: (type: DocType, doc: BaseDoc, pkg: string, key: string, value: unknown) =>
      game.update(type, { _id: doc._id, [`flags.${pkg}.${key}`]: value }, doc._parent),
    unset: (type: DocType, doc: BaseDoc, pkg: string, key: string) =>
      game.update(type, { _id: doc._id, [`flags.${pkg}.${key}`]: null }, doc._parent)
  },

  notify,
  toast,
  dialogs: { confirm: confirmDialog, prompt },
  files: { browse: browseFiles },
  ui: { openWindow, closeWindow, openSheet, openJournal, openImagePopout },
  chat: (text: string) => send(text),
  utils: {
    randomId,
    getProperty: getPath,
    escapeHtml: (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!),
    debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return (...a: A) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...a), ms);
      };
    }
  }
};

export type MesaApi = typeof mesa;
