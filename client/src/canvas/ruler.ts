import { Container, Graphics, Text } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type { UserDoc } from "../../../shared/protocol.ts";
import type { Point } from "../../../shared/geometry.ts";
import { measure } from "../../../shared/grid.ts";
import { game } from "../game.ts";
import type { Board, Tool } from "./board.ts";
import { formatNumber } from "./board.ts";

export interface RulerEvent {
  userId: string;
  sceneId: string;
  /** Waypoints; empty = clear. */
  points: Point[];
}

/**
 * Measuring tool. Drag to measure; click while dragging (or press Space) to add a waypoint.
 * Other players see your ruler live.
 */
export class Ruler implements Tool {
  #board: Board;
  #mine: Point[] = [];
  #cursor: Point | null = null;
  #views = new Map<string, Container>();
  #lastSent = 0;

  constructor(board: Board) {
    this.#board = board;
    board.registerTool("ruler", this);
    game.socket.on("ruler", (r: RulerEvent) => {
      if (r.sceneId !== game.viewedSceneId || r.userId === game.userId) return;
      this.#draw(r.userId, r.points);
    });
    board.on("scene", () => {
      for (const v of this.#views.values()) v.destroy({ children: true });
      this.#views.clear();
    });
  }

  down(p: Point, e: FederatedPointerEvent): boolean {
    const start = this.#board.snap(p, !e.shiftKey);
    this.#mine = [start];
    this.#cursor = start;
    this.#update();
    return true;
  }

  move(p: Point, e: FederatedPointerEvent): void {
    if (!this.#mine.length) return;
    this.#cursor = this.#board.snap(p, !e.shiftKey);
    this.#update();
  }

  up(): void {
    this.#mine = [];
    this.#cursor = null;
    setTimeout(() => {
      if (!this.#mine.length) this.#send(true);
    }, 600);
  }

  key(e: KeyboardEvent): boolean {
    if (this.#board.tool !== "ruler" || !this.#mine.length || !this.#cursor) return false;
    if (e.key === " ") {
      this.#mine.push(this.#cursor);
      e.preventDefault();
      return true;
    }
    return false;
  }

  #update(): void {
    const points = this.#cursor ? [...this.#mine, this.#cursor] : this.#mine;
    this.#draw(game.userId, points);
    this.#send(false);
  }

  #send(clear: boolean): void {
    const now = performance.now();
    if (!clear && now - this.#lastSent < 50) return;
    this.#lastSent = now;
    const points = clear ? [] : this.#cursor ? [...this.#mine, this.#cursor] : this.#mine;
    if (clear) this.#draw(game.userId, []);
    if (game.viewedSceneId) game.socket.emit("ruler", { sceneId: game.viewedSceneId, points });
  }

  #draw(userId: string, points: Point[]): void {
    let view = this.#views.get(userId);
    if (!points.length) {
      view?.destroy({ children: true });
      this.#views.delete(userId);
      return;
    }
    const scene = this.#board.scene;
    if (!scene) return;
    if (!view) {
      view = new Container();
      this.#board.layers.controls.addChild(view);
      this.#views.set(userId, view);
    }
    view.removeChildren().forEach(c => c.destroy());
    const color = game.get<UserDoc>("User", userId)?.color ?? "#ff9f1c";
    const scale = 1 / Math.max(0.3, this.#board.world.scale.x);
    const g = new Graphics();
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      total += measure(this.#board.grid, a, b);
    }
    g.stroke({ width: 8 * scale, color: 0x000000, alpha: 0.5 });
    for (let i = 1; i < points.length; i++) g.moveTo(points[i - 1].x, points[i - 1].y).lineTo(points[i].x, points[i].y);
    g.stroke({ width: 4 * scale, color });
    for (const p of points) g.circle(p.x, p.y, 6 * scale).fill(color);
    const end = points[points.length - 1];
    const label = new Text({
      text: `${formatNumber(total)} ${scene.grid.units}`,
      style: { fill: 0xffffff, fontSize: 22 * scale, fontWeight: "700", fontFamily: "Inter, system-ui, sans-serif", stroke: { color: 0x000000, width: 5 * scale } }
    });
    label.anchor.set(0, 1);
    label.position.set(end.x + 10 * scale, end.y - 10 * scale);
    view.addChild(g, label);
  }
}
