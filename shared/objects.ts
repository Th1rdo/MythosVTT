export function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Expand `{"system.PV.value": 3}` into `{system: {PV: {value: 3}}}`. */
export function expandDotKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const parts = key.split(".");
    let target: Record<string, any> = out;
    for (const p of parts.slice(0, -1)) {
      if (!isPlainObject(target[p])) target[p] = {};
      target = target[p];
    }
    const last = parts[parts.length - 1];
    target[last] = isPlainObject(value) && isPlainObject(target[last])
      ? mergeDeep(target[last], expandDotKeys(value))
      : isPlainObject(value) ? expandDotKeys(value) : value;
  }
  return out;
}

/** Deep-merge `changes` into a copy of `base`. Arrays and primitives replace; objects merge. */
export function mergeDeep<T extends Record<string, any>>(base: T, changes: Record<string, unknown>): T {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(changes)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeDeep(out[k], v) : structuredClone(v);
  }
  return out as T;
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomId(length = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => ID_CHARS[b % ID_CHARS.length]).join("");
}
