import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import type {
  ActorDoc, BaseDoc, CombatDoc, RollMode, DocEvent, DocRequest, DocResponse, DocType, LevelDoc, PingEvent, RollRequest, SceneDoc, TokenDoc, UserDoc, WorldSnapshot
} from "../../shared/protocol.ts";
import { DOC_TYPES } from "../../shared/protocol.ts";
import type { DocLookup } from "../../shared/permissions.ts";
import { ownsActor } from "../../shared/permissions.ts";
import { defaultLevel, sceneLevels } from "../../shared/levels.ts";
import { userSetting } from "../../shared/settings.ts";
import { hooks } from "./hooks.ts";

/** Hook options for document requests: `noHook` skips the pre* hooks (Foundry's option of the same name). */
export interface DocOptions {
  noHook?: boolean;
}

/** Top-level fields that differ between two versions of a document (what an update hook gets as `changes`). */
function changedFields(before: BaseDoc | undefined, after: BaseDoc): Record<string, unknown> {
  if (!before) return { ...after };
  const out: Record<string, unknown> = { _id: after._id };
  const a = before as unknown as Record<string, unknown>, b = after as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = b[k];
  }
  return out;
}

type Listener = (e: { op: DocEvent["op"] | "reset"; docs: BaseDoc[]; ids: string[] }) => void;

/**
 * Client-side mirror of the world. Holds whatever documents the server lets this user see and keeps
 * them current from `doc` events. UI modules subscribe per document type.
 */
export class Game implements DocLookup {
  socket!: Socket;
  world!: WorldSnapshot["world"];
  userId!: string;
  online: string[] = [];
  /** Packages running in this world (from the snapshot). */
  packages: WorldSnapshot["packages"] = [];
  /** userId → scene they're viewing. */
  viewing: Record<string, string | null> = {};
  /** Round-trip time to the server in ms (rolling average). */
  latency: number | null = null;
  /** Scene the local user is looking at (GMs can browse; players follow the active scene). */
  viewedSceneId: string | null = null;
  /** Level of the viewed scene being shown (scenes with levels). */
  viewedLevelId: string | null = null;

