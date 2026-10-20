import { Container, Graphics, Text } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type { AmbientSoundDoc, WallDoc } from "../../../shared/protocol.ts";
import type { Point } from "../../../shared/geometry.ts";
import { visibilityPolygon, wallEdges } from "../../../shared/geometry.ts";
import { onLevel } from "../../../shared/levels.ts";
import { game } from "../game.ts";
import type { Board, Tool } from "./board.ts";
import { formatNumber } from "./board.ts";
import type { AmbientPlayer } from "../audio/ambient.ts";
import { openAmbientSoundConfig } from "../ui/audio-config.ts";

/**
 * Ambient sounds (GM, sounds tool):
 *   drag on empty space → new sound, the drag length is its radius (then pick the file)
 *   drag an icon → move; double-click → config; right-click → on/off; Delete → remove
 *   moving the mouse previews what a token standing there would hear
 */
export class SoundsLayer implements Tool {
  #board: Board;
  #ambient: AmbientPlayer;
  #icons = new Map<string, Container>();
  #fields = new Graphics();
  #preview = new Graphics();
  #label = new Text({ text: "", style: { fill: 0xffffff, fontSize: 20, fontWeight: "700", stroke: { color: 0x000000, width: 4 } } });
  #draft: { at: Point; to: Point } | null = null;
  #selected: string | null = null;
  /** Whether dragging on empty space creates a sound (false = select/move only). */
  drawing = true;

