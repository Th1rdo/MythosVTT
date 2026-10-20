import { Container, Graphics, Text } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type { WallDoc } from "../../../shared/protocol.ts";
import { DOOR, DOOR_STATE, SENSE } from "../../../shared/protocol.ts";
import type { Point } from "../../../shared/geometry.ts";
import { game, toast } from "../game.ts";
import { onLevel } from "../../../shared/levels.ts";
import type { Board, Tool } from "./board.ts";
import type { Perception } from "./perception.ts";
import { openWallConfig } from "../ui/canvas-config.ts";

/** Wall presets offered by the walls tool (Foundry has the same families). */
export const WALL_PRESETS = {
  wall: { label: "Parede", data: { move: 20, sight: 20, light: 20, sound: 20, door: 0 } },
  door: { label: "Porta", data: { move: 20, sight: 20, light: 20, sound: 20, door: DOOR.DOOR } },
  secret: { label: "Porta secreta", data: { move: 20, sight: 20, light: 20, sound: 20, door: DOOR.SECRET } },
  terrain: { label: "Terreno", data: { move: 20, sight: 10, light: 10, sound: 10, door: 0 } },
  invisible: { label: "Invisível", data: { move: 20, sight: 0, light: 0, sound: 0, door: 0 } },
  ethereal: { label: "Etérea", data: { move: 0, sight: 20, light: 20, sound: 20, door: 0 } },
  window: { label: "Janela", data: { move: 20, sight: 0, light: 0, sound: 20, door: 0 } }
} as const;
export type WallPreset = keyof typeof WALL_PRESETS;

function wallColor(w: WallDoc): number {
  if (w.door === DOOR.SECRET) return 0xc957d6;
  if (w.door === DOOR.DOOR) return 0x8f6bff;
  if (w.move === SENSE.NONE) return 0x9a9a9a;
  if (w.sight === SENSE.NONE) return 0x4fd3e8;
  if (w.sight === SENSE.LIMITED) return 0x6ad66a;
  return 0xf2efe9;
}

/**
 * Walls: GM editing (walls tool) and door controls (everyone).
 *   drag on empty space → new wall (snapped to half-grid; Shift = no snap)
 *   hold Ctrl/⌘ while releasing → keep chaining from the end point; Esc stops
 *   click a wall → select; Delete removes; double-click → config; drag an endpoint → move it
 */
export class WallsLayer implements Tool {
  /** Wall type drawn by the tool; null = select/edit only. */
  preset: WallPreset | null = "wall";
  #board: Board;
  #perception: Perception;
  #lines = new Graphics();
  #preview = new Graphics();
  #doors = new Map<string, Container>();
  #selected: string | null = null;
  #draft: { from: Point; to: Point } | null = null;
  #chainFrom: Point | null = null;
  #endpointDrag: { id: string; index: 0 | 1 } | null = null;

