import crypto from "node:crypto";

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

/** In-memory login sessions. Restarting the server logs everybody out. */
export class Sessions {
  #byId = new Map<string, { userId: string; created: number }>();
  static readonly COOKIE = "mesa_session";
  static readonly MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;

  create(userId: string): string {
    const id = crypto.randomBytes(32).toString("base64url");
    this.#byId.set(id, { userId, created: Date.now() });
    return id;
  }

  userId(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    const s = this.#byId.get(sessionId);
    if (!s) return null;
    if (Date.now() - s.created > Sessions.MAX_AGE_MS) {
      this.#byId.delete(sessionId);
      return null;
    }
    return s.userId;
  }

  destroy(sessionId: string | undefined): void {
    if (sessionId) this.#byId.delete(sessionId);
  }

  destroyForUser(userId: string): void {
    for (const [id, s] of this.#byId) if (s.userId === userId) this.#byId.delete(id);
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
