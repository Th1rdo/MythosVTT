import { Container, Graphics, Text } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type { AmbientLightDoc } from "../../../shared/protocol.ts";
import type { Point } from "../../../shared/geometry.ts";
import { game } from "../game.ts";
import type { Board, Tool } from "./board.ts";
import { formatNumber } from "./board.ts";
import { openLightConfig } from "../ui/canvas-config.ts";

/**
 * Ambient lights (GM, lights tool):
 *   drag on empty space → new light, the drag length is its dim radius (bright = half)
 *   drag an icon → move; double-click → config; right-click → on/off; Delete → remove
 */
export class LightsLayer implements Tool {
  #board: Board;
  #icons = new Map<string, Container>();
  #preview = new Graphics();
  #label = new Text({ text: "", style: { fill: 0xffffff, fontSize: 20, fontWeight: "700", stroke: { color: 0x000000, width: 4 } } });
  #draft: { at: Point; to: Point } | null = null;
  #moving: { id: string; dx: number; dy: number } | null = null;
  #selected: string | null = null;

  constructor(board: Board) {
    this.#board = board;
    this.#label.anchor.set(0.5, 1);
    this.#preview.eventMode = "none";
    this.#label.eventMode = "none";
    board.layers.lights.addChild(this.#preview, this.#label);
    board.registerTool("lights", this);
    const redraw = () => this.redraw();
    board.on("scene", redraw);
    board.on("tool", redraw);
    game.on("AmbientLight", redraw);
    redraw();
  }

  redraw(): void {
    const scene = this.#board.scene;
    const editing = this.#board.tool === "lights" && game.isGM;
    const lights = scene && editing ? game.children<AmbientLightDoc>("AmbientLight", scene._id) : [];
    const keep = new Set(lights.map(l => l._id));
    for (const [id, c] of this.#icons) {
      if (!keep.has(id)) {
        c.destroy({ children: true });
        this.#icons.delete(id);
      }
    }
    for (const l of lights) {
      let c = this.#icons.get(l._id);
      if (!c) {
        c = new Container();
        c.eventMode = "static";
        c.cursor = "grab";
        c.on("pointerdown", e => this.#onIconDown(l._id, e));
        this.#board.layers.lights.addChild(c);
        this.#icons.set(l._id, c);
      }
      c.removeChildren().forEach(ch => ch.destroy());
      const selected = this.#selected === l._id;
      const bulb = new Text({ text: "💡", style: { fontSize: 18 } });
      bulb.anchor.set(0.5);
      c.addChild(
        new Graphics().circle(0, 0, 18).fill({ color: 0x14141a, alpha: 0.85 }).stroke({ width: selected ? 4 : 2, color: selected ? 0xff9f1c : l.config.color ?? "#ffffff" }),
        bulb
      );
      c.alpha = l.hidden ? 0.4 : 1;
      c.position.set(l.x, l.y);
    }
  }

  #onIconDown(id: string, e: FederatedPointerEvent): void {
    e.stopPropagation();
    const scene = this.#board.scene;
    const l = game.get<AmbientLightDoc>("AmbientLight", id);
    if (!l || !scene) return;
    if (e.button === 2) {
      game.update("AmbientLight", { _id: id, hidden: !l.hidden }, scene._id);
      return;
    }
    this.#selected = id;
    const p = this.#board.toWorld(e);
    this.#moving = { id, dx: p.x - l.x, dy: p.y - l.y };
    this.redraw();
    // Movement is tracked through the stage's global move/up handlers.
    const stage = this.#board.app.stage;
    const move = (ev: FederatedPointerEvent) => {
      const q = this.#board.toWorld(ev);
      this.#icons.get(id)?.position.set(q.x - this.#moving!.dx, q.y - this.#moving!.dy);
    };
    const up = (ev: FederatedPointerEvent) => {
      stage.off("globalpointermove", move);
      stage.off("pointerup", up);
      stage.off("pointerupoutside", up);
      const q = this.#board.snap({ x: this.#board.toWorld(ev).x - this.#moving!.dx, y: this.#board.toWorld(ev).y - this.#moving!.dy }, !ev.shiftKey);
      this.#moving = null;
      if (q.x !== l.x || q.y !== l.y) game.update("AmbientLight", { _id: id, x: q.x, y: q.y }, scene._id);
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
  }

  down(p: Point, e: FederatedPointerEvent): boolean {
    if (!game.isGM) return false;
    const at = this.#board.snap(p, !e.shiftKey);
    this.#selected = null;
    this.#draft = { at, to: at };
    this.redraw();
    return true;
  }

  move(p: Point): void {
    if (!this.#draft) return;
    this.#draft.to = p;
    const r = Math.hypot(p.x - this.#draft.at.x, p.y - this.#draft.at.y);
    const scene = this.#board.scene!;
    this.#preview.clear().circle(this.#draft.at.x, this.#draft.at.y, r).fill({ color: 0xffc070, alpha: 0.15 }).stroke({ width: 2, color: 0xffc070 });
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
    const dim = r > 0.5 ? Math.round(r * 2) / 2 : 6;
    await game.create("AmbientLight", { x: d.at.x, y: d.at.y, config: { dim, bright: dim / 2 } }, scene._id);
  }

  key(e: KeyboardEvent): boolean {
    if (this.#board.tool !== "lights" || !this.#selected) return false;
    const scene = this.#board.scene;
    if ((e.key === "Delete" || e.key === "Backspace") && scene) {
      game.delete("AmbientLight", this.#selected, scene._id);
      this.#selected = null;
      return true;
    }
    return false;
  }

  dblclick(p: Point): boolean {
    const scene = this.#board.scene;
    if (!scene || !game.isGM) return false;
    const tol = 22 / this.#board.world.scale.x;
    const hit = game.children<AmbientLightDoc>("AmbientLight", scene._id).find(l => Math.hypot(l.x - p.x, l.y - p.y) < tol);
    if (!hit) return false;
    openLightConfig(hit._id, scene._id);
    return true;
  }
}