  #docs = new Map<DocType, Map<string, BaseDoc>>(DOC_TYPES.map(t => [t, new Map()]));
  #listeners = new Map<DocType | "presence" | "view" | "ping" | "ready", Set<Listener | ((arg?: any) => void)>>();

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io({ transports: ["websocket"] });
      this.socket.on("connect_error", err => reject(err));
      this.socket.on("world", (snap: WorldSnapshot) => {
        this.packages = snap.packages ?? [];
        this.world = snap.world;
        this.userId = snap.userId;
        this.online = snap.online;
        for (const t of DOC_TYPES) {
          const map = this.#docs.get(t)!;
          map.clear();
          for (const d of snap.docs[t] ?? []) map.set(d._id, d);
          this.#emit(t, { op: "reset", docs: [...map.values()], ids: [] });
        }
        if (!this.viewedSceneId || !this.get("Scene", this.viewedSceneId)) this.viewedSceneId = this.activeScene?._id ?? null;
        if (!this.viewedLevelId || !this.get("Level", this.viewedLevelId)) this.viewedLevelId = this.#initialLevel(this.viewedSceneId);
        this.socket.emit("viewing", this.viewedSceneId);
        this.#emitSimple("view");
        this.#emitSimple("ready");
        resolve();
      });
      this.socket.on("doc", (e: DocEvent) => this.#onDoc(e));
      this.socket.on("presence", (ids: string[]) => {
        const before = new Set(this.online);
        this.online = ids;
        for (const id of ids) if (!before.has(id)) hooks.callAll("userConnected", this.get("User", id), true);
        for (const id of before) if (!ids.includes(id)) hooks.callAll("userConnected", this.get("User", id), false);
        this.#emitSimple("presence");
      });
      this.socket.on("ping", (p: PingEvent) => this.#emitSimple("ping", p));
      this.socket.on("viewing", (v: Record<string, string | null>) => {
        this.viewing = v;
        this.#emitSimple("presence");
      });
      this.socket.on("connect", () => this.socket.emit("viewing", this.viewedSceneId));
      // Kicked by the GM: log out, back to the join screen.
      this.socket.on("kicked", async () => {
        await fetch("/api/logout", { method: "POST" }).catch(() => {});
        location.reload();
      });
      setInterval(async () => {
        const t = performance.now();
        try {
          await this.socket.timeout(5000).emitWithAck("latency");
          const ms = performance.now() - t;
          this.latency = this.latency === null ? ms : this.latency * 0.7 + ms * 0.3;
        } catch {
          this.latency = null;
        }
      }, 5000);
      this.socket.on("pull", (sceneId: string) => this.view(sceneId));
      this.socket.on("disconnect", reason => {
        if (reason === "io server disconnect") location.reload();
      });
    });
  }

  #onDoc(e: DocEvent): void {
    const map = this.#docs.get(e.type)!;
    const options = { parent: undefined as string | undefined };
    if (e.op === "delete") {
      const docs = e.result.map(id => map.get(id)).filter((d): d is BaseDoc => !!d);
      for (const id of e.result) map.delete(id);
      this.#emit(e.type, { op: "delete", docs, ids: e.result });
      for (const d of docs) hooks.callAll(`delete${e.type}`, d, { ...options, parent: d._parent }, e.userId);
    } else {
      const before = e.result.map(d => map.get(d._id));
      for (const d of e.result) map.set(d._id, d);
      this.#emit(e.type, { op: e.op, docs: e.result, ids: e.result.map(d => d._id) });
      e.result.forEach((d, i) => {
        const changes = changedFields(before[i], d);
        if (e.op === "create" || !before[i]) hooks.callAll(`create${e.type}`, d, { ...options, parent: d._parent }, e.userId);
        else hooks.callAll(`update${e.type}`, d, changes, { ...options, parent: d._parent }, e.userId);
        this.#derivedHooks(e.type, d, before[i], changes);
      });
    }
    // Players follow their own token when it changes level (stairs, HUD).
    if (e.type === "Token" && e.op === "update" && !this.isGM) {
      const moved = (e.result as TokenDoc[]).find(t => t._parent === this.viewedSceneId && t.level && t.level !== this.viewedLevelId && this.owns(this.get<ActorDoc>("Actor", t.actorId)));
      if (moved) this.viewLevel(moved.level);
    }
    // Players follow the active scene.
    if (e.type === "Scene" && !this.isGM) {
      const active = this.activeScene?._id ?? null;
      if (active !== this.viewedSceneId) this.view(active);
    }
  }

  /** Hooks that follow from a document change: combat turns/rounds, pause. */
  #derivedHooks(type: DocType, doc: BaseDoc, before: BaseDoc | undefined, changes: Record<string, unknown>): void {
    if (type === "Combat" && before) {
      // Mesa keeps the turn as the current combatant's id.
      const c = doc as CombatDoc, b = before as CombatDoc;
      const info = { round: c.round, combatantId: c.current, previous: { round: b.round, combatantId: b.current } };
      if (c.round !== b.round) hooks.callAll("combatRound", doc, info);
      if (c.round !== b.round || c.current !== b.current) hooks.callAll("combatTurn", doc, info);
    }
    if (type === "Setting" && (doc as unknown as { key: string }).key === "core.paused" && "value" in changes) {
      hooks.callAll("pauseGame", !!(doc as unknown as { value: unknown }).value);
    }
  }

  on(type: DocType, fn: Listener): () => void;
  on(type: "presence" | "view" | "ready", fn: () => void): () => void;
  on(type: "ping", fn: (p: PingEvent) => void): () => void;
  on(type: any, fn: any): () => void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(fn);
    return () => this.#listeners.get(type)!.delete(fn);
  }

  #emit(type: DocType, e: Parameters<Listener>[0]): void {
    for (const fn of this.#listeners.get(type) ?? []) (fn as Listener)(e);
  }

  #emitSimple(type: "presence" | "view" | "ping" | "ready", arg?: unknown): void {
    for (const fn of this.#listeners.get(type) ?? []) (fn as (a?: unknown) => void)(arg);
  }

  get<T extends BaseDoc = BaseDoc>(type: DocType, id: string | null | undefined): T | undefined {
    return id ? (this.#docs.get(type)!.get(id) as T | undefined) : undefined;
  }

  all<T extends BaseDoc = BaseDoc>(type: DocType): T[] {
    return [...this.#docs.get(type)!.values()] as T[];
  }

  children<T extends BaseDoc = BaseDoc>(type: DocType, parentId: string): T[] {
    return this.all<T>(type).filter(d => d._parent === parentId);
  }

  get user(): UserDoc {
    return this.get<UserDoc>("User", this.userId)!;
  }

  get isGM(): boolean {
    return this.user?.role === "gm";
  }

  get activeScene(): SceneDoc | undefined {
    return this.all<SceneDoc>("Scene").find(s => s.active);
  }

  get viewedScene(): SceneDoc | undefined {
    return this.get<SceneDoc>("Scene", this.viewedSceneId);
  }

  view(sceneId: string | null, levelId?: string | null): void {
    this.viewedSceneId = sceneId;
    this.viewedLevelId = levelId !== undefined ? levelId : this.#initialLevel(sceneId);
    this.socket?.emit("viewing", sceneId);
    this.#emitSimple("view");
  }

  get viewedLevel(): LevelDoc | undefined {
    return this.get<LevelDoc>("Level", this.viewedLevelId);
  }

  viewLevel(levelId: string | null): void {
    if (levelId === this.viewedLevelId) return;
    this.view(this.viewedSceneId, levelId);
  }

  /** Players start on the level of their token; GMs (and players without one) on the scene's default. */
  #initialLevel(sceneId: string | null): string | null {
    const scene = this.get<SceneDoc>("Scene", sceneId);
    if (!scene) return null;
    const levels = sceneLevels(scene._id, this);
    if (!levels.length) return null;
    if (!this.isGM) {
      const mine = this.children<TokenDoc>("Token", scene._id).find(t => this.owns(this.get<ActorDoc>("Actor", t.actorId)));
      if (mine?.level && levels.some(l => l._id === mine.level)) return mine.level;
    }
    return defaultLevel(scene, this)?._id ?? null;
  }

  owns(actor: ActorDoc | undefined): boolean {
    return !!actor && ownsActor(actor._id, this.user, this);
  }

  // -------------------------------------------------------------------------
  // Requests

  async request<T = BaseDoc>(req: DocRequest): Promise<T[]> {
    const res: DocResponse = await this.socket.timeout(10_000).emitWithAck("doc", req);
    if (!res.ok) {
      toast(res.error, "error");
      throw new Error(res.error);
    }
    return res.result as T[];
  }

  // The pre* hooks run here, on the requesting client, before the server sees anything (as in Foundry);
  // a listener returning false drops that document from the request.

  async create<T = BaseDoc>(type: DocType, data: Record<string, unknown> | Record<string, unknown>[], parent?: string, opts: DocOptions = {}): Promise<T[]> {
    let list = Array.isArray(data) ? data : [data];
    if (!opts.noHook) list = list.filter(d => hooks.call(`preCreate${type}`, d, { parent }, this.userId));
    if (!list.length) return [];
    return this.request<T>({ op: "create", type, parent, data: list });
  }

  async update<T = BaseDoc>(type: DocType, updates: ({ _id: string } & Record<string, unknown>) | ({ _id: string } & Record<string, unknown>)[], parent?: string, opts: DocOptions = {}): Promise<T[]> {
    let list = Array.isArray(updates) ? updates : [updates];
    if (!opts.noHook) list = list.filter(u => hooks.call(`preUpdate${type}`, this.get(type, u._id), u, { parent }, this.userId));
    if (!list.length) return [];
    return this.request<T>({ op: "update", type, parent, updates: list });
  }

  async delete(type: DocType, ids: string | string[], parent?: string, opts: DocOptions = {}): Promise<string[]> {
    let list = Array.isArray(ids) ? ids : [ids];
    if (!opts.noHook) list = list.filter(id => hooks.call(`preDelete${type}`, this.get(type, id), { parent }, this.userId));
    if (!list.length) return [];
    return this.request<string>({ op: "delete", type, parent, ids: list });
  }

  /** Roll on the server. Without a mode, the user's default roll mode (setting core.rollMode) applies. */
  async roll(req: RollRequest): Promise<void> {
    const mode = req.mode ?? (req.whisperGM ? "gm" : userSetting<RollMode>(this.user, "core.rollMode"));
    const res: DocResponse = await this.socket.timeout(10_000).emitWithAck("roll", { ...req, mode });
    if (!res.ok) toast(res.error, "error");
  }

  ping(x: number, y: number): void {
    if (this.viewedSceneId) this.socket.emit("ping", { sceneId: this.viewedSceneId, x, y });
  }

  /** Send everyone (or only `userIds`) to a scene. */
  pullPlayers(sceneId: string, userIds?: string[]): void {
    this.socket.emit("pull", sceneId, userIds);
  }
}

