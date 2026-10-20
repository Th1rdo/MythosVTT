import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import type {
  ActorDoc, BaseDoc, DocEvent, DocRequest, DocResponse, DocType, LevelDoc, PingEvent, RollRequest, SceneDoc, TokenDoc, UserDoc, WorldSnapshot
} from "../../shared/protocol.ts";
import { DOC_TYPES } from "../../shared/protocol.ts";
import type { DocLookup } from "../../shared/permissions.ts";
import { ownsActor } from "../../shared/permissions.ts";
import { defaultLevel, sceneLevels } from "../../shared/levels.ts";

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
        this.online = ids;
        this.#emitSimple("presence");
      });
      this.socket.on("ping", (p: PingEvent) => this.#emitSimple("ping", p));
      this.socket.on("viewing", (v: Record<string, string | null>) => {
        this.viewing = v;
        this.#emitSimple("presence");
      });
      this.socket.on("connect", () => this.socket.emit("viewing", this.viewedSceneId));
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
    if (e.op === "delete") {
      const docs = e.result.map(id => map.get(id)).filter((d): d is BaseDoc => !!d);
      for (const id of e.result) map.delete(id);
      this.#emit(e.type, { op: "delete", docs, ids: e.result });
    } else {
      for (const d of e.result) map.set(d._id, d);
      this.#emit(e.type, { op: e.op, docs: e.result, ids: e.result.map(d => d._id) });
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

  create<T = BaseDoc>(type: DocType, data: Record<string, unknown> | Record<string, unknown>[], parent?: string) {
    return this.request<T>({ op: "create", type, parent, data: Array.isArray(data) ? data : [data] });
  }

  update<T = BaseDoc>(type: DocType, updates: ({ _id: string } & Record<string, unknown>) | ({ _id: string } & Record<string, unknown>)[], parent?: string) {
    return this.request<T>({ op: "update", type, parent, updates: Array.isArray(updates) ? updates : [updates] });
  }

  delete(type: DocType, ids: string | string[], parent?: string) {
    return this.request<string>({ op: "delete", type, parent, ids: Array.isArray(ids) ? ids : [ids] });
  }

  async roll(req: RollRequest): Promise<void> {
    const res: DocResponse = await this.socket.timeout(10_000).emitWithAck("roll", req);
    if (!res.ok) toast(res.error, "error");
  }

  ping(x: number, y: number): void {
    if (this.viewedSceneId) this.socket.emit("ping", { sceneId: this.viewedSceneId, x, y });
  }

  pullPlayers(sceneId: string): void {
    this.socket.emit("pull", sceneId);
  }
}

export const game = new Game();

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const host = document.getElementById("toasts")!;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), 4000);
}
