import { Container, Graphics, RenderTexture, Sprite, Texture } from "pixi.js";
import type { AmbientLightDoc, FogExplorationDoc, LightConfig, SceneDoc, WallDoc } from "../../../shared/protocol.ts";
import { FOG_MODE } from "../../../shared/protocol.ts";
import type { Point } from "../../../shared/geometry.ts";
import { pointInPolygon, unitsToPixels, visibilityPolygon, wallEdges } from "../../../shared/geometry.ts";
import { game } from "../game.ts";
import type { Board, TokenView } from "./board.ts";

/** Fog/vision textures are kept at most this many pixels on their longest side. */
const MAX_TEXTURE = 2048;
const FOG_SAVE_DELAY = 2000;

interface LightShape {
  key: string;
  config: LightConfig;
  dim: Point[];
  bright: Point[] | null;
  glow: Graphics;
}

/**
 * Vision, lighting and fog of war for the viewed scene.
 *
 * What a viewer sees = (sight-range polygons) ∪ (line-of-sight polygons ∩ lit areas). Lit areas are
 * ambient lights and token lights (each a wall-constrained polygon), or everything when global light
 * applies. Explored areas accumulate into a texture that is saved per user per scene.
 *
 * Players always look through tokens they own or observe. GMs see everything unless they select a
 * token that has vision, in which case they see what it sees.
 */
export class Perception {
  #board: Board;
  #root = new Container();
  /** Things rendered into the vision texture (scene coordinates, scaled down). */
  #visionScene = new Container();
  #fovG = new Graphics();
  #losG = new Graphics();
  #litG = new Graphics();
  #litGroup = new Container();
  #litScene = new Container();
  #litOnlyG = new Graphics();
  #visionRT: RenderTexture | null = null;
  #exploredRT: RenderTexture | null = null;
  #litRT: RenderTexture | null = null;
  #darkness = new Graphics();
  #unseen = new Graphics();
  #fog = new Graphics();
  #visionMask: Sprite | null = null;
  #exploredMask: Sprite | null = null;
  #litMask: Sprite | null = null;
  #scale = 1;
  #pending = false;
  #lights: LightShape[] = [];
  #visible: { fov: Point[][]; los: Point[][]; lit: Point[][]; global: boolean } | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #sceneId: string | null = null;
  #fogLoaded: string | null = null;
  #time = 0;