export const game = new Game();

export type NoticeKind = "info" | "warning" | "error" | "success";

export interface Notice {
  /** Change the text and/or the progress (0–1). At 1 a progress notice closes shortly after. */
  update(message?: string, progress?: number): void;
  remove(): void;
}

const MAX_NOTICES = 3;
const NOTICE_MS = 5000;
const waiting: { el: HTMLElement; permanent: boolean }[] = [];

/** Show the next waiting notices while there's room. */
function pumpNotices(): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  while (waiting.length && host.childElementCount < MAX_NOTICES) {
    const { el, permanent } = waiting.shift()!;
    host.append(el);
    if (!permanent) setTimeout(() => dismiss(el), NOTICE_MS);
  }
}

function dismiss(el: HTMLElement): void {
  if (!el.isConnected) {
    const i = waiting.findIndex(w => w.el === el);
    if (i >= 0) waiting.splice(i, 1);
    return;
  }
  el.classList.add("leaving");
  setTimeout(() => {
    el.remove();
    pumpNotices();
  }, 200);
}

/**
 * Notifications at the top of the screen (Foundry's ui.notifications): at most three at a time, the rest
 * wait their turn; the same message twice just restarts its timer; click one to dismiss it.
 */
export function notify(message: string, kind: NoticeKind = "info", opts: { permanent?: boolean; progress?: boolean } = {}): Notice {
  const host = document.getElementById("toasts");
  const same = host && [...host.children].find(c => c.textContent === message && c.classList.contains(kind)) as HTMLElement | undefined;
  if (same && !opts.progress) return { update: () => {}, remove: () => dismiss(same) };
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);
  const bar = opts.progress ? Object.assign(document.createElement("div"), { className: "toast-progress" }) : null;
  if (bar) el.append(bar);
  el.addEventListener("click", () => dismiss(el));
  waiting.push({ el, permanent: !!opts.permanent || !!opts.progress });
  pumpNotices();
  return {
    update: (m, p) => {
      if (m !== undefined) text.textContent = m;
      if (bar && p !== undefined) {
        bar.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
        if (p >= 1) setTimeout(() => dismiss(el), 1200);
      }
    },
    remove: () => dismiss(el)
  };
}

export function toast(message: string, kind: NoticeKind = "info"): void {
  notify(message, kind);
}

// A failing hook listener (a module or macro) shows a notice instead of breaking Mesa.
hooks.onError = (hook, error) => {
  console.error(`Hook "${hook}" failed:`, error);
  toast(`Erro num hook (${hook}): ${error instanceof Error ? error.message : String(error)}`, "error");
};
