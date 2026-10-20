import type { SettingDoc } from "../../shared/protocol.ts";
import { SETTING_MAP, userSetting, userStorageKey, worldSetting } from "../../shared/settings.ts";
import { game, toast } from "./game.ts";

const KEY = "mesa.settings";

function readClient(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

/**
 * Settings from the client's point of view: one `get` whatever the scope (world from Setting documents,
 * user from the User document, client from this browser), `set` writes to the right place, and
 * `onChange` fires when a value changes — here or because someone else changed a world setting.
 */
class Settings {
  #client = readClient();
  #listeners = new Map<string, Set<(value: unknown) => void>>();
  #last = new Map<string, unknown>();

  constructor() {
    const check = () => {
      for (const key of SETTING_MAP.keys()) {
        const v = this.get(key);
        if (this.#last.has(key) && JSON.stringify(this.#last.get(key)) !== JSON.stringify(v)) this.#fire(key, v);
        this.#last.set(key, v);
      }
    };
    game.on("Setting", check);
    game.on("User", e => e.ids.includes(game.userId) && check());
    game.on("ready", check);
  }

  get<T = unknown>(key: string): T {
    const def = SETTING_MAP.get(key);
    if (!def) throw new Error(`Unknown setting ${key}`);
    if (def.scope === "world") return worldSetting<T>(game, key);
    if (def.scope === "user") return userSetting<T>(game.user, key);
    return (key in this.#client ? this.#client[key] : def.default) as T;
  }

  async set(key: string, value: unknown): Promise<boolean> {
    const def = SETTING_MAP.get(key);
    if (!def) return false;
    if (def.scope === "world") {
      const res = await game.socket.timeout(10_000).emitWithAck("setting", { key, value });
      if (!res.ok) toast(res.error, "error");
      return res.ok;
    }
    if (def.scope === "user") {
      await game.update("User", { _id: game.userId, [`settings.${userStorageKey(key)}`]: value });
      return true;
    }
    this.#client[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.#client));
    } catch {
      // Private mode: this visit only.
    }
    this.#fire(key, value);
    this.#last.set(key, value);
    return true;
  }

  onChange(key: string, fn: (value: unknown) => void): () => void {
    if (!this.#listeners.has(key)) this.#listeners.set(key, new Set());
    this.#listeners.get(key)!.add(fn);
    return () => this.#listeners.get(key)!.delete(fn);
  }

  #fire(key: string, value: unknown): void {
    for (const fn of this.#listeners.get(key) ?? []) fn(value);
  }

  /** The Setting document behind a world setting (if it was ever changed). */
  doc(key: string): SettingDoc | undefined {
    return game.all<SettingDoc>("Setting").find(s => s.key === key);
  }
}

export const settings = new Settings();
