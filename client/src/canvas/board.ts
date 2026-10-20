import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type { ActorDoc, PingEvent, SceneDoc, TokenDoc, UserDoc } from "../../../shared/protocol.ts";
import { OWNERSHIP } from "../../../shared/protocol.ts";
import { ownershipLevel } from "../../../shared/permissions.ts";
import type { Point } from "../../../shared/geometry.ts";
import { gridDistance } from "../../../shared/geometry.ts";
import { game, toast } from "../game.ts";
import { initials } from "../dom.ts";
import { openSheet } from "../ui/sheet.ts";
import { openTokenConfig } from "../ui/canvas-config.ts";

const DISPOSITION_COLOR: Record<number, number> = { [-1]: 0xd9534f, 0: 0xe0b84a, 1: 0x4fa3d9 };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

export type ToolName = "tokens" | "walls" | "lights" | "ruler";

/** A canvas tool receives pointer input that doesn't land on a token. */
export interface Tool {
  activate?(): void;
  deactivate?(): void;
  /** Return true when the tool consumed the press (otherwise the board pans). */
  down?(p: Point, e: FederatedPointerEvent): boolean;
  move?(p: Point, e: FederatedPointerEvent): void;
  up?(p: Point, e: FederatedPointerEvent): void;
  key?(e: KeyboardEvent): boolean;
  dblclick?(p: Point, e: MouseEvent): boolean;
}

export interface TokenView {
  root: Container;
  body: Container;
  frame: Graphics;
  label: Text;
  doc: TokenDoc;
  /** Animation target while a remote move is easing in. */
  target: { x: number; y: number } | null;
}

type BoardEvent = "scene" | "tokens" | "selection" | "tool" | "frame";

/**
 * The scene canvas. Owns the PIXI application, the viewed scene's tokens, pan/zoom and the active tool.
 * Other canvas modules (walls, lights, perception, ruler) attach to `layers` and listen to board events.
 * Coordinates: `world` is the panned/zoomed container; scene pixel (0,0) is the scene's top-left.
 */
export class Board {
  app = new Application();
  world = new Container();
  layers = {
    background: new Container(),
    grid: new Graphics(),
    glow: new Container(),
    tokens: new Container(),
    effects: new Container(),
    walls: new Container(),
    doors: new Container(),
    lights: new Container(),
    controls: new Container(),
    pings: new Container()
  };
  tokens = new Map<string, TokenView>();
  tool: ToolName = "tokens";
  #tools = new Map<ToolName, Tool>();
  #selected: string | null = null;
  #drag:
    | { kind: "token"; id: string; dx: number; dy: number; moved: boolean; start: Point }
    | { kind: "pan"; sx: number; sy: number; wx: number; wy: number }
    | { kind: "tool" }
    | null = null;
  #sceneId: string | null = null;
  #views = new Map<string, { x: number; y: number; scale: number }>();
  #listeners = new Map<BoardEvent, Set<() => void>>();
  #dragLabel = new Text({ text: "", style: { fill: 0xffffff, fontSize: 22, fontWeight: "700", fontFamily: "Inter, system-ui, sans-serif", stroke: { color: 0x000000, width: 5 } } });