  constructor(board: Board, ambient: AmbientPlayer) {
    this.#board = board;
    this.#ambient = ambient;
    this.#label.anchor.set(0.5, 1);
    for (const g of [this.#fields, this.#preview, this.#label]) g.eventMode = "none";
    board.layers.sounds.addChild(this.#fields, this.#preview, this.#label);
    board.registerTool("sounds", this);
    const redraw = () => this.redraw();
    board.on("scene", redraw);
    board.on("tool", redraw);
    game.on("AmbientSound", redraw);
    game.on("Wall", redraw);
    game.on("view", redraw);
    redraw();
  }

  redraw(): void {
    const scene = this.#board.scene;
    const editing = this.#board.tool === "sounds" && game.isGM;
    const sounds = scene && editing ? game.children<AmbientSoundDoc>("AmbientSound", scene._id).filter(s => onLevel(s, game.viewedLevelId)) : [];
    const keep = new Set(sounds.map(s => s._id));
    for (const [id, c] of this.#icons) {
      if (!keep.has(id)) {
        c.destroy({ children: true });
        this.#icons.delete(id);
      }
    }
    // Hearing areas: the reachable space for wall-constrained sounds, the plain circle otherwise.
    this.#fields.clear();
    if (scene && sounds.length) {
      const edges = wallEdges(game.children<WallDoc>("Wall", scene._id).filter(w => onLevel(w, game.viewedLevelId)), "sound");
      const bounds = { x: 0, y: 0, width: scene.width, height: scene.height };
      for (const s of sounds) {
        const r = s.radius * this.#board.pxPerUnit;
        if (s.walls) this.#fields.poly(visibilityPolygon({ x: s.x, y: s.y }, edges, bounds, { radius: r }).flatMap(p => [p.x, p.y]));
        else this.#fields.circle(s.x, s.y, r);
        this.#fields.fill({ color: 0x4fc3f7, alpha: s.hidden ? 0.03 : 0.08 }).stroke({ width: 2, color: 0x4fc3f7, alpha: s.hidden ? 0.25 : 0.6 });
      }
    }
    for (const s of sounds) {
      let c = this.#icons.get(s._id);
      if (!c) {
        c = new Container();
        c.eventMode = "static";
        c.cursor = "grab";
        c.on("pointerdown", e => this.#onIconDown(s._id, e));
        this.#board.layers.sounds.addChild(c);
        this.#icons.set(s._id, c);
      }
      c.removeChildren().forEach(ch => ch.destroy());
      const selected = this.#selected === s._id;
      const icon = new Text({ text: s.path ? "🔊" : "🔇", style: { fontSize: 18 } });
      icon.anchor.set(0.5);
      c.addChild(
        new Graphics().circle(0, 0, 18).fill({ color: 0x14141a, alpha: 0.85 }).stroke({ width: selected ? 4 : 2, color: selected ? 0xff9f1c : 0x4fc3f7 }),
        icon
      );
      c.alpha = s.hidden ? 0.4 : 1;
      c.position.set(s.x, s.y);
    }
  }

  #onIconDown(id: string, e: FederatedPointerEvent): void {
    e.stopPropagation();
    const scene = this.#board.scene;
    const s = game.get<AmbientSoundDoc>("AmbientSound", id);
    if (!s || !scene) return;
    if (e.button === 2) {
      game.update("AmbientSound", { _id: id, hidden: !s.hidden }, scene._id);
      return;
    }
    this.#selected = id;
    this.redraw();
    if (s.locked) return;
    const p = this.#board.toWorld(e);
    const offset = { x: p.x - s.x, y: p.y - s.y };
    const stage = this.#board.app.stage;
    const move = (ev: FederatedPointerEvent) => {
      const q = this.#board.toWorld(ev);
      this.#icons.get(id)?.position.set(q.x - offset.x, q.y - offset.y);
    };
    const up = (ev: FederatedPointerEvent) => {
      stage.off("globalpointermove", move);
      stage.off("pointerup", up);
      stage.off("pointerupoutside", up);
      const w = this.#board.toWorld(ev);
      const q = this.#board.snap({ x: w.x - offset.x, y: w.y - offset.y }, !ev.shiftKey);
      if (q.x !== s.x || q.y !== s.y) game.update("AmbientSound", { _id: id, x: Math.round(q.x), y: Math.round(q.y) }, scene._id);
    };
    stage.on("globalpointermove", move);
    stage.on("pointerup", up);
    stage.on("pointerupoutside", up);
  }

  deactivate(): void {
    this.#draft = null;
    this.#selected = null;
    this.#preview.clear();
    this.#label.visible = false;
    this.#ambient.preview(null);
  }

  down(p: Point, e: FederatedPointerEvent): boolean {
    if (!game.isGM || !this.drawing) return false;
    const at = this.#board.snap(p, !e.shiftKey);
    this.#selected = null;
    this.#draft = { at, to: at };
    this.redraw();
    return true;
  }

  move(p: Point): void {
    if (!game.isGM) return;
    if (!this.#draft) {
      this.#ambient.preview(p);
      return;
    }
    this.#draft.to = p;
    const r = Math.hypot(p.x - this.#draft.at.x, p.y - this.#draft.at.y);
    const scene = this.#board.scene!;
    this.#preview.clear().circle(this.#draft.at.x, this.#draft.at.y, r).fill({ color: 0x4fc3f7, alpha: 0.12 }).stroke({ width: 2, color: 0x4fc3f7 });
    this.#label.text = `${formatNumber(r / this.#board.pxPerUnit)} ${scene.grid.units}`;
    this.#label.position.set(this.#draft.at.x, this.#draft.at.y - r - 4);
    this.#label.visible = true;
  }

  async up(): Promise<void> {
    const d = this.#draft;
    this.#draft = null;
    this.#preview.clear();
    this.#label.visible = false;
    const scene = this.#board.scene;
    if (!d || !scene) return;
    const r = Math.hypot(d.to.x - d.at.x, d.to.y - d.at.y) / this.#board.pxPerUnit;
    const radius = r > 0.5 ? Math.round(r * 2) / 2 : 6;
    const [created] = await game.create<AmbientSoundDoc>("AmbientSound", {
      x: Math.round(d.at.x), y: Math.round(d.at.y), radius, elevation: game.viewedLevel?.elevation.bottom ?? 0,
      levels: game.viewedLevelId ? [game.viewedLevelId] : []
    }, scene._id);
    if (created) openAmbientSoundConfig(created._id, scene._id);
  }

  delete(): boolean {
    const scene = this.#board.scene;
    if (!this.#selected || !scene) return false;
    game.delete("AmbientSound", this.#selected, scene._id);
    this.#selected = null;
    return true;
  }

  dblclick(p: Point): boolean {
    const scene = this.#board.scene;
    if (!scene || !game.isGM) return false;
    const tol = 22 / this.#board.world.scale.x;
    const hit = game.children<AmbientSoundDoc>("AmbientSound", scene._id).find(s => Math.hypot(s.x - p.x, s.y - p.y) < tol);
    if (!hit) return false;
    openAmbientSoundConfig(hit._id, scene._id);
    return true;
  }
}
