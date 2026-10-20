import crypto from "node:crypto";
import type { Server, Socket } from "socket.io";
import type {
  BaseDoc, CombatAction, DocEvent, DocRequest, DocResponse, DocType, FogExplorationDoc, PingEvent, RollRequest, UserDoc, WallDoc, WorldSnapshot
} from "../shared/protocol.ts";
import { DOC_TYPES, DOOR, DOOR_STATE } from "../shared/protocol.ts";
import { canSee } from "../shared/permissions.ts";
import { roll } from "../shared/dice.ts";
import { runCombatAction } from "./combat.ts";
import type { Change, World } from "./world.ts";
import { Sessions, parseCookies } from "./auth.ts";

type Ack<T> = (response: T) => void;

/** Strip server-only fields before a document leaves the server; secret doors look like walls to players. */
export function publicDoc(type: DocType, doc: BaseDoc, viewer: UserDoc): BaseDoc {
  if (type === "User") {
    const { passwordHash, ...rest } = doc as UserDoc;
    return { ...rest, hasPassword: !!passwordHash };
  }
  if (type === "Wall" && viewer.role !== "gm" && (doc as WallDoc).door === DOOR.SECRET) {
    return { ...doc, door: DOOR.NONE, ds: DOOR_STATE.CLOSED };
  }
  return doc;
}

const secureRandomInt = (faces: number) => crypto.randomInt(1, faces + 1);

/**
 * Real-time layer: authenticates sockets from the session cookie, applies document requests to the
 * World, and fans out the resulting changes, filtered per user so nobody receives what they can't see.
 */
export class Hub {
  #io: Server;
  #world: World;
  #sessions: Sessions;

  constructor(io: Server, world: World, sessions: Sessions) {
    this.#io = io;
    this.#world = world;
    this.#sessions = sessions;
    io.use((socket, next) => {
      const sid = parseCookies(socket.handshake.headers.cookie)[Sessions.COOKIE];
      const user = world.user(sessions.userId(sid));
      if (!user) return next(new Error("unauthorized"));
      socket.data.userId = user._id;
      next();
    });
    io.on("connection", socket => this.#onConnect(socket));
  }

  #user(socket: Socket): UserDoc | undefined {
    return this.#world.user(socket.data.userId);
  }