  constructor(board: Board, perception: Perception) {
    this.#board = board;
    this.#perception = perception;
    board.layers.walls.addChild(this.#lines, this.#preview);
    board.registerTool("walls", this);
    const redraw = () => this.redraw();
    board.on("scene", redraw);
    board.on("tool", redraw);
    board.on("tokens", () => this.#refreshDoorVisibility());
    board.on("frame", () => this.#refreshDoorVisibility());
    game.on("Wall", redraw);
    redraw();
  }

  get #walls(): WallDoc[] {
    const scene = this.#board.scene;
    return scene ? game.children<WallDoc>("Wall", scene._id).filter(w => onLevel(w, game.viewedLevelId)) : [];
  }

  redraw(): void {
    const editing = this.#board.tool === "walls" && game.isGM;
    this.#lines.clear();
    this.#lines.visible = editing;
    if (editing) {
      const scale = 1 / Math.max(0.25, this.#board.world.scale.x);
      for (const w of this.#walls) {
        const [x1, y1, x2, y2] = w.c;
        const selected = w._id === this.#selected;
        this.#lines.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: (selected ? 6 : 4) * scale, color: selected ? 0xff9f1c : wallColor(w), alpha: 0.95 });
        if (w.dir) {
          // Arrow pointing to the side the wall blocks from (LEFT walls block viewers on their right).
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          const len = Math.hypot(x2 - x1, y2 - y1) || 1;
          const nx = (y2 - y1) / len, ny = -(x2 - x1) / len;
          const s = w.dir === 1 ? 1 : -1;
          this.#lines.moveTo(mx, my).lineTo(mx + nx * 18 * s * scale, my + ny * 18 * s * scale).stroke({ width: 3 * scale, color: 0xff9f1c });
        }
        for (const [x, y] of [[x1, y1], [x2, y2]]) this.#lines.circle(x, y, 5 * scale).fill(selected ? 0xff9f1c : 0x222222).stroke({ width: 2 * scale, color: wallColor(w) });
      }
    }
    this.#redrawDoors();
  }

  // -------------------------------------------------------------------------
  // Doors

  #redrawDoors(): void {
    const layer = this.#board.layers.doors;
    const walls = this.#walls.filter(w => w.door !== DOOR.NONE);
    const keep = new Set(walls.map(w => w._id));
    for (const [id, c] of this.#doors) {
      if (!keep.has(id)) {
        c.destroy({ children: true });
        this.#doors.delete(id);
      }
    }
    for (const w of walls) {
      let c = this.#doors.get(w._id);
      if (!c) {
        c = new Container();
        c.eventMode = "static";
        c.cursor = "pointer";
        c.on("pointerdown", e => this.#onDoorClick(w._id, e));
        layer.addChild(c);
        this.#doors.set(w._id, c);
      }
      c.removeChildren().forEach(ch => ch.destroy());
      const icon = w.ds === DOOR_STATE.LOCKED ? "🔒" : w.ds === DOOR_STATE.OPEN ? "▯" : "▮";
      const bg = new Graphics().roundRect(-15, -15, 30, 30, 6).fill({ color: 0x14141a, alpha: 0.85 }).stroke({ width: 2, color: w.door === DOOR.SECRET ? 0xc957d6 : 0x8f6bff });
      const t = new Text({ text: icon, style: { fontSize: 18, fill: 0xffffff } });
      t.anchor.set(0.5);
      c.addChild(bg, t);
      c.position.set((w.c[0] + w.c[2]) / 2, (w.c[1] + w.c[3]) / 2);
    }
    this.#refreshDoorVisibility();
  }

  /** Players only get door controls for doors they can currently see. */
  #refreshDoorVisibility(): void {
    for (const [id, c] of this.#doors) {
      if (game.isGM) {
        c.visible = true;
        continue;
      }
      const w = game.get<WallDoc>("Wall", id);
      c.visible = !!w && this.#perception.canSee({ x: (w.c[0] + w.c[2]) / 2, y: (w.c[1] + w.c[3]) / 2 });
    }
  }

  async #onDoorClick(id: string, e: FederatedPointerEvent): Promise<void> {
    e.stopPropagation();
    const w = game.get<WallDoc>("Wall", id);
    const scene = this.#board.scene;
    if (!w || !scene) return;
    if (e.button === 2) {
      if (!game.isGM) return;
      await game.update("Wall", { _id: id, ds: w.ds === DOOR_STATE.LOCKED ? DOOR_STATE.CLOSED : DOOR_STATE.LOCKED }, scene._id);
      return;
    }
    if (e.button !== 0) return;
    if (w.ds === DOOR_STATE.LOCKED) {
      toast("A porta está trancada");
      return;
    }
    await game.update("Wall", { _id: id, ds: w.ds === DOOR_STATE.OPEN ? DOOR_STATE.CLOSED : DOOR_STATE.OPEN }, scene._id).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Tool

  deactivate(): void {
    this.#draft = null;
    this.#chainFrom = null;
    this.#selected = null;
    this.#preview.clear();
  }

  /** The wall under the pointer: endpoints win over segments, nearest first. */
  #hit(p: Point): { wall: WallDoc; endpoint: 0 | 1 | null } | null {
    const tol = 10 / this.#board.world.scale.x;
    let endpoint: { wall: WallDoc; endpoint: 0 | 1; d: number } | null = null;
    let segment: { wall: WallDoc; d: number } | null = null;
    for (const w of this.#walls) {
      const [x1, y1, x2, y2] = w.c;
      for (const [i, x, y] of [[0, x1, y1], [1, x2, y2]] as const) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < tol && (!endpoint || d < endpoint.d)) endpoint = { wall: w, endpoint: i, d };
      }
      const d = distToSegment(p, x1, y1, x2, y2);
      if (d < tol && (!segment || d < segment.d)) segment = { wall: w, d };
    }
    if (endpoint) return { wall: endpoint.wall, endpoint: endpoint.endpoint };
    return segment ? { wall: segment.wall, endpoint: null } : null;
  }

  down(p: Point, e: FederatedPointerEvent): boolean {
    if (!game.isGM) return false;
    const hit = this.#chainFrom ? null : this.#hit(p);
    // Endpoints of the selected wall can be dragged; pressing on another wall's endpoint starts a new
    // wall joined to it; pressing on a wall's body selects it.
    if (hit?.endpoint != null && hit.wall._id === this.#selected) {
      this.#endpointDrag = { id: hit.wall._id, index: hit.endpoint };
      return true;
    }
    if (hit && hit.endpoint === null) {
      this.#selected = hit.wall._id;
      this.redraw();
      return true;
    }
    this.#selected = null;
    if (!this.preset) {
      this.redraw();
      return false;
    }
    const joined = hit ? { x: hit.wall.c[hit.endpoint! * 2], y: hit.wall.c[hit.endpoint! * 2 + 1] } : null;
    const from = this.#chainFrom ?? joined ?? this.#board.snap(p, !e.shiftKey);
    this.#draft = { from, to: from };
    this.redraw();
    return true;
  }

  move(p: Point, e: FederatedPointerEvent): void {
    const to = this.#board.snap(p, !e.shiftKey);
    if (this.#endpointDrag) {
      const w = game.get<WallDoc>("Wall", this.#endpointDrag.id);
      if (!w) return;
      const c = [...w.c];
      c[this.#endpointDrag.index * 2] = to.x;
      c[this.#endpointDrag.index * 2 + 1] = to.y;
      this.#drawPreview({ x: c[0], y: c[1] }, { x: c[2], y: c[3] });
      return;
    }
    if (this.#draft) {
      this.#draft.to = to;
      this.#drawPreview(this.#draft.from, to);
    } else if (this.#chainFrom) {
      this.#drawPreview(this.#chainFrom, to);
    }
  }

  async up(p: Point, e: FederatedPointerEvent): Promise<void> {
    const scene = this.#board.scene;
    if (!scene) return;
    const to = this.#board.snap(p, !e.shiftKey);
    if (this.#endpointDrag) {
      const { id, index } = this.#endpointDrag;
      this.#endpointDrag = null;
      this.#preview.clear();
      const w = game.get<WallDoc>("Wall", id);
      if (!w) return;
      const c = [...w.c] as WallDoc["c"];
      c[index * 2] = to.x;
      c[index * 2 + 1] = to.y;
      if (c[0] !== c[2] || c[1] !== c[3]) await game.update("Wall", { _id: id, c }, scene._id);
      return;
    }
    const draft = this.#draft;
    this.#draft = null;
    if (!draft) return;
    const chaining = e.ctrlKey || e.metaKey;
    if (draft.from.x === to.x && draft.from.y === to.y) {
      // A click (no drag) while chaining places the next point.
      if (!this.#chainFrom) this.#preview.clear();
      return;
    }
    // New walls belong to the level being edited (scenes with levels).
    const levels = game.viewedLevelId ? [game.viewedLevelId] : [];
    await game.create("Wall", { c: [draft.from.x, draft.from.y, to.x, to.y], ...WALL_PRESETS[this.preset ?? "wall"].data, levels }, scene._id);
    this.#chainFrom = chaining ? to : null;
    if (!chaining) this.#preview.clear();
  }

  key(e: KeyboardEvent): boolean {
    if (this.#board.tool !== "walls" || !game.isGM) return false;
    const scene = this.#board.scene;
    if (e.key === "Escape") {
      this.#chainFrom = null;
      this.#draft = null;
      this.#preview.clear();
      return true;
    }
    return false;
  }

  delete(): boolean {
    const scene = this.#board.scene;
    if (!game.isGM || !this.#selected || !scene) return false;
    game.delete("Wall", this.#selected, scene._id);
    this.#selected = null;
    return true;
  }

  dblclick(p: Point): boolean {
    if (!game.isGM) return false;
    const hit = this.#hit(p);
    const scene = this.#board.scene;
    if (!hit || !scene) return false;
    openWallConfig(hit.wall._id, scene._id);
    return true;
  }

  #drawPreview(a: Point, b: Point): void {
    const scale = 1 / Math.max(0.25, this.#board.world.scale.x);
    this.#preview.clear().moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 4 * scale, color: 0xff9f1c, alpha: 0.8 });
    this.#preview.circle(a.x, a.y, 5 * scale).fill(0xff9f1c);
  }
}

function distToSegment(p: Point, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / len2)) : 0;
  return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy));
}
