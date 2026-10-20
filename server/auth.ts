import crypto from "node:crypto";
import fs from "node:fs";

const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

/** Users without a password hash accept an empty password. */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return password === "";
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, KEYLEN);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Login sessions. Kept in memory and mirrored to a file so a server restart doesn't log everyone
 * out. The file stores only SHA-256 hashes of session ids, so reading it doesn't let anyone log in.
 */
export class Sessions {
  #byHash = new Map<string, { userId: string; created: number }>();
  #file: string | null;
  static readonly COOKIE = "mesa_session";
  static readonly MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;

  constructor(file: string | null = null) {
    this.#file = file;
    if (!file || !fs.existsSync(file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { userId: string; created: number }>;
      for (const [hash, s] of Object.entries(saved)) if (Date.now() - s.created <= Sessions.MAX_AGE_MS) this.#byHash.set(hash, s);
    } catch {
      // Corrupt file: start fresh.
    }
  }

  static #hash(id: string): string {
    return crypto.createHash("sha256").update(id).digest("hex");
  }

  #persist(): void {
    if (!this.#file) return;
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#byHash)), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  create(userId: string): string {
    const id = crypto.randomBytes(32).toString("base64url");
    this.#byHash.set(Sessions.#hash(id), { userId, created: Date.now() });
    this.#persist();
    return id;
  }

  userId(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    const hash = Sessions.#hash(sessionId);
    const s = this.#byHash.get(hash);
    if (!s) return null;
    if (Date.now() - s.created > Sessions.MAX_AGE_MS) {
      this.#byHash.delete(hash);
      this.#persist();
      return null;
    }
    return s.userId;
  }

  destroy(sessionId: string | undefined): void {
    if (sessionId && this.#byHash.delete(Sessions.#hash(sessionId))) this.#persist();
  }

  destroyForUser(userId: string): void {
    let changed = false;
    for (const [hash, s] of this.#byHash) if (s.userId === userId) changed = this.#byHash.delete(hash) || changed;
    if (changed) this.#persist();
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
