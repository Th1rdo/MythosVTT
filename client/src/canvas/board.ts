import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type { ActorDoc, DisplayMode, PingEvent, SceneDoc, TokenDoc, UserDoc } from "../../../shared/protocol.ts";
import { DISPLAY, OWNERSHIP } from "../../../shared/protocol.ts";
import { ownershipLevel } from "../../../shared/permissions.ts";
import type { Point } from "../../../shared/geometry.ts";
import { GRID, hexCenters, hexPolygon, isHex, measure, snapPoint, snapTokenPosition } from "../../../shared/grid.ts";
import type { GridSpec } from "../../../shared/grid.ts";
import { barValue, tokenActor } from "../../../shared/actors.ts";
import type { TokenActor } from "../../../shared/actors.ts";
import { CONDITION_BY_ID, DEAD } from "../../../shared/conditions.ts";
import { defaultLevel, tokenOnLevel } from "../../../shared/levels.ts";
import { game, toast } from "../game.ts";
import { settings } from "../settings.ts";
import { dragData, initials } from "../dom.ts";
import { openSheet } from "../ui/sheet.ts";
import { toggleCombat } from "../ui/combat.ts";
import { openTokenHUD } from "./token-hud.ts";
import { hooks } from "../hooks.ts";

const DISPOSITION_COLOR: Record<number, number> = { [-1]: 0xd9534f, 0: 0xe0b84a, 1: 0x4fa3d9 };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const FONT = "Inter, system-ui, sans-serif";

export type ToolName = "tokens" | "walls" | "lights" | "sounds" | "ruler" | "tiles" | "drawings" | "notes" | "regions";

/** A canvas tool receives pointer input that doesn't land on a token. */
export interface Tool {
  activate?(): void;
  deactivate?(): void;
  /** Return true when the tool consumed the press (otherwise the board pans). */
  down?(p: Point, e: FederatedPointerEvent): boolean;
  move?(p: Point, e: FederatedPointerEvent): void;
  up?(p: Point, e: FederatedPointerEvent): void;
  /** Context keys while the tool is active (Enter/Escape to finish shapes, Space for waypoints…). */
  key?(e: KeyboardEvent): boolean;
  /** The "delete" shortcut: remove what the tool has selected. */
  delete?(): boolean;
  dblclick?(p: Point, e: MouseEvent): boolean;
}

export interface TokenView {
  root: Container;
  body: Container;
  frame: Graphics;
  bars: Graphics;
  statuses: Container;
  elevation: Text;
  label: Text;
  doc: TokenDoc;
  hovered: boolean;
  /** Animation target while a move is easing in. */
  target: { x: number; y: number } | null;
}

type BoardEvent = "scene" | "tokens" | "selection" | "tool" | "frame";

type Drag =
  | { kind: "tokens"; anchor: string; offsets: Map<string, Point>; moved: boolean; start: Point }
  | { kind: "pan"; sx: number; sy: number; wx: number; wy: number }
  | { kind: "box"; from: Point; to: Point; additive: boolean }
  | { kind: "tool" };

/**
 * The scene canvas. Owns the PIXI application, the viewed scene's tokens, selection, pan/zoom and the
 * active tool. Other canvas modules (walls, lights, perception, ruler, HUD) attach to `layers` and
 * listen to board events.
 *
 * Input (tokens tool): click selects, Shift+click adds, drag on empty space draws a selection box,
 * right-drag or Space+drag pans, wheel zooms, Shift+wheel rotates the selection.
 * Coordinates: `world` is the panned/zoomed container; scene pixel (0,0) is the scene's top-left.
 */
export class Board {
  app = new Application();
  world = new Container();
  layers = {
    background: new Container(),
    tiles: new Container(),
    grid: new Graphics(),
    glow: new Container(),
    markers: new Container(),
    tokens: new Container(),
    foreground: new Container(),
    effects: new Container(),
    walls: new Container(),
    doors: new Container(),
    lights: new Container(),
    sounds: new Container(),
    controls: new Container(),
    pings: new Container()
  };
  tokens = new Map<string, TokenView>();
  tool: ToolName = "tokens";
  #tools = new Map<ToolName, Tool>();
  #selected = new Set<string>();
  #drag: Drag | null = null;
  #space = false;
  /** Whether the view was dragged while Space was held (so releasing Space shouldn't pause the game). */
  spacePanned = false;
  #sceneId: string | null = null;
  #views = new Map<string, { x: number; y: number; scale: number }>();
  #listeners = new Map<BoardEvent, Set<() => void>>();
  #dragLabel = new Text({ text: "", style: { fill: 0xffffff, fontSize: 22, fontWeight: "700", fontFamily: FONT, stroke: { color: 0x000000, width: 5 } } });
  #box = new Graphics();

