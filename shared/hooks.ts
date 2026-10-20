/**
 * Named events that packages and macros hook into (Foundry's Hooks): `on` registers, `call` stops at the
 * first listener returning false (and reports that, so the caller can cancel), `callAll` runs every
 * listener. A throwing listener is reported and skipped; it never breaks the caller.
 */
export type HookFn = (...args: any[]) => unknown;

interface Entry {
  id: number;
  hook: string;
  fn: HookFn;
  once: boolean;
}

export class HookRegistry {
  #events = new Map<string, Entry[]>();
  #ids = new Map<number, Entry>();
  #next = 1;
  /** Where listener errors go (the client shows a notice). */
  onError: (hook: string, error: unknown) => void = (hook, error) => console.error(`Hook "${hook}" failed:`, error);

  /** Register a listener; returns an id usable with `off`. */
  on(hook: string, fn: HookFn, opts: { once?: boolean } = {}): number {
    const entry = { id: this.#next++, hook, fn, once: !!opts.once };
    const list = this.#events.get(hook) ?? [];
    list.push(entry);
    this.#events.set(hook, list);
    this.#ids.set(entry.id, entry);
    return entry.id;
  }

  once(hook: string, fn: HookFn): number {
    return this.on(hook, fn, { once: true });
  }

  /** Remove a listener by id, or by hook name + function. */
  off(hookOrId: string | number, fn?: HookFn): void {
    const entry = typeof hookOrId === "number"
      ? this.#ids.get(hookOrId)
      : this.#events.get(hookOrId)?.find(e => e.fn === fn);
    if (!entry) return;
    this.#ids.delete(entry.id);
    const list = this.#events.get(entry.hook)!.filter(e => e !== entry);
    if (list.length) this.#events.set(entry.hook, list);
    else this.#events.delete(entry.hook);
  }

  /** Run every listener. */
  callAll(hook: string, ...args: unknown[]): void {
    for (const entry of [...(this.#events.get(hook) ?? [])]) this.#run(entry, args);
  }

  /** Run listeners in order until one returns false; returns false when that happened (= cancel). */
  call(hook: string, ...args: unknown[]): boolean {
    for (const entry of [...(this.#events.get(hook) ?? [])]) {
      if (this.#run(entry, args) === false) return false;
    }
    return true;
  }

  /** Hook names with listeners and how many each has (for the developer panel). */
  get events(): Record<string, number> {
    return Object.fromEntries([...this.#events].map(([k, v]) => [k, v.length]));
  }

  #run(entry: Entry, args: unknown[]): unknown {
    if (entry.once) this.off(entry.id);
    try {
      return entry.fn(...args);
    } catch (err) {
      if (entry.hook !== "error") {
        this.onError(entry.hook, err);
        this.callAll("error", entry.hook, err);
      }
      return undefined;
    }
  }
}