  constructor(board: Board) {
    this.#board = board;
    board.layers.effects.addChild(this.#root);
    this.#litGroup.addChild(this.#litG);
    this.#litGroup.mask = this.#losG;
    this.#visionScene.addChild(this.#fovG, this.#losG, this.#litGroup);
    this.#litScene.addChild(this.#litOnlyG);

    const refresh = () => this.refresh();
    board.on("scene", () => this.#onScene());
    board.on("tokens", refresh);
    board.on("frame", refresh);
    board.on("selection", refresh);
    for (const t of ["Wall", "AmbientLight", "Scene", "Token"] as const) game.on(t, refresh);
    game.on("FogExploration", e => {
      if (e.op === "delete" && e.docs.some(d => (d as FogExplorationDoc).user === game.userId && d._parent === this.#sceneId)) {
        this.#clearExplored();
      }
    });
    game.socket.on("resetFog", (sceneId: string) => {
      if (sceneId === this.#sceneId) this.#clearExplored();
    });
    board.app.ticker.add(t => this.#animateLights(t.deltaMS));
    this.#onScene();
  }

  /** Whether the local viewer currently sees this point (true when vision doesn't apply). */
  canSee(p: Point): boolean {
    const v = this.#visible;
    if (!v) return true;
    if (v.fov.some(poly => pointInPolygon(p, poly))) return true;
    if (!v.los.some(poly => pointInPolygon(p, poly))) return false;
    return v.global || v.lit.some(poly => pointInPolygon(p, poly));
  }

  refresh(): void {
    if (this.#pending) return;
    this.#pending = true;
    requestAnimationFrame(() => {
      this.#pending = false;
      this.#compute();
    });
  }

  // -------------------------------------------------------------------------

  #onScene(): void {
    const scene = this.#board.scene;
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveFog();
    }
    this.#sceneId = scene?._id ?? null;
    this.#fogLoaded = null;
    for (const rt of [this.#visionRT, this.#exploredRT, this.#litRT]) rt?.destroy(true);
    this.#visionRT = this.#exploredRT = this.#litRT = null;
    this.#root.removeChildren();
    if (!scene) return;

    this.#scale = Math.min(1, MAX_TEXTURE / Math.max(scene.width, scene.height));
    const w = Math.ceil(scene.width * this.#scale);
    const h = Math.ceil(scene.height * this.#scale);
    this.#visionRT = RenderTexture.create({ width: w, height: h });
    this.#exploredRT = RenderTexture.create({ width: w, height: h });
    this.#litRT = RenderTexture.create({ width: w, height: h });
    this.#visionScene.scale.set(this.#scale);
    this.#litScene.scale.set(this.#scale);

    const asMask = (rt: RenderTexture) => {
      const s = new Sprite(rt);
      s.scale.set(1 / this.#scale);
      return s;
    };
    this.#visionMask = asMask(this.#visionRT);
    this.#exploredMask = asMask(this.#exploredRT);
    this.#litMask = asMask(this.#litRT);
    this.#root.addChild(this.#visionMask, this.#exploredMask, this.#litMask, this.#darkness, this.#unseen, this.#fog);
    this.#darkness.setMask({ mask: this.#litMask, inverse: true });
    this.#unseen.setMask({ mask: this.#visionMask, inverse: true });
    this.#fog.setMask({ mask: this.#exploredMask, inverse: true });
    this.#loadFog();
    this.refresh();
  }

  /**
   * Tokens the local viewer looks through, or null when vision doesn't apply. Like Foundry: selected
   * tokens with vision if there are any; otherwise players see through every token they observe and
   * GMs see everything.
   */
  #viewers(scene: SceneDoc): TokenView[] | null {
    if (!scene.tokenVision) return null;
    const selected = this.#board.selected.filter(t => t.doc.sight.enabled && this.#board.isObserver(t.doc));
    if (selected.length) return selected;
    if (game.isGM) return null;
    return [...this.#board.tokens.values()].filter(t => t.doc.sight.enabled && this.#board.isObserver(t.doc));
  }

  #compute(): void {
    const scene = this.#board.scene;
    if (!scene || !this.#visionRT || scene._id !== this.#sceneId) return;
    const renderer = this.#board.app.renderer;
    const bounds = { x: 0, y: 0, width: scene.width, height: scene.height };
    const walls = game.children<WallDoc>("Wall", scene._id);
    const sightEdges = wallEdges(walls, "sight");
    const lightEdges = wallEdges(walls, "light");
    const env = scene.environment;
    const globalLit = env.globalLight && env.darkness <= env.globalLightThreshold;
    const px = (units: number) => unitsToPixels(units, scene.grid.size, scene.grid.distance);

    // ---- Lights (ambient + token lights)
    const sources: { key: string; at: Point; rotation: number; walls: boolean; config: LightConfig }[] = [];
    for (const l of game.children<AmbientLightDoc>("AmbientLight", scene._id)) {
      if (l.hidden) continue;
      sources.push({ key: l._id, at: { x: l.x, y: l.y }, rotation: l.rotation, walls: l.walls, config: l.config });
    }
    for (const t of this.#board.tokens.values()) {
      if (t.doc.hidden && !game.isGM) continue;
      if (t.doc.light.dim > 0 || t.doc.light.bright > 0) {
        sources.push({ key: `t:${t.doc._id}`, at: this.#board.tokenCenter(t), rotation: t.doc.rotation, walls: true, config: t.doc.light });
      }
    }
    const old = new Map(this.#lights.map(l => [l.key, l]));
    this.#lights = sources.map(s => {
      const reach = px(Math.max(s.config.dim, s.config.bright));
      const opts = { radius: reach, angle: s.config.angle, rotation: s.rotation };
      const edges = s.walls ? lightEdges : [];
      const dim = visibilityPolygon(s.at, edges, bounds, opts);
      const bright = s.config.bright > 0 && s.config.bright < s.config.dim
        ? visibilityPolygon(s.at, edges, bounds, { ...opts, radius: px(s.config.bright) })
        : null;
      const glow = old.get(s.key)?.glow ?? new Graphics();
      old.delete(s.key);
      return { key: s.key, config: s.config, dim, bright, glow };
    });
    for (const gone of old.values()) gone.glow.destroy();
    this.#drawGlow();

    // ---- Lit areas (for the darkness overlay)
    const litPolys = this.#lights.map(l => l.dim);
    this.#litOnlyG.clear();
    if (globalLit) this.#litOnlyG.rect(0, 0, scene.width, scene.height).fill(0xffffff);
    for (const poly of litPolys) this.#litOnlyG.poly(flat(poly)).fill(0xffffff);
    renderer.render({ container: this.#litScene, target: this.#litRT!, clear: true });
    this.#darkness.clear();
    if (env.darkness > 0) this.#darkness.rect(0, 0, scene.width, scene.height).fill({ color: 0x05050f, alpha: Math.min(0.92, env.darkness * 0.92) });

    // ---- Vision
    const viewers = this.#viewers(scene);
    this.#unseen.clear();
    this.#fog.clear();
    if (!viewers) {
      this.#visible = null;
      for (const t of this.#board.tokens.values()) t.root.visible = true;
      return;
    }
    const fov: Point[][] = [];
    const los: Point[][] = [];
    for (const v of viewers) {
      const origin = this.#board.tokenCenter(v);
      const cone = { angle: v.doc.sight.angle, rotation: v.doc.rotation };
      los.push(visibilityPolygon(origin, sightEdges, bounds, cone));
      if (v.doc.sight.range > 0) fov.push(visibilityPolygon(origin, sightEdges, bounds, { ...cone, radius: px(v.doc.sight.range) }));
      // A token always sees its own square.
      const size = scene.grid.size;
      fov.push(visibilityPolygon(origin, sightEdges, bounds, { radius: (Math.max(v.doc.width, v.doc.height) * size) / 2 + 2 }));
    }
    this.#visible = { fov, los, lit: litPolys, global: globalLit };

    this.#fovG.clear();
    for (const poly of fov) this.#fovG.poly(flat(poly)).fill(0xffffff);
    this.#losG.clear();
    for (const poly of los) this.#losG.poly(flat(poly)).fill(0xffffff);
    this.#litG.clear();
    if (globalLit) this.#litG.rect(0, 0, scene.width, scene.height).fill(0xffffff);
    else for (const poly of litPolys) this.#litG.poly(flat(poly)).fill(0xffffff);

    renderer.render({ container: this.#visionScene, target: this.#visionRT, clear: true });
    const fogOn = scene.fog.mode !== FOG_MODE.DISABLED;
    renderer.render({ container: this.#visionScene, target: this.#exploredRT!, clear: !fogOn });
    if (fogOn && !game.isGM) this.#scheduleSave();

    this.#unseen.rect(0, 0, scene.width, scene.height).fill({ color: scene.fog.explored || "#000000", alpha: 0.6 });
    this.#fog.rect(0, 0, scene.width, scene.height).fill({ color: scene.fog.unexplored || "#000000", alpha: 1 });

    // Tokens the viewer can't see are not drawn (their own always are).
    for (const t of this.#board.tokens.values()) {
      t.root.visible = viewers.includes(t) || this.#board.isObserver(t.doc) || this.canSee(this.#board.tokenCenter(t));
    }
  }

  // -------------------------------------------------------------------------
  // Light glow

  #drawGlow(): void {
    const layer = this.#board.layers.glow;
    layer.removeChildren();
    for (const l of this.#lights) {
      const g = l.glow;
      g.clear();
      const color = l.config.color ?? "#ffffff";
      const a = l.config.alpha ?? 0.5;
      g.poly(flat(l.dim)).fill({ color, alpha: a * 0.35 });
      if (l.bright) g.poly(flat(l.bright)).fill({ color, alpha: a * 0.35 });
      g.blendMode = "add";
      layer.addChild(g);
    }
  }

  #animateLights(dt: number): void {
    this.#time += dt / 1000;
    for (const l of this.#lights) {
      const anim = l.config.animation;
      if (!anim?.type) {
        l.glow.alpha = 1;
        continue;
      }
      const speed = (anim.speed ?? 5) / 5;
      const intensity = (anim.intensity ?? 5) / 10;
      const t = this.#time * speed;
      const seed = hash(l.key);
      let k = 1;
      if (anim.type === "pulse") k = 1 - intensity * 0.5 * (1 + Math.sin(t * 2 + seed));
      else if (anim.type === "torch") k = 1 - intensity * 0.35 * (0.5 + 0.5 * Math.sin(t * 7 + seed) * Math.sin(t * 3.1 + seed * 2));
      else if (anim.type === "flicker") k = Math.sin(t * 13 + seed) > 0.85 - intensity * 0.2 ? 0.45 : 1;
      l.glow.alpha = Math.max(0.1, k);
    }
  }

  // -------------------------------------------------------------------------
  // Fog persistence

  #ownFog(): FogExplorationDoc | undefined {
    return this.#sceneId ? game.children<FogExplorationDoc>("FogExploration", this.#sceneId).find(f => f.user === game.userId) : undefined;
  }

  #clearExplored(): void {
    if (!this.#exploredRT) return;
    this.#board.app.renderer.render({ container: new Container(), target: this.#exploredRT, clear: true });
    this.#fogLoaded = null;
    this.refresh();
  }

  async #loadFog(): Promise<void> {
    const doc = this.#ownFog();
    const sceneId = this.#sceneId;
    if (!doc?.explored || this.#fogLoaded === doc._id) return;
    const img = new Image();
    img.src = doc.explored;
    try {
      await img.decode();
    } catch {
      return;
    }
    if (sceneId !== this.#sceneId || !this.#exploredRT) return;
    const sprite = new Sprite(Texture.from(img));
    sprite.width = this.#exploredRT.width;
    sprite.height = this.#exploredRT.height;
    this.#board.app.renderer.render({ container: sprite, target: this.#exploredRT, clear: false });
    sprite.destroy({ texture: true });
    this.#fogLoaded = doc._id;
    this.refresh();
  }

  #scheduleSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#saveFog(), FOG_SAVE_DELAY);
  }

  async #saveFog(): Promise<void> {
    this.#saveTimer = null;
    const sceneId = this.#sceneId;
    if (!sceneId || !this.#exploredRT) return;
    const explored = await this.#board.app.renderer.extract.base64({ target: this.#exploredRT, format: "webp", quality: 0.8 });
    const existing = this.#ownFog();
    try {
      if (existing) await game.update("FogExploration", { _id: existing._id, explored }, sceneId);
      else {
        const [created] = await game.create<FogExplorationDoc>("FogExploration", { explored }, sceneId);
        this.#fogLoaded = created?._id ?? null;
      }
    } catch {
      // Toast already shown; exploration stays in memory and is retried on the next change.
    }
  }
}

function flat(poly: Point[]): number[] {
  const out = new Array(poly.length * 2);
  for (let i = 0; i < poly.length; i++) {
    out[i * 2] = poly[i].x;
    out[i * 2 + 1] = poly[i].y;
  }
  return out;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000;
  return h;
}
