import fs from "node:fs";
import path from "node:path";
import type {
  BaseDoc, CombatDoc, CombatantDoc, DocRequest, DocType, FogExplorationDoc, FolderDoc, SceneDoc, TokenDoc, UserDoc, WallDoc
} from "../shared/protocol.ts";
import { DOC_TYPES, OPTIONAL_PARENT, PARENT_TYPE } from "../shared/protocol.ts";
import { checkWrite } from "../shared/permissions.ts";
import type { DocLookup } from "../shared/permissions.ts";
import { expandDotKeys, mergeDeep, randomId } from "../shared/objects.ts";
import { movementBlocked, wallEdges } from "../shared/geometry.ts";
import { nextTurnState } from "../shared/combat.ts";
import { defaultLevel, onLevel } from "../shared/levels.ts";
import { Store } from "./store.ts";
import { normalize, prepareCreate, validate } from "./schema.ts";
import { hashPassword } from "./auth.ts";
import crypto from "node:crypto";
import { DiceError, roll } from "../shared/dice.ts";

/** At most this many [[inline]] rolls per message. */
const MAX_INLINE = 20;
import { worldDir } from "./paths.ts";

/** Identity used when the server itself changes documents. */
const SYSTEM_USER: UserDoc = { _id: "", name: "Mesa", role: "gm", color: "#888888", character: null };

export interface WorldMeta {
  id: string;
  title: string;
  system: string;
  created: number;
}

/** One document changing. `before` is absent on create, `after` is absent on delete. */
export interface Change {
  type: DocType;
  before?: BaseDoc;
  after?: BaseDoc;
}

/**
 * A loaded world: every document held in memory, written through to SQLite.
 * All mutations go through `apply`, which checks permissions and returns the resulting changes
 * so the socket layer can tell each client what it is allowed to see.
 */
export class World implements DocLookup {
  readonly meta: WorldMeta;
  readonly dir: string;
  readonly assetsDir: string;
  #docs = new Map<DocType, Map<string, BaseDoc>>();
  #store: Store;

  private constructor(dir: string, meta: WorldMeta) {
    this.dir = dir;
    this.meta = meta;
    this.assetsDir = path.join(dir, "assets");
    fs.mkdirSync(this.assetsDir, { recursive: true });
    for (const t of DOC_TYPES) this.#docs.set(t, new Map());
    this.#store = new Store(path.join(dir, "world.db"));
    for (const { type, doc } of this.#store.loadAll()) this.#docs.get(type)?.set(doc._id, normalize(type, doc));
  }

  static exists(id: string): boolean {
    return fs.existsSync(path.join(worldDir(id), "world.json"));
  }

  static open(id: string): World {
    const dir = worldDir(id);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8")) as WorldMeta;
    return new World(dir, meta);
  }

  static create(meta: Omit<WorldMeta, "created">): World {
    const dir = worldDir(meta.id);
    if (fs.existsSync(path.join(dir, "world.json"))) throw new Error(`World "${meta.id}" already exists`);
    fs.mkdirSync(dir, { recursive: true });
    const full: WorldMeta = { ...meta, created: Date.now() };
    fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(full, null, 2));
    return new World(dir, full);
  }

  close(): void {
    this.#store.close();
  }

  get(type: DocType, id: string): BaseDoc | undefined {
    return this.#docs.get(type)?.get(id);
  }

