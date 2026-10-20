import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.resolve(process.env.MESA_DATA ?? path.join(ROOT, "data"));
export const WORLDS_DIR = path.join(DATA_DIR, "worlds");
export const CLIENT_DIST = path.join(ROOT, "dist", "client");

const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function worldDir(id: string): string {
  if (!WORLD_ID.test(id)) throw new Error(`Invalid world id "${id}" (use lowercase letters, digits and dashes)`);
  return path.join(WORLDS_DIR, id);
}

/** Resolve a user-supplied relative path inside `base`, refusing anything that escapes it. */
export function safeJoin(base: string, rel: string): string {
  const resolved = path.resolve(base, rel.replace(/^[/\\]+/, ""));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error("Invalid path");
  return resolved;
}