  online(): string[] {
    const ids = new Set<string>();
    for (const s of this.#io.sockets.sockets.values()) ids.add(s.data.userId);
    return [...ids];
  }

  viewing(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const s of this.#io.sockets.sockets.values()) if (s.data.sceneId !== undefined) out[s.data.userId] = s.data.sceneId;
    return out;
  }

  #onConnect(socket: Socket): void {
    const user = this.#user(socket)!;
    socket.emit("world", this.#snapshot(user));
    this.#io.emit("presence", this.online());

    socket.on("doc", (req: DocRequest, ack: Ack<DocResponse>) => {
      const me = this.#user(socket);
      if (!me) return ack?.({ ok: false, error: "Sessão inválida" });
      try {
        const changes = this.#world.apply(req, me);
        this.#broadcast(changes, me._id);
        this.#revokeChangedLogins(changes, me._id);
        const primary = changes.filter(c => c.type === req.type);
        ack?.({
          ok: true,
          result: req.op === "delete" ? primary.map(c => c.before!._id) : primary.map(c => publicDoc(c.type, c.after!, me))
        });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on("roll", (req: RollRequest, ack: Ack<DocResponse>) => {
      const me = this.#user(socket);
      if (!me) return ack?.({ ok: false, error: "Sessão inválida" });
      try {
        const result = roll(String(req.formula ?? ""), secureRandomInt);
        const gms = this.#world.all<UserDoc>("User").filter(u => u.role === "gm").map(u => u._id);
        const [msg] = this.#world.createAsSystem("ChatMessage", [{
          author: me._id,
          speaker: { actor: req.speaker?.actor ?? null, alias: String(req.speaker?.alias || me.name).slice(0, 100) },
          content: "",
          flavor: req.flavor ? String(req.flavor).slice(0, 200) : null,
          roll: result,
          whisper: req.whisperGM ? [...new Set([...gms, me._id])] : null,
          timestamp: Date.now()
        }]);
        this.#broadcast([{ type: "ChatMessage", after: msg }], me._id);
        ack?.({ ok: true, result: [msg] });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on("ping", (ping: Omit<PingEvent, "userId">) => {
      if (typeof ping?.x !== "number" || typeof ping?.y !== "number") return;
      socket.broadcast.emit("ping", { ...ping, userId: socket.data.userId } satisfies PingEvent);
    });

    socket.on("combat", (action: CombatAction, ack?: Ack<DocResponse>) => {
      const me = this.#user(socket);
      if (!me) return ack?.({ ok: false, error: "Sessão inválida" });
      try {
        const changes = runCombatAction(this.#world, me, action);
        this.#broadcast(changes, me._id);
        ack?.({ ok: true, result: [] });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on("ruler", (r: { sceneId?: unknown; points?: unknown }) => {
      const points = Array.isArray(r?.points) ? r.points.slice(0, 50) : [];
      if (typeof r?.sceneId !== "string" || !points.every(p => typeof p?.x === "number" && typeof p?.y === "number")) return;
      socket.broadcast.emit("ruler", { userId: socket.data.userId, sceneId: r.sceneId, points: points.map(p => ({ x: p.x, y: p.y })) });
    });

    socket.on("pull", (sceneId: string) => {
      if (this.#user(socket)?.role !== "gm" || !this.#world.get("Scene", sceneId)) return;
      socket.broadcast.emit("pull", sceneId);
    });

    /** GM: forget everyone's exploration of a scene. */
    socket.on("resetFog", (sceneId: string, ack?: Ack<DocResponse>) => {
      const me = this.#user(socket);
      if (me?.role !== "gm") return ack?.({ ok: false, error: "Sem permissão" });
      try {
        const ids = this.#world.all<FogExplorationDoc>("FogExploration").filter(f => f._parent === sceneId).map(f => f._id);
        const changes = ids.length ? this.#world.apply({ op: "delete", type: "FogExploration", parent: sceneId, ids }, me) : [];
        this.#broadcast(changes, me._id);
        this.#io.emit("resetFog", sceneId);
        ack?.({ ok: true, result: ids });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    /** Which scene each user is looking at (scene navigation shows their pips). */
    socket.on("viewing", (sceneId: unknown) => {
      socket.data.sceneId = typeof sceneId === "string" ? sceneId : null;
      this.#io.emit("viewing", this.viewing());
    });
    socket.on("latency", (ack?: () => void) => ack?.());

    socket.on("disconnect", () => {
      this.#io.emit("presence", this.online());
      this.#io.emit("viewing", this.viewing());
    });
  }

  #snapshot(user: UserDoc): WorldSnapshot {
    const docs: WorldSnapshot["docs"] = {};
    for (const type of DOC_TYPES) {
      docs[type] = this.#world.all(type).filter(d => canSee(type, d, user, this.#world)).map(d => publicDoc(type, d, user));
    }
    const { id, title, system } = this.#world.meta;
    return { world: { id, title, system }, userId: user._id, docs, online: this.online() };
  }

  /**
   * Send each connected user the view of `changes` they're entitled to. A document that becomes
   * visible arrives as a create, one that becomes hidden arrives as a delete.
   */
  #broadcast(changes: Change[], byUserId: string): void {
    for (const socket of this.#io.sockets.sockets.values()) {
      const user = this.#user(socket);
      if (!user) continue;
      const events = new Map<string, DocEvent>();
      const push = (op: DocEvent["op"], type: DocType, value: BaseDoc | string) => {
        const key = `${op}:${type}`;
        if (!events.has(key)) events.set(key, { op, type, result: [], userId: byUserId } as DocEvent);
        (events.get(key)!.result as unknown[]).push(value);
      };
      for (const c of changes) {
        const sawBefore = !!c.before && canSee(c.type, c.before, user, this.#world);
        const seesAfter = !!c.after && canSee(c.type, c.after, user, this.#world);
        if (seesAfter) {
          push(sawBefore ? "update" : "create", c.type, publicDoc(c.type, c.after!, user));
          // An actor that just became visible brings its items along.
          if (!sawBefore && c.type === "Actor") {
            for (const item of this.#world.all("Item")) {
              if (item._parent === c.after!._id && canSee("Item", item, user, this.#world)) push("create", "Item", item);
            }
          }
          // A journal entry that just became visible reveals its map notes.
          if (!sawBefore && c.type === "JournalEntry") {
            for (const n of this.#world.all("Note")) if ((n as { entryId?: string }).entryId === c.after!._id) push("create", "Note", n);
          }
        } else if (sawBefore) {
          push("delete", c.type, c.before!._id);
          if (c.type === "JournalEntry") {
            for (const n of this.#world.all("Note")) if ((n as { entryId?: string }).entryId === c.before!._id) push("delete", "Note", n._id);
          }
        }
      }
      for (const e of events.values()) socket.emit("doc", e);
    }
  }

  /** A user whose password changed or who was deleted gets logged out everywhere. */
  #revokeChangedLogins(changes: Change[], byUserId: string): void {
    for (const c of changes) {
      if (c.type !== "User" || c.before?._id === byUserId) continue;
      const revoked = !c.after || (c.before as UserDoc).passwordHash !== (c.after as UserDoc).passwordHash;
      if (!revoked) continue;
      this.#sessions.destroyForUser(c.before!._id);
      for (const s of this.#io.sockets.sockets.values()) if (s.data.userId === c.before!._id) s.disconnect(true);
    }
  }
}