  all<T extends BaseDoc = BaseDoc>(type: DocType): T[] {
    return [...this.#docs.get(type)!.values()] as T[];
  }

  user(id: string | null): UserDoc | undefined {
    return id ? (this.get("User", id) as UserDoc | undefined) : undefined;
  }

  /** Insert documents without permission checks (CLI tools, importer). */
  insertRaw(type: DocType, docs: BaseDoc[]): void {
    for (const d of docs) this.#docs.get(type)!.set(d._id, d);
    this.#store.write(docs.map(doc => ({ type, doc })));
  }

  /** Create documents as the server itself (bypasses permissions, still validates). */
  createAsSystem(type: DocType, data: Record<string, unknown>[], parent?: string): BaseDoc[] {
    return this.#commit(data.map(d => ({ type, after: prepareCreate(type, d, this.#newId(type), parent) }))).map(c => c.after!);
  }

  /** Apply a request with GM rights on behalf of the server (combat actions etc.). */
  applyAsSystem(req: DocRequest): Change[] {
    return this.apply(req, SYSTEM_USER);
  }

  apply(req: DocRequest, user: UserDoc): Change[] {
    const type = req.type;
    if (!DOC_TYPES.includes(type)) throw new Error(`Tipo desconhecido: ${type}`);
    const parentType = PARENT_TYPE[type];
    if (parentType && (req.parent || !OPTIONAL_PARENT.has(type))) {
      if (!req.parent || !this.get(parentType, req.parent)) throw new Error(`${type} precisa de um ${parentType} válido`);
    } else if (req.parent) {
      throw new Error(`${type} não tem pai`);
    }

    const changes: Change[] = [];
    switch (req.op) {
      case "create":
        for (const data of req.data) {
          const doc = prepareCreate(type, this.#sanitizeIncoming("create", type, data, user, req.parent), this.#newId(type), req.parent);
          this.#assertAllowed("create", type, doc, user);
          changes.push({ type, after: doc });
        }
        break;

      case "update":
        for (const raw of req.updates) {
          const before = this.#getChild(type, raw._id, req.parent);
          const diff = expandDotKeys(this.#sanitizeIncoming("update", type, raw, user));
          delete diff._id;
          delete diff._parent;
          this.#assertAllowed("update", type, before, user, diff);
          const after = mergeDeep(before, diff);
          validate(type, after);
          if (type === "Token" && user.role !== "gm") this.#assertCanMove(before as TokenDoc, after as TokenDoc);
          changes.push({ type, before, after });
        }
        break;

      case "delete":
        for (const id of req.ids) {
          const before = this.#getChild(type, id, req.parent);
          this.#assertAllowed("delete", type, before, user);
          changes.push({ type, before }, ...this.#children(type, id).map(c => ({ ...c })));
        }
        break;
    }
    changes.push(...this.#sideEffects(changes));
    return this.#commit(changes);
  }

  /** Players can't walk through walls. The path is checked centre to centre. */
  #assertCanMove(before: TokenDoc, after: TokenDoc): void {
    if (before.x === after.x && before.y === after.y) return;
    const scene = this.get("Scene", before._parent!) as SceneDoc | undefined;
    if (!scene) return;
    const half = scene.grid.size / 2;
    const fallback = defaultLevel(scene, this)?._id ?? null;
    const level = after.level ?? fallback;
    const walls = this.all<WallDoc>("Wall").filter(w => w._parent === scene._id && onLevel(w, level));
    const from = { x: before.x + before.width * half, y: before.y + before.height * half };
    const to = { x: after.x + after.width * half, y: after.y + after.height * half };
    if (movementBlocked(from, to, wallEdges(walls, "move"))) throw new Error("Há uma parede no caminho");
  }

  #newId(type: DocType): string {
    for (;;) {
      const id = randomId();
      if (!this.get(type, id)) return id;
    }
  }

  #getChild(type: DocType, id: string, parent?: string): BaseDoc {
    const doc = this.get(type, id);
    if (!doc || (doc._parent ?? undefined) !== parent) throw new Error(`${type} ${id} não existe`);
    return doc;
  }

  #assertAllowed(op: "create" | "update" | "delete", type: DocType, doc: BaseDoc, user: UserDoc, diff?: Record<string, unknown>): void {
    const error = checkWrite(op, type, doc, user, this, diff);
    if (error) throw new Error(error);
  }

  /** Normalize client input: server-owned fields are set here, never trusted from the client. */
  #sanitizeIncoming(op: "create" | "update", type: DocType, data: Record<string, unknown>, user: UserDoc, parent?: string): Record<string, unknown> {
    const out = { ...data };
    delete out.passwordHash;
    if (type === "User" && "password" in out) {
      if (user.role !== "gm") throw new Error("Sem permissão");
      const pw = String(out.password ?? "");
      out.passwordHash = pw ? hashPassword(pw) : null;
      delete out.password;
    }
    if (type === "ChatMessage" && op === "create") {
      out.author = user._id;
      out.timestamp = Date.now();
      out.html = false;
      out.roll = null;
      out.blind = false;
      if (typeof out.content !== "string" || !out.content.trim()) throw new Error("Mensagem vazia");
      // [[1d20+2]] (or [[/r 1d20]]) in the text rolls on the server; the text keeps the markers.
      const inline = [...out.content.matchAll(/\[\[(?:\/r(?:oll)?\s+)?([^\]]+)\]\]/gi)].slice(0, MAX_INLINE);
      try {
        out.inline = inline.map(m => roll(m[1], f => crypto.randomInt(1, f + 1)));
      } catch (err) {
        if (err instanceof DiceError) throw new Error(`Rolagem no texto: ${err.message}`);
        throw err;
      }
    }
    if (type === "Drawing" && op === "create") out.author = user._id;
    if (type === "Macro" && op === "create") out.author = user._id;
    // Players can only create templates (their own, behaviour-free); the GM may create any region.
    if (type === "Region" && op === "create" && user.role !== "gm") {
      out.template = { author: user._id };
      out.behaviors = [];
      out.visibility = 2;
      out.displayMeasurements = true;
    }
    if (type === "Region" && op === "update" && user.role !== "gm") delete out.template;
    if (type === "Drawing" && op === "update") delete out.author;
    if (type === "FogExploration") {
      out.timestamp = Date.now();
      if (op === "create") {
        out.user = user._id;
        const exists = this.all<FogExplorationDoc>("FogExploration").some(f => f.user === user._id && f._parent === parent);
        if (exists) throw new Error("Já existe exploração desta cena para este utilizador");
      }
    }
    return out;
  }

  #children(type: DocType, id: string): Change[] {
    const out: Change[] = [];
    for (const [childType, pType] of Object.entries(PARENT_TYPE) as [DocType, DocType][]) {
      if (pType !== type) continue;
      for (const child of this.all(childType)) if (child._parent === id) out.push({ type: childType, before: child });
    }
    return out;
  }

  /**
   * Consequences of a change that the requester didn't ask for explicitly:
   * - only one scene may be active at a time
   * - deleting a scene deletes its encounters; deleting a token removes it from encounters
   * - removing the combatant whose turn it is passes the turn on
   */
  #sideEffects(changes: Change[]): Change[] {
    const out: Change[] = [];
    const activated = changes.find(c => c.type === "Scene" && c.after?.active && !c.before?.active);
    if (activated) {
      for (const s of this.all<SceneDoc>("Scene")) {
        if (s.active && s._id !== activated.after!._id) out.push({ type: "Scene", before: s, after: { ...s, active: false } });
      }
    }

    const deleted = (type: DocType) => new Set(changes.filter(c => c.type === type && !c.after).map(c => c.before!._id));
    const goneScenes = deleted("Scene");
    const goneTokens = deleted("Token");
    const alreadyGone = new Set(changes.filter(c => !c.after).map(c => `${c.type}:${c.before!._id}`));
    const remove = (type: DocType, doc: BaseDoc) => {
      if (alreadyGone.has(`${type}:${doc._id}`)) return;
      alreadyGone.add(`${type}:${doc._id}`);
      out.push({ type, before: doc });
    };
    for (const combat of this.all<CombatDoc>("Combat")) {
      if (combat.sceneId && goneScenes.has(combat.sceneId)) {
        remove("Combat", combat);
        for (const c of this.all<CombatantDoc>("Combatant")) if (c._parent === combat._id) remove("Combatant", c);
      }
    }
    for (const c of this.all<CombatantDoc>("Combatant")) if (c.tokenId && goneTokens.has(c.tokenId)) remove("Combatant", c);

    // Deleting a folder moves its contents and subfolders up one level.
    for (const f of changes.filter(c => c.type === "Folder" && !c.after).map(c => c.before as FolderDoc)) {
      const types: DocType[] = [f.type, "Folder"];
      for (const t of types) {
        for (const d of this.all(t)) {
          if (d.folder !== f._id || alreadyGone.has(`${t}:${d._id}`)) continue;
          out.push({ type: t, before: d, after: { ...d, folder: f.folder ?? null } });
        }
      }
    }

    // Pass the turn on if the current combatant left.
    const removedCombatants = new Set([...changes, ...out].filter(c => c.type === "Combatant" && !c.after).map(c => c.before!._id));
    for (const combat of this.all<CombatDoc>("Combat")) {
      if (!combat.current || !removedCombatants.has(combat.current) || alreadyGone.has(`Combat:${combat._id}`)) continue;
      const all = this.all<CombatantDoc>("Combatant").filter(c => c._parent === combat._id);
      const remaining = all.filter(c => !removedCombatants.has(c._id));
      // Find who would have been next, then make sure they're still here.
      let state = nextTurnState(combat, all);
      for (let i = 0; i < all.length && state.current && removedCombatants.has(state.current); i++) {
        state = nextTurnState({ ...combat, ...state }, all);
      }
      if (!remaining.length) state = { round: combat.round, current: null };
      out.push({ type: "Combat", before: combat, after: { ...combat, ...state } });
    }
    return out;
  }

  #commit(changes: Change[]): Change[] {
    this.#store.write(
      changes.filter(c => c.after).map(c => ({ type: c.type, doc: c.after! })),
      changes.filter(c => !c.after).map(c => ({ type: c.type, id: c.before!._id }))
    );
    for (const c of changes) {
      const map = this.#docs.get(c.type)!;
      if (c.after) map.set(c.after._id, c.after);
      else map.delete(c.before!._id);
    }
    return changes;
  }
}

export function listWorlds(worldsDir: string): WorldMeta[] {
  if (!fs.existsSync(worldsDir)) return [];
  return fs.readdirSync(worldsDir)
    .filter(d => fs.existsSync(path.join(worldsDir, d, "world.json")))
    .map(d => JSON.parse(fs.readFileSync(path.join(worldsDir, d, "world.json"), "utf8")) as WorldMeta);
}