  async mount(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: host, background: 0x0b0b0e, antialias: true, autoDensity: true, resolution: devicePixelRatio });
    host.append(this.app.canvas);
    const L = this.layers;
    this.world.addChild(L.background, L.tiles, L.grid, L.glow, L.markers, L.tokens, L.foreground, L.effects, L.walls, L.doors, L.lights, L.sounds, L.controls, L.pings);
    // Overlays never take input: in PIXI v8 even passive graphics win hit tests and would swallow token clicks.
    for (const layer of [L.grid, L.glow, L.markers, L.effects, L.walls, L.controls, L.pings]) layer.eventMode = "none";
    this.#dragLabel.anchor.set(0.5, 1);
    this.#dragLabel.visible = false;
    L.controls.addChild(this.#dragLabel, this.#box);
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
      const types = e.dataTransfer?.types ?? [];
      if (types.includes("application/x-mesa-actor") || types.includes("application/x-mesa-doc")) e.preventDefault();
    });
    this.app.canvas.addEventListener("drop", e => this.#onDrop(e));
    window.addEventListener("keydown", e => this.#onKey(e));
    window.addEventListener("keyup", e => {
      if (e.key === " ") this.#space = false;
    });
    this.app.ticker.add(() => this.#animate());
    const fps = () => (this.app.ticker.maxFPS = Number(settings.get("core.maxFPS")) || 0);
    fps();
    settings.onChange("core.maxFPS", fps);

    game.on("view", () => this.#loadScene());
    game.on("ready", () => this.#loadScene());
    game.on("Scene", e => {
      if (e.ids.includes(this.#sceneId ?? "")) this.#drawScene(false);
    });
    game.on("Level", e => {
      if (!e.docs.some(d => d._parent === this.#sceneId)) return;
      if (e.op === "delete" && e.ids.includes(game.viewedLevelId ?? "")) game.view(this.#sceneId);
      else this.#drawScene(false);
    });
    game.on("Token", e => this.#onTokens(e.op, e.docs as TokenDoc[], e.ids));
    const redrawAll = () => this.redrawTokens();
    game.on("Actor", redrawAll);
    game.on("ActiveEffect", redrawAll);
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
    for (const v of this.tokens.values()) v.root.eventMode = name === "tokens" ? "static" : "none";
    this.select([]);
    this.emit("tool");
  }

  // -------------------------------------------------------------------------
  // Scene

  get scene(): SceneDoc | undefined {
    return game.viewedScene;
  }

  /** Selected ("controlled") tokens. */
  get selected(): TokenView[] {
    return [...this.#selected].map(id => this.tokens.get(id)).filter((v): v is TokenView => !!v);
  }

  /** The first selected token (for single-token actions). */
  get selectedToken(): TokenView | undefined {
    return this.selected[0];
  }

  /** The level tokens with no level belong to (the scene's default). */
  get defaultLevelId(): string | null {
    return this.scene ? defaultLevel(this.scene, game)?._id ?? null : null;
  }

  /** Whether a token is on the level being viewed. */
  onViewedLevel(t: TokenDoc): boolean {
    return tokenOnLevel(t, game.viewedLevelId, this.defaultLevelId);
  }

  /** Scene pixels per distance unit. */
  get pxPerUnit(): number {
    const g = this.scene?.grid;
    return g ? g.size / (g.distance || 1) : 1;
  }

  /** The viewed scene's grid. */
  get grid(): GridSpec {
    const g = this.scene?.grid;
    return { type: g?.type ?? GRID.SQUARE, size: g?.size ?? 100, distance: g?.distance ?? 1, diagonals: settings.get("core.gridDiagonals") };
  }

  /** Snap a point to the grid (square: corners and centres; hex: centres and corners), unless disabled. */
  snap(p: Point, enabled = true): Point {
    if (!enabled) return { x: Math.round(p.x), y: Math.round(p.y) };
    return snapPoint(this.grid, p);
  }

  /** Grid position for a token whose top-left is at `p`, kept inside the scene. */
  snapToken(p: Point, doc: TokenDoc): Point {
    const scene = this.scene!;
    const size = scene.grid.size;
    const at = snapTokenPosition(this.grid, p, doc.width, doc.height);
    return { x: clamp(at.x, 0, Math.max(0, scene.width - doc.width * size)), y: clamp(at.y, 0, Math.max(0, scene.height - doc.height * size)) };
  }

  /** Live token centre (follows the sprite during drags). */
  tokenCenter(v: TokenView): Point {
    const size = this.scene?.grid.size ?? 100;
    return { x: v.root.x + (v.doc.width * size) / 2, y: v.root.y + (v.doc.height * size) / 2 };
  }

  /** Token's position on screen (CSS pixels relative to the canvas). */
  tokenScreenRect(v: TokenView): { x: number; y: number; w: number; h: number } {
    const size = this.scene?.grid.size ?? 100;
    const s = this.world.scale.x;
    const g = v.root.getGlobalPosition();
    return { x: g.x, y: g.y, w: v.doc.width * size * s, h: v.doc.height * size * s };
  }

  #loadScene(): void {
    if (this.#sceneId) this.#views.set(this.#sceneId, { x: this.world.x, y: this.world.y, scale: this.world.scale.x });
    this.#sceneId = game.viewedSceneId;
    for (const t of this.tokens.values()) t.root.destroy({ children: true });
    this.tokens.clear();
    this.#selected.clear();
    this.#drawScene(true);
    if (this.scene) for (const t of game.children<TokenDoc>("Token", this.scene._id)) if (this.onViewedLevel(t)) this.#upsertToken(t);
    this.emit("scene");
    this.emit("tokens");
    this.emit("selection");
  }

  async #drawScene(resetView: boolean): Promise<void> {
    const scene = this.scene;
    const bg = this.layers.background;
    const fg = this.layers.foreground;
    bg.removeChildren().forEach(c => c.destroy());
    fg.removeChildren().forEach(c => c.destroy());
    this.layers.grid.clear();
    if (!scene) return;

    // Scenes with levels take their art from the viewed level (Foundry v14); others from the scene.
    const level = game.viewedLevel;
    const color = level?.background.color ?? scene.backgroundColor ?? "#111111";
    bg.addChild(new Graphics().rect(0, 0, scene.width, scene.height).fill(color || "#111111"));
    this.#drawGrid(scene);
    if (resetView) {
      const saved = this.#views.get(scene._id);
      if (saved) {
        this.world.position.set(saved.x, saved.y);
        this.world.scale.set(saved.scale);
      } else this.fit();
    }
    const art = async (src: string | null | undefined, into: Container) => {
      if (!src) return;
      const tex = await loadTexture(src);
      if (!tex || this.scene?._id !== scene._id || game.viewedLevelId !== (level?._id ?? null)) return;
      const sprite = new Sprite(tex);
      sprite.width = scene.width;
      sprite.height = scene.height;
      sprite.eventMode = "none"; // foreground art sits above tokens and must not eat their clicks
      into.addChild(sprite);
    };
    await Promise.all([art(level?.background.src ?? scene.img, bg), art(level?.foreground.src, fg)]);
    this.emit("scene");
    if (resetView && this.scene?._id === scene._id) hooks.callAll("canvasReady", this);
  }

  #drawGrid(scene: SceneDoc): void {
    const { size, color, alpha } = scene.grid;
    if (!size || size < 10 || alpha <= 0 || this.grid.type === GRID.GRIDLESS) return;
    if (isHex(this.grid)) {
      for (const c of hexCenters(this.grid, scene.width, scene.height)) this.layers.grid.poly(hexPolygon(this.grid, c));
      this.layers.grid.stroke({ width: 1, color, alpha });
      return;
    }
    for (let x = 0; x <= scene.width; x += size) this.layers.grid.moveTo(x, 0).lineTo(x, scene.height);
    for (let y = 0; y <= scene.height; y += size) this.layers.grid.moveTo(0, y).lineTo(scene.width, y);
    this.layers.grid.stroke({ width: 1, color, alpha });
  }

  /** Centre the view on a token without changing the zoom. */
  panTo(tokenId: string): void {
    const v = this.tokens.get(tokenId);
    if (!v || !v.root.visible) return;
    const c = this.tokenCenter(v);
    this.panToPoint(c.x, c.y);
  }

  /** Centre the view on a point of the scene without changing the zoom. */
  panToPoint(x: number, y: number): void {
    const s = this.world.scale.x;
    this.world.position.set(this.app.screen.width / 2 - x * s, this.app.screen.height / 2 - y * s);
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

  /** The actor a token represents (synthetic for unlinked tokens), with effects applied. */
  actorOf(doc: TokenDoc): TokenActor | null {
    return tokenActor(doc, game);
  }

  select(ids: string[], additive = false): void {
    const next = new Set(additive ? [...this.#selected, ...ids] : ids);
    const changed = next.size !== this.#selected.size || [...next].some(id => !this.#selected.has(id));
    if (!changed) return;
    const touched = new Set([...this.#selected, ...next]);
    const was = this.#selected;
    this.#selected = next;
    for (const id of touched) {
      const v = this.tokens.get(id);
      if (v) this.#decorate(v);
    }
    this.emit("selection");
    for (const id of touched) {
      if (was.has(id) === next.has(id)) continue;
      const v = this.tokens.get(id);
      if (v) hooks.callAll("controlToken", v.doc, next.has(id));
    }
  }

  #onTokens(op: string, docs: TokenDoc[], ids: string[]): void {
    if (op === "delete") {
      for (const id of ids) this.#removeToken(id);
    } else {
      for (const d of docs) {
        if (d._parent !== this.#sceneId) continue;
        if (this.onViewedLevel(d)) this.#upsertToken(d, op === "update");
        else this.#removeToken(d._id);
      }
    }
    this.emit("tokens");
  }

  #removeToken(id: string): void {
    const t = this.tokens.get(id);
    if (!t) return;
    t.root.destroy({ children: true });
    this.tokens.delete(id);
    if (this.#selected.delete(id)) this.emit("selection");
  }

  redrawTokens(): void {
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
      root.on("pointerover", () => {
        view!.hovered = true;
        this.#decorate(view!);
      });
      root.on("pointerout", () => {
        view!.hovered = false;
        this.#decorate(view!);
      });
      const label = new Text({ text: "", style: { fill: 0xffffff, fontSize: 16, fontFamily: FONT, stroke: { color: 0x000000, width: 4 } } });
      label.anchor.set(0.5, 0);
      const elevation = new Text({ text: "", style: { fill: 0xffffff, fontSize: 14, fontWeight: "700", fontFamily: FONT, stroke: { color: 0x000000, width: 4 } } });
      elevation.anchor.set(1, 0);
      view = {
        root, body: new Container(), frame: new Graphics(), bars: new Graphics(), statuses: new Container(), elevation, label,
        doc, hovered: false, target: null
      };
      root.addChild(view.body, view.frame, view.bars, view.statuses, view.elevation, view.label);
      root.position.set(doc.x, doc.y);
      this.layers.tokens.addChild(root);
      this.tokens.set(doc._id, view);
    }
    const prev = view.doc;
    view.doc = doc;

    const w = doc.width * size;
    const ht = doc.height * size;
    const state = this.actorOf(doc);
    const actor = state?.source;
    const img = doc.img ?? actor?.token?.img ?? actor?.img ?? null;
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
    view.elevation.text = doc.elevation ? `${doc.elevation > 0 ? "+" : ""}${doc.elevation}` : "";
    view.elevation.position.set(w - 2, 2);
    this.#drawStatuses(view, state, w);
    this.#decorate(view);

    const dragging = this.#drag?.kind === "tokens" && this.#drag.offsets.has(doc._id);
    if (!dragging && (prev.x !== doc.x || prev.y !== doc.y || !animate)) {
      if (animate) view.target = { x: doc.x, y: doc.y };
      else view.root.position.set(doc.x, doc.y);
    }
  }

  #shows(mode: DisplayMode | undefined, v: TokenView): boolean {
    const owner = this.canMove(v.doc);
    switch (mode ?? DISPLAY.HOVER) {
      case DISPLAY.NONE: return false;
      case DISPLAY.CONTROL: return this.#selected.has(v.doc._id);
      case DISPLAY.OWNER_HOVER: return owner && v.hovered;
      case DISPLAY.HOVER: return v.hovered || this.#selected.has(v.doc._id);
      case DISPLAY.OWNER: return owner;
      case DISPLAY.ALWAYS: return true;
      default: return false;
    }
  }

  /** Selection frame, facing marker, name and bars — the parts that depend on hover/selection. */
  #decorate(view: TokenView): void {
    const size = this.scene?.grid.size ?? 100;
    const w = view.doc.width * size;
    const ht = view.doc.height * size;
    const selected = this.#selected.has(view.doc._id);
    view.root.alpha = view.doc.hidden ? 0.45 : 1;
    view.frame.clear();
    if (selected) {
      view.frame.rect(1, 1, w - 2, ht - 2).stroke({ width: 3, color: 0xff9f1c });
      if (view.doc.sight.angle < 360 || view.doc.light.angle < 360) {
        const a = (view.doc.rotation * Math.PI) / 180 + Math.PI / 2;
        const r = Math.min(w, ht) / 2 + 6;
        view.frame.circle(w / 2 + Math.cos(a) * r, ht / 2 + Math.sin(a) * r, 5).fill(0xff9f1c);
      }
    } else if (view.hovered) {
      view.frame.rect(1, 1, w - 2, ht - 2).stroke({ width: 2, color: 0xffffff, alpha: 0.6 });
    }
    view.label.visible = this.#shows(view.doc.displayName, view);

    view.bars.clear();
    if (!this.#shows(view.doc.displayBars, view)) return;
    const state = this.actorOf(view.doc);
    if (!state) return;
    const barH = Math.max(6, ht * 0.08);
    const draw = (attr: string | null, y: number, color: (pct: number) => number) => {
      const bar = barValue(state.derived, attr);
      if (!bar || bar.max <= 0) return;
      const pct = Math.max(0, Math.min(1, bar.value / bar.max));
      view.bars.roundRect(0, y, w, barH, 3).fill({ color: 0x000000, alpha: 0.7 });
      view.bars.roundRect(1, y + 1, Math.max(0, (w - 2) * pct), barH - 2, 2).fill(color(pct));
    };
    draw(view.doc.bar1.attribute, ht - barH, pct => (pct > 0.5 ? 0x3fbf5f : pct > 0.25 ? 0xe0b84a : 0xd9534f));
    draw(view.doc.bar2.attribute, 0, () => 0x4f8fd9);
  }

  #drawStatuses(view: TokenView, state: TokenActor | null, w: number): void {
    view.statuses.removeChildren().forEach(c => c.destroy());
    if (!state) return;
    const ids = [...state.statuses];
    const dead = state.statuses.has(DEAD);
    view.body.alpha = dead ? 0.5 : 1;
    if (dead) {
      const skull = new Text({ text: "💀", style: { fontSize: w * 0.6 } });
      skull.anchor.set(0.5);
      skull.position.set(w / 2, w / 2);
      view.statuses.addChild(skull);
    }
    const icon = Math.max(14, w * 0.22);
    ids.filter(id => id !== DEAD).forEach((id, i) => {
      const c = CONDITION_BY_ID.get(id);
      const effect = state.effects.find(e => e.statuses?.includes(id));
      const t = new Text({ text: c?.icon ?? effect?.icon ?? "✨", style: { fontSize: icon * 0.75 } });
      t.anchor.set(0.5);
      const cell = new Container();
      cell.addChild(new Graphics().circle(0, 0, icon / 2).fill({ color: 0x000000, alpha: 0.65 }), t);
      const perRow = Math.max(1, Math.floor(w / icon));
      cell.position.set(icon / 2 + (i % perRow) * icon, icon / 2 + Math.floor(i / perRow) * icon);
      view.statuses.addChild(cell);
    });
    // Effects without a condition but with an icon (custom effects) show too.
    const extra = state.effects.filter(e => !e.disabled && !(e.statuses ?? []).length && e.icon);
    extra.forEach((e, j) => {
      const i = ids.filter(id => id !== DEAD).length + j;
      const t = new Text({ text: e.icon.length <= 4 ? e.icon : "✨", style: { fontSize: icon * 0.75 } });
      t.anchor.set(0.5);
      const cell = new Container();
      cell.addChild(new Graphics().circle(0, 0, icon / 2).fill({ color: 0x000000, alpha: 0.65 }), t);
      const perRow = Math.max(1, Math.floor(w / icon));
      cell.position.set(icon / 2 + (i % perRow) * icon, icon / 2 + Math.floor(i / perRow) * icon);
      view.statuses.addChild(cell);
    });
  }

  #animate(): void {
    let moved = false;
    for (const v of this.tokens.values()) {
      if (!v.target) continue;
      const dx = v.target.x - v.root.x;
      const dy = v.target.y - v.root.y;
      if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || settings.get("core.reduceMotion")) {
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
    const v = this.tokens.get(id)!;
    if (e.button === 2) {
      e.stopPropagation();
      if (!this.canMove(v.doc)) return;
      if (!this.#selected.has(id)) this.select([id]);
      openTokenHUD(this, id);
      return;
    }
    if (e.button !== 0 || this.#space) return;
    e.stopPropagation();
    if (e.shiftKey) {
      // Shift+click toggles the token in the selection.
      if (this.#selected.has(id)) this.select([...this.#selected].filter(x => x !== id));
      else this.select([id], true);
      return;
    }
    if (!this.#selected.has(id)) this.select([id]);
    // Drag every selected token the user may move, keeping their relative positions.
    const p = this.toWorld(e);
    const offsets = new Map<string, Point>();
    for (const s of this.selected) {
      if (!this.canMove(s.doc)) continue;
      s.target = null;
      offsets.set(s.doc._id, { x: p.x - s.root.x, y: p.y - s.root.y });
      this.layers.tokens.addChild(s.root); // bring to front
    }
    if (!offsets.size) return;
    this.#drag = { kind: "tokens", anchor: id, offsets, moved: false, start: { x: v.root.x, y: v.root.y } };
  }

  #onStageDown(e: FederatedPointerEvent): void {
    const pan = () => (this.#drag = { kind: "pan", sx: e.global.x, sy: e.global.y, wx: this.world.x, wy: this.world.y });
    if (this.#space) this.spacePanned = true;
    if (e.button === 1 || e.button === 2 || this.#space) return void pan();
    if (e.button !== 0) return;
    const tool = this.#tools.get(this.tool);
    if (tool?.down?.(this.toWorld(e), e)) {
      this.#drag = { kind: "tool" };
      return;
    }
    if (this.tool === "tokens") {
      const p = this.toWorld(e);
      if (!e.shiftKey) this.select([]);
      this.#drag = { kind: "box", from: p, to: p, additive: e.shiftKey };
      return;
    }
    pan();
  }

  #onMove(e: FederatedPointerEvent): void {
    const d = this.#drag;
    if (!d || d.kind === "tool") {
      this.#tools.get(this.tool)?.move?.(this.toWorld(e), e);
      return;
    }
    if (d.kind === "pan") {
      this.world.position.set(d.wx + e.global.x - d.sx, d.wy + e.global.y - d.sy);
      return;
    }
    if (d.kind === "box") {
      d.to = this.toWorld(e);
      const x = Math.min(d.from.x, d.to.x), y = Math.min(d.from.y, d.to.y);
      this.#box.clear().rect(x, y, Math.abs(d.to.x - d.from.x), Math.abs(d.to.y - d.from.y))
        .fill({ color: 0xff9f1c, alpha: 0.08 }).stroke({ width: 2 / this.world.scale.x, color: 0xff9f1c });
      return;
    }
    const scene = this.scene;
    if (!scene) return;
    const p = this.toWorld(e);
    for (const [id, off] of d.offsets) this.tokens.get(id)?.root.position.set(p.x - off.x, p.y - off.y);
    d.moved = true;
    // Distance readout for the token under the pointer.
    const v = this.tokens.get(d.anchor);
    if (v) {
      const size = scene.grid.size;
      const dist = measure(this.grid, d.start, this.snapToken({ x: v.root.x, y: v.root.y }, v.doc));
      this.#dragLabel.text = `${formatNumber(dist)} ${scene.grid.units}`;
      this.#dragLabel.position.set(v.root.x + (v.doc.width * size) / 2, v.root.y - 6);
      this.#dragLabel.visible = true;
    }
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
    if (d?.kind === "box") {
      this.#box.clear();
      const x1 = Math.min(d.from.x, d.to.x), x2 = Math.max(d.from.x, d.to.x);
      const y1 = Math.min(d.from.y, d.to.y), y2 = Math.max(d.from.y, d.to.y);
      if (x2 - x1 < 4 && y2 - y1 < 4) return;
      const inside = [...this.tokens.values()].filter(v => {
        const c = this.tokenCenter(v);
        return v.root.visible && this.canMove(v.doc) && c.x >= x1 && c.x <= x2 && c.y >= y1 && c.y <= y2;
      });
      this.select(inside.map(v => v.doc._id), d.additive);
      return;
    }
    if (!d || d.kind !== "tokens" || !d.moved) return;
    const scene = this.scene;
    if (!scene) return;
    const updates: { _id: string; x: number; y: number }[] = [];
    for (const id of d.offsets.keys()) {
      const v = this.tokens.get(id);
      if (!v) continue;
      const { x, y } = this.snapToken({ x: v.root.x, y: v.root.y }, v.doc);
      v.target = { x, y };
      updates.push({ _id: id, x, y });
    }
    try {
      await game.update("Token", updates, scene._id);
    } catch {
      for (const id of d.offsets.keys()) {
        const v = this.tokens.get(id);
        if (v) v.target = { x: v.doc.x, y: v.doc.y };
      }
    }
  }

  #onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Shift + wheel rotates the selected tokens (15° steps).
    const movable = this.selected.filter(v => this.canMove(v.doc));
    if (e.shiftKey && movable.length && this.scene) {
      const step = e.deltaY > 0 ? 15 : -15;
      game.update("Token", movable.map(v => ({ _id: v.doc._id, rotation: (((v.doc.rotation + step) % 360) + 360) % 360 })), this.scene._id);
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
    if (this.tool === "tokens") {
      const v = [...this.tokens.values()].find(t => {
        const size = this.scene?.grid.size ?? 100;
        return t.root.visible && p.x >= t.root.x && p.x <= t.root.x + t.doc.width * size && p.y >= t.root.y && p.y <= t.root.y + t.doc.height * size;
      });
      if (v) {
        if (v.doc.actorId && this.scene) openSheet(v.doc.actorId, v.doc.actorLink ? undefined : { tokenId: v.doc._id, sceneId: this.scene._id });
        return;
      }
    }
    game.ping(p.x, p.y);
    this.#onPing({ userId: game.userId, sceneId: this.#sceneId!, x: p.x, y: p.y });
  }

  async #onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    const where = this.eventToWorld(e);
    if (!hooks.call("dropCanvasData", this, { ...dragData(e.dataTransfer), x: where.x, y: where.y })) return;
    const actorId = e.dataTransfer?.getData("application/x-mesa-actor");
    const actor = game.get<ActorDoc>("Actor", actorId);
    const scene = this.scene;
    if (!actor || !scene) return;
    if (!game.isGM) return toast("Só o mestre pode pôr tokens no mapa");
    const size = scene.grid.size;
    const p = this.eventToWorld(e);
    const proto = actor.token;
    const at = snapTokenPosition(this.grid, { x: p.x - (proto.width * size) / 2, y: p.y - (proto.height * size) / 2 }, proto.width, proto.height);
    await game.create("Token", {
      name: actor.name, actorId: actor._id, img: proto.img ?? actor.img,
      x: at.x, y: at.y,
      width: proto.width, height: proto.height, disposition: proto.disposition,
      actorLink: proto.actorLink, displayName: proto.displayName, displayBars: proto.displayBars,
      bar1: proto.bar1, bar2: proto.bar2, sight: proto.sight, light: proto.light,
      level: game.viewedLevelId
    }, scene._id);
  }

  #onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === " ") {
      if (!e.repeat) this.spacePanned = false;
      this.#space = true;
      if (this.tool !== "ruler") e.preventDefault();
    }
    if (this.#tools.get(this.tool)?.key?.(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  // -------------------------------------------------------------------------
  // Actions behind keyboard shortcuts (see shell/keys.ts). Each returns whether it did something.

  /** Clear the selection (tokens tool). */
  deselect(): boolean {
    if (this.tool !== "tokens" || !this.#selected.size) return false;
    this.select([]);
    return true;
  }

  selectAll(): boolean {
    if (this.tool !== "tokens" || !this.scene) return false;
    this.select([...this.tokens.values()].filter(v => v.root.visible && this.canMove(v.doc)).map(v => v.doc._id));
    return true;
  }

  /** Delete what the active tool has selected (tokens: GM only). */
  deleteSelected(): boolean {
    const tool = this.#tools.get(this.tool);
    if (tool?.delete) return tool.delete();
    const scene = this.scene;
    if (this.tool !== "tokens" || !scene || !game.isGM || !this.#selected.size) return false;
    game.delete("Token", [...this.#selected], scene._id);
    return true;
  }

  /** GM: hide or show the selected tokens. */
  toggleHidden(): boolean {
    const scene = this.scene;
    const selected = this.selected;
    if (!game.isGM || !scene || !selected.length) return false;
    const hide = selected.some(v => !v.doc.hidden);
    game.update("Token", selected.map(v => ({ _id: v.doc._id, hidden: hide })), scene._id);
    return true;
  }

  /** Add or remove the selected tokens from combat. */
  toggleCombatSelected(): boolean {
    if (this.tool !== "tokens" || !this.#selected.size) return false;
    toggleCombat([...this.#selected]);
    return true;
  }

  /** Step the selected tokens by whole cells. */
  moveSelected(cx: number, cy: number): boolean {
    const scene = this.scene;
    const selected = this.selected;
    if (this.tool !== "tokens" || !scene || !selected.length) return false;
    {
      const size = scene.grid.size;
      const dx = cx * size;
      const dy = cy * size;
      const movable = selected.filter(v => this.canMove(v.doc));
      // Step from where each token is heading, so quick repeated presses add up.
      // On hex grids a step lands on the neighbouring hex in that direction.
      const step = isHex(this.grid) ? 0.9 : 1;
      const updates = movable.map(v => {
        const from = v.target ?? { x: v.doc.x, y: v.doc.y };
        const { x, y } = this.snapToken({ x: from.x + dx * step, y: from.y + dy * step }, v.doc);
        v.target = { x, y };
        return { _id: v.doc._id, x, y };
      });
      if (updates.length) {
        game.update("Token", updates, scene._id).catch(() => {
          for (const v of movable) v.target = { x: v.doc.x, y: v.doc.y };
        });
      }
    }
    return true;
  }

  /** Zoom around the centre of the view. */
  zoomBy(factor: number): boolean {
    if (!this.scene) return false;
    const w = this.world;
    const cx = this.app.screen.width / 2, cy = this.app.screen.height / 2;
    const before = { x: (cx - w.x) / w.scale.x, y: (cy - w.y) / w.scale.y };
    const s = clamp(w.scale.x * factor, MIN_ZOOM, MAX_ZOOM);
    w.scale.set(s);
    w.position.set(cx - before.x * s, cy - before.y * s);
    this.emit("frame");
    return true;
  }

  #onPing(p: PingEvent): void {
    if (p.sceneId !== this.#sceneId) return;
    const color = parseInt((game.get<UserDoc>("User", p.userId)?.color ?? "#ff9f1c").slice(1), 16);
    const ring = new Graphics();
    ring.position.set(p.x, p.y);
    this.layers.pings.addChild(ring);
    const start = performance.now();
    const size = this.scene?.grid.size ?? 100;
    const still = !!settings.get("core.reduceMotion");
    const tick = () => {
      const t = (performance.now() - start) / 1400;
      if (still && t < 1) {
        // No animation: one steady ring until the ping ends.
        if (!ring.children.length && ring.width === 0) ring.circle(0, 0, size * 0.6).stroke({ width: 4, color });
        return;
      }
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
  const t = new Text({ text: initials(name), style: { fill: 0xffffff, fontSize: r * 0.8, fontWeight: "700", fontFamily: FONT } });
  t.anchor.set(0.5);
  t.position.set(w / 2, h / 2);
  c.addChild(t);
  return c;
}