  async mount(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: host, background: 0x0b0b0e, antialias: true, autoDensity: true, resolution: devicePixelRatio });
    host.append(this.app.canvas);
    const L = this.layers;
    this.world.addChild(L.background, L.grid, L.glow, L.tokens, L.effects, L.walls, L.doors, L.lights, L.controls, L.pings);
    // Overlays never take input: in PIXI v8 even passive graphics win hit tests and would swallow token clicks.
    for (const layer of [L.grid, L.glow, L.effects, L.walls, L.controls, L.pings]) layer.eventMode = "none";
    this.#dragLabel.anchor.set(0.5, 1);
    this.#dragLabel.visible = false;
    L.controls.addChild(this.#dragLabel);
    this.app.stage.addChild(this.world);
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;

    this.app.stage.on("pointerdown", e => this.#onStageDown(e));
    this.app.stage.on("globalpointermove", e => this.#onMove(e));
    this.app.stage.on("pointerup", e => this.#onUp(e));
    this.app.stage.on("pointerupoutside", e => this.#onUp(e));
    this.app.canvas.addEventListener("wheel", e => this.#onWheel(e), { passive: false });
    this.app.canvas.addEventListener("contextmenu", e => e.preventDefault());
    this.app.canvas.addEventListener("dblclick", e => this.#onDoubleClick(e));
    this.app.canvas.addEventListener("dragover", e => {
      if (e.dataTransfer?.types.includes("application/x-mesa-actor")) e.preventDefault();
    });
    this.app.canvas.addEventListener("drop", e => this.#onDrop(e));
    window.addEventListener("keydown", e => this.#onKey(e));
    this.app.ticker.add(() => this.#animate());

    game.on("view", () => this.#loadScene());
    game.on("ready", () => this.#loadScene());
    game.on("Scene", e => {
      if (e.ids.includes(this.#sceneId ?? "")) this.#drawScene(false);
    });
    game.on("Token", e => this.#onTokens(e.op, e.docs as TokenDoc[], e.ids));
    game.on("Actor", () => this.#redrawAllTokens());
    game.on("ping", p => this.#onPing(p));
    this.#loadScene();
  }

  // -------------------------------------------------------------------------
  // Events & tools

  on(event: BoardEvent, fn: () => void): () => void {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event)!.add(fn);
    return () => this.#listeners.get(event)!.delete(fn);
  }

  emit(event: BoardEvent): void {
    for (const fn of this.#listeners.get(event) ?? []) fn();
  }

  registerTool(name: ToolName, tool: Tool): void {
    this.#tools.set(name, tool);
  }

  setTool(name: ToolName): void {
    if (name === this.tool) return;
    this.#tools.get(this.tool)?.deactivate?.();
    this.tool = name;
    this.#tools.get(name)?.activate?.();
    // Tokens only take input in the tokens tool (and the ruler, to measure from them).
    for (const v of this.tokens.values()) v.root.eventMode = name === "tokens" ? "static" : "none";
    this.#select(null);
    this.emit("tool");
  }

  // -------------------------------------------------------------------------
  // Scene

  get scene(): SceneDoc | undefined {
    return game.viewedScene;
  }

  get selectedToken(): TokenView | undefined {
    return this.#selected ? this.tokens.get(this.#selected) : undefined;
  }

  /** Scene pixels per distance unit. */
  get pxPerUnit(): number {
    const g = this.scene?.grid;
    return g ? g.size / (g.distance || 1) : 1;
  }

  /** Snap a point to grid corners and centres (half-grid), unless the caller disables it. */
  snap(p: Point, enabled = true): Point {
    const size = this.scene?.grid.size ?? 100;
    if (!enabled) return { x: Math.round(p.x), y: Math.round(p.y) };
    const step = size / 2;
    return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
  }

  /** Live token centre (follows the sprite during drags). */
  tokenCenter(v: TokenView): Point {
    const size = this.scene?.grid.size ?? 100;
    return { x: v.root.x + (v.doc.width * size) / 2, y: v.root.y + (v.doc.height * size) / 2 };
  }

  #loadScene(): void {
    if (this.#sceneId) this.#views.set(this.#sceneId, { x: this.world.x, y: this.world.y, scale: this.world.scale.x });
    this.#sceneId = game.viewedSceneId;
    for (const t of this.tokens.values()) t.root.destroy({ children: true });
    this.tokens.clear();
    this.#selected = null;
    this.#drawScene(true);
    if (this.scene) for (const t of game.children<TokenDoc>("Token", this.scene._id)) this.#upsertToken(t);
    this.emit("scene");
    this.emit("tokens");
  }

  async #drawScene(resetView: boolean): Promise<void> {
    const scene = this.scene;
    const bg = this.layers.background;
    bg.removeChildren().forEach(c => c.destroy());
    this.layers.grid.clear();
    if (!scene) return;

    bg.addChild(new Graphics().rect(0, 0, scene.width, scene.height).fill(scene.backgroundColor || "#111111"));
    this.#drawGrid(scene);
    if (resetView) {
      const saved = this.#views.get(scene._id);
      if (saved) {
        this.world.position.set(saved.x, saved.y);
        this.world.scale.set(saved.scale);
      } else this.fit();
    }
    if (scene.img) {
      const tex = await loadTexture(scene.img);
      if (tex && this.scene?._id === scene._id) {
        const sprite = new Sprite(tex);
        sprite.width = scene.width;
        sprite.height = scene.height;
        bg.addChild(sprite);
      }
    }
    this.emit("scene");
  }

  #drawGrid(scene: SceneDoc): void {
    const { size, color, alpha } = scene.grid;
    if (!size || size < 10 || alpha <= 0) return;
    for (let x = 0; x <= scene.width; x += size) this.layers.grid.moveTo(x, 0).lineTo(x, scene.height);
    for (let y = 0; y <= scene.height; y += size) this.layers.grid.moveTo(0, y).lineTo(scene.width, y);
    this.layers.grid.stroke({ width: 1, color, alpha });
  }

  /** Zoom to fit the whole scene in the viewport. */
  fit(): void {
    const scene = this.scene;
    if (!scene) return;
    const { width, height } = this.app.screen;
    const scale = Math.min(width / scene.width, height / scene.height, 1) * 0.95;
    this.world.scale.set(scale);
    this.world.position.set((width - scene.width * scale) / 2, (height - scene.height * scale) / 2);
  }

  // -------------------------------------------------------------------------
  // Tokens

  /** Whether the local user sees through this token (owner or observer of its actor; GMs: all). */
  isObserver(doc: TokenDoc): boolean {
    if (game.isGM) return true;
    const actor = game.get<ActorDoc>("Actor", doc.actorId);
    return !!actor && ownershipLevel(actor.ownership, game.user) >= OWNERSHIP.OBSERVER;
  }

  canMove(doc: TokenDoc): boolean {
    return game.isGM || game.owns(game.get<ActorDoc>("Actor", doc.actorId));
  }

  #onTokens(op: string, docs: TokenDoc[], ids: string[]): void {
    if (op === "delete") {
      for (const id of ids) this.#removeToken(id);
    } else {
      for (const d of docs) if (d._parent === this.#sceneId) this.#upsertToken(d, op === "update");
    }
    this.emit("tokens");
  }

  #removeToken(id: string): void {
    const t = this.tokens.get(id);
    if (!t) return;
    t.root.destroy({ children: true });
    this.tokens.delete(id);
    if (this.#selected === id) {
      this.#selected = null;
      this.emit("selection");
    }
  }

  #redrawAllTokens(): void {
    for (const t of this.tokens.values()) this.#upsertToken(t.doc);
    this.emit("tokens");
  }

  #upsertToken(doc: TokenDoc, animate = false): void {
    let view = this.tokens.get(doc._id);
    const scene = this.scene!;
    const size = scene.grid.size;
    if (!view) {
      const root = new Container();
      root.eventMode = this.tool === "tokens" ? "static" : "none";
      root.cursor = "pointer";
      root.on("pointerdown", e => this.#onTokenDown(doc._id, e));
      root.on("pointerover", () => (view!.label.visible = true));
      root.on("pointerout", () => (view!.label.visible = this.#selected === doc._id));
      const body = new Container();
      const frame = new Graphics();
      const label = new Text({ text: "", style: { fill: 0xffffff, fontSize: 16, fontFamily: "Inter, system-ui, sans-serif", stroke: { color: 0x000000, width: 4 } } });
      label.anchor.set(0.5, 0);
      label.visible = false;
      root.addChild(body, frame, label);
      root.position.set(doc.x, doc.y);
      this.layers.tokens.addChild(root);
      view = { root, body, frame, label, doc, target: null };
      this.tokens.set(doc._id, view);
    }
    const prev = view.doc;
    view.doc = doc;

    const w = doc.width * size;
    const ht = doc.height * size;
    const actor = game.get<ActorDoc>("Actor", doc.actorId);
    const img = doc.img ?? actor?.token.img ?? actor?.img ?? null;
    const name = doc.name || actor?.name || "";

    const key = `${img}|${w}|${ht}|${name}|${doc.disposition}`;
    if ((view.body as any)._key !== key) {
      (view.body as any)._key = key;
      view.body.removeChildren().forEach(c => c.destroy());
      view.body.addChild(placeholder(name, w, ht, DISPOSITION_COLOR[doc.disposition] ?? 0xe0b84a));
      if (img) {
        loadTexture(img).then(tex => {
          if (!tex || !this.tokens.has(doc._id) || (view!.body as any)._key !== key) return;
          view!.body.removeChildren().forEach(c => c.destroy());
          const sprite = new Sprite(tex);
          const scale = Math.min(w / tex.width, ht / tex.height);
          sprite.scale.set(scale);
          sprite.position.set((w - tex.width * scale) / 2, (ht - tex.height * scale) / 2);
          view!.body.addChild(sprite);
        });
      }
    }

    view.label.text = name;
    view.label.position.set(w / 2, ht + 4);
    view.root.alpha = doc.hidden ? 0.45 : 1;
    this.#drawFrame(view);

    const dragging = this.#drag?.kind === "token" && this.#drag.id === doc._id;
    if (!dragging && (prev.x !== doc.x || prev.y !== doc.y || !animate)) {
      if (animate) view.target = { x: doc.x, y: doc.y };
      else view.root.position.set(doc.x, doc.y);
    }
  }

  #drawFrame(view: TokenView): void {
    const size = this.scene?.grid.size ?? 100;
    const w = view.doc.width * size;
    const ht = view.doc.height * size;
    view.frame.clear();
    if (this.#selected !== view.doc._id) return;
    view.frame.rect(1, 1, w - 2, ht - 2).stroke({ width: 3, color: 0xff9f1c });
    // Facing marker for tokens with a vision/light cone.
    if (view.doc.sight.angle < 360 || view.doc.light.angle < 360) {
      const a = (view.doc.rotation * Math.PI) / 180 + Math.PI / 2;
      const cx = w / 2, cy = ht / 2, r = Math.min(w, ht) / 2 + 6;
      view.frame.circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 5).fill(0xff9f1c);
    }
  }

  #select(id: string | null): void {
    if (id === this.#selected) return;
    const prev = this.#selected;
    this.#selected = id;
    for (const i of [prev, id]) {
      const v = i ? this.tokens.get(i) : undefined;
      if (v) {
        this.#drawFrame(v);
        v.label.visible = v.doc._id === id;
      }
    }
    this.emit("selection");
  }

  #animate(): void {
    let moved = false;
    for (const v of this.tokens.values()) {
      if (!v.target) continue;
      const dx = v.target.x - v.root.x;
      const dy = v.target.y - v.root.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        v.root.position.set(v.target.x, v.target.y);
        v.target = null;
      } else v.root.position.set(v.root.x + dx * 0.25, v.root.y + dy * 0.25);
      moved = true;
    }
    if (moved) this.emit("frame");
  }

  // -------------------------------------------------------------------------
  // Input

  toWorld(e: { global: { x: number; y: number } }): Point {
    return this.world.toLocal(e.global);
  }

  #onTokenDown(id: string, e: FederatedPointerEvent): void {
    if (e.button !== 0) {
      if (e.button === 2) {
        e.stopPropagation();
        const v = this.tokens.get(id)!;
        if (game.isGM) openTokenConfig(v.doc._id, v.doc._parent!);
      }
      return;
    }
    e.stopPropagation();
    const v = this.tokens.get(id)!;
    this.#select(id);
    if (!this.canMove(v.doc)) return;
    const p = this.toWorld(e);
    v.target = null;
    this.#drag = { kind: "token", id, dx: p.x - v.root.x, dy: p.y - v.root.y, moved: false, start: { x: v.root.x, y: v.root.y } };
    this.layers.tokens.addChild(v.root); // bring to front
  }

  #onStageDown(e: FederatedPointerEvent): void {
    const tool = this.#tools.get(this.tool);
    if (e.button === 0 && tool?.down?.(this.toWorld(e), e)) {
      this.#drag = { kind: "tool" };
      return;
    }
    if (this.tool === "tokens") this.#select(null);
    this.#drag = { kind: "pan", sx: e.global.x, sy: e.global.y, wx: this.world.x, wy: this.world.y };
  }

  #onMove(e: FederatedPointerEvent): void {
    const d = this.#drag;
    if (!d) {
      this.#tools.get(this.tool)?.move?.(this.toWorld(e), e);
      return;
    }
    if (d.kind === "tool") {
      this.#tools.get(this.tool)?.move?.(this.toWorld(e), e);
      return;
    }
    if (d.kind === "pan") {
      this.world.position.set(d.wx + e.global.x - d.sx, d.wy + e.global.y - d.sy);
      return;
    }
    const v = this.tokens.get(d.id);
    const scene = this.scene;
    if (!v || !scene) return;
    const p = this.toWorld(e);
    v.root.position.set(p.x - d.dx, p.y - d.dy);
    d.moved = true;
    // Distance readout while dragging.
    const size = scene.grid.size;
    const dist = gridDistance(d.start, { x: Math.round(v.root.x / size) * size, y: Math.round(v.root.y / size) * size }, size, scene.grid.distance);
    this.#dragLabel.text = `${formatNumber(dist)} ${scene.grid.units}`;
    this.#dragLabel.position.set(v.root.x + (v.doc.width * size) / 2, v.root.y - 6);
    this.#dragLabel.visible = true;
    this.emit("frame");
  }

  async #onUp(e: FederatedPointerEvent): Promise<void> {
    const d = this.#drag;
    this.#drag = null;
    this.#dragLabel.visible = false;
    if (d?.kind === "tool") {
      this.#tools.get(this.tool)?.up?.(this.toWorld(e), e);
      return;
    }
    if (!d || d.kind !== "token" || !d.moved) return;
    const v = this.tokens.get(d.id);
    const scene = this.scene;
    if (!v || !scene) return;
    const size = scene.grid.size;
    const maxX = scene.width - v.doc.width * size;
    const maxY = scene.height - v.doc.height * size;
    const x = clamp(Math.round(v.root.x / size) * size, 0, Math.max(0, maxX));
    const y = clamp(Math.round(v.root.y / size) * size, 0, Math.max(0, maxY));
    v.target = { x, y };
    try {
      await game.update("Token", { _id: v.doc._id, x, y }, scene._id);
    } catch {
      v.target = { x: v.doc.x, y: v.doc.y };
    }
  }

  #onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Shift + wheel rotates the selected token (15° steps).
    const sel = this.selectedToken;
    if (e.shiftKey && sel && this.canMove(sel.doc) && this.scene) {
      const rotation = (((sel.doc.rotation + (e.deltaY > 0 ? 15 : -15)) % 360) + 360) % 360;
      game.update("Token", { _id: sel.doc._id, rotation }, this.scene._id);
      return;
    }
    const rect = this.app.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const old = this.world.scale.x;
    const next = clamp(old * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
    const wx = (mx - this.world.x) / old;
    const wy = (my - this.world.y) / old;
    this.world.scale.set(next);
    this.world.position.set(mx - wx * next, my - wy * next);
  }

  eventToWorld(e: MouseEvent): Point {
    const rect = this.app.canvas.getBoundingClientRect();
    return this.world.toLocal({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  #onDoubleClick(e: MouseEvent): void {
    const p = this.eventToWorld(e);
    if (this.#tools.get(this.tool)?.dblclick?.(p, e)) return;
    if (this.tool === "tokens" && this.#selected) {
      const t = this.tokens.get(this.#selected)!;
      const actor = game.get<ActorDoc>("Actor", t.doc.actorId);
      if (actor) openSheet(actor._id);
      return;
    }
    game.ping(p.x, p.y);
    this.#onPing({ userId: game.userId, sceneId: this.#sceneId!, x: p.x, y: p.y });
  }

  async #onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    const actorId = e.dataTransfer?.getData("application/x-mesa-actor");
    const actor = game.get<ActorDoc>("Actor", actorId);
    const scene = this.scene;
    if (!actor || !scene) return;
    if (!game.isGM) return toast("Só o mestre pode pôr tokens no mapa");
    const size = scene.grid.size;
    const p = this.eventToWorld(e);
    const x = Math.floor(p.x / size) * size;
    const y = Math.floor(p.y / size) * size;
    const isAgent = actor.type === "agent";
    await game.create("Token", {
      name: actor.name, actorId: actor._id, img: actor.token.img ?? actor.img, x, y,
      width: actor.token.width, height: actor.token.height,
      disposition: isAgent ? 1 : actor.type === "threat" ? -1 : 0,
      // Agents get vision by default so player vision works out of the box.
      sight: { enabled: isAgent, range: 0, angle: 360 }
    }, scene._id);
  }

  #onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]")) return;
    if (this.#tools.get(this.tool)?.key?.(e)) return;
    const v = this.selectedToken;
    const scene = this.scene;
    if (!v || !scene || this.tool !== "tokens") return;
    if ((e.key === "Delete" || e.key === "Backspace") && game.isGM) {
      game.delete("Token", v.doc._id, scene._id);
    } else if (e.key.toLowerCase() === "h" && game.isGM) {
      game.update("Token", { _id: v.doc._id, hidden: !v.doc.hidden }, scene._id);
    } else if (e.key.startsWith("Arrow") && this.canMove(v.doc)) {
      e.preventDefault();
      const size = scene.grid.size;
      const dx = e.key === "ArrowLeft" ? -size : e.key === "ArrowRight" ? size : 0;
      const dy = e.key === "ArrowUp" ? -size : e.key === "ArrowDown" ? size : 0;
      // Step from where the token is heading, so quick repeated presses add up.
      const from = v.target ?? { x: v.doc.x, y: v.doc.y };
      const x = clamp(from.x + dx, 0, scene.width - v.doc.width * size);
      const y = clamp(from.y + dy, 0, scene.height - v.doc.height * size);
      v.target = { x, y };
      game.update("Token", { _id: v.doc._id, x, y }, scene._id).catch(() => {
        v.target = { x: v.doc.x, y: v.doc.y };
      });
    }
  }

  #onPing(p: PingEvent): void {
    if (p.sceneId !== this.#sceneId) return;
    const color = parseInt((game.get<UserDoc>("User", p.userId)?.color ?? "#ff9f1c").slice(1), 16);
    const ring = new Graphics();
    ring.position.set(p.x, p.y);
    this.layers.pings.addChild(ring);
    const start = performance.now();
    const size = this.scene?.grid.size ?? 100;
    const tick = () => {
      const t = (performance.now() - start) / 1400;
      if (t >= 1) {
        this.app.ticker.remove(tick);
        ring.destroy();
        return;
      }
      ring.clear();
      for (const k of [0, 0.33]) {
        const r = size * (0.2 + ((t + k) % 1) * 1.1);
        ring.circle(0, 0, r).stroke({ width: 4, color, alpha: 1 - ((t + k) % 1) });
      }
    };
    this.app.ticker.add(tick);
  }
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ",");
}

const textures = new Map<string, Promise<Texture | null>>();
export function loadTexture(src: string): Promise<Texture | null> {
  if (!textures.has(src)) {
    textures.set(src, Assets.load<Texture>({ src, parser: src.endsWith(".svg") ? "loadSVG" : undefined }).catch(() => null));
  }
  return textures.get(src)!;
}

function placeholder(name: string, w: number, h: number, color: number): Container {
  const c = new Container();
  const r = Math.min(w, h) / 2 - 4;
  c.addChild(new Graphics().circle(w / 2, h / 2, r).fill({ color: 0x1b1b22 }).stroke({ width: 4, color }));
  const t = new Text({ text: initials(name), style: { fill: 0xffffff, fontSize: r * 0.8, fontWeight: "700", fontFamily: "Inter, system-ui, sans-serif" } });
  t.anchor.set(0.5);
  t.position.set(w / 2, h / 2);
  c.addChild(t);
  return c;
}
