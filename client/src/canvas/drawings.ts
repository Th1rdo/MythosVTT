import { Container, Graphics, Text } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type { DrawingDoc, UserDoc } from "../../../shared/protocol.ts";
import type { Point } from "../../../shared/geometry.ts";
import { onLevel } from "../../../shared/levels.ts";
import { game } from "../game.ts";
import type { Board, Tool } from "./board.ts";
import { openDrawingConfig } from "../ui/canvas-config.ts";
import { prompt } from "../ui/windows.ts";

export type DrawTool = "select" | DrawingDoc["shape"]["type"];

interface DrawingView {
  root: Container;
  doc: DrawingDoc;
}

/** Draw a drawing's shape into a Graphics (shared by rendering and the live preview). */
function paint(g: Graphics, d: Pick<DrawingDoc, "shape" | "strokeWidth" | "strokeColor" | "strokeAlpha" | "fillColor" | "fillAlpha">): void {
  const { type, width, height, points } = d.shape;
  if (type === "rectangle") g.rect(0, 0, width, height);
  else if (type === "ellipse") g.ellipse(width / 2, height / 2, Math.abs(width / 2), Math.abs(height / 2));
  else if (type === "polygon" || type === "freehand") {
    if (points.length < 4) return;
    g.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) g.lineTo(points[i], points[i + 1]);
    if (type === "polygon") g.closePath();
  } else return;
  if (d.fillColor && (type !== "freehand")) g.fill({ color: d.fillColor, alpha: d.fillAlpha });
  if (d.strokeWidth > 0) g.stroke({ width: d.strokeWidth, color: d.strokeColor, alpha: d.strokeAlpha, join: "round", cap: "round" });
}

/**
 * Drawings layer (everyone): shapes, freehand lines and text on the map, under the tokens.
 * Authors (and the GM) can select, drag, delete (Del) and configure (double-click) their drawings.
 */
export class DrawingsLayer implements Tool {
  tool: DrawTool = "select";
  #board: Board;
  #layer = new Container();
  #preview = new Graphics();
  #views = new Map<string, DrawingView>();
  #selected: string | null = null;
  #draft: { start: Point; points: number[]; last: Point } | null = null;
  #polygon: number[] | null = null;
  #polyOrigin: Point | null = null;

  constructor(board: Board) {
    this.#board = board;
    // Drawings sit with the tiles, under tokens.
    board.layers.tiles.addChild(this.#layer);
    board.layers.controls.addChild(this.#preview);
    this.#preview.eventMode = "none";
    board.registerTool("drawings", this);
    const redraw = () => this.redraw();
    board.on("scene", redraw);
    board.on("tool", redraw);
    game.on("Drawing", redraw);
    game.on("view", redraw);
    redraw();
  }

  #canEdit(d: DrawingDoc): boolean {
    return game.isGM || d.author === game.userId;
  }

  /** Default style: the user's colour. */
  #style(): Pick<DrawingDoc, "strokeWidth" | "strokeColor" | "strokeAlpha" | "fillColor" | "fillAlpha"> {
    const color = game.get<UserDoc>("User", game.userId)?.color ?? "#ffffff";
    const filled = this.tool === "rectangle" || this.tool === "ellipse" || this.tool === "polygon";
    return { strokeWidth: 8, strokeColor: color, strokeAlpha: 1, fillColor: filled ? color : null, fillAlpha: 0.15 };
  }

  redraw(): void {
    const scene = this.#board.scene;
    const docs = scene ? game.children<DrawingDoc>("Drawing", scene._id).filter(d => onLevel(d, game.viewedLevelId)).sort((a, b) => a.sort - b.sort) : [];
    const keep = new Set(docs.map(d => d._id));
    for (const [id, v] of this.#views) if (!keep.has(id)) { v.root.destroy({ children: true }); this.#views.delete(id); }
    const editing = this.#board.tool === "drawings" && this.tool === "select";
    for (const d of docs) {
      let v = this.#views.get(d._id);
      if (!v) {
        v = { root: new Container(), doc: d };
        v.root.on("pointerdown", e => this.#onDown(d._id, e));
        this.#layer.addChild(v.root);
        this.#views.set(d._id, v);
      }
      v.doc = d;
      v.root.removeChildren().forEach(c => c.destroy());
      v.root.position.set(d.x, d.y);
      v.root.angle = d.rotation;
      v.root.alpha = d.hidden ? 0.5 : 1;
      const g = new Graphics();
      paint(g, d);
      v.root.addChild(g);
      if (d.text) {
        const t = new Text({ text: d.text, style: { fill: d.textColor, fontSize: d.fontSize, fontFamily: "Signika, sans-serif", fontWeight: "600", stroke: { color: 0x000000, width: Math.max(2, d.fontSize / 10) }, wordWrap: d.shape.type !== "text", wordWrapWidth: Math.max(50, d.shape.width) } });
        t.anchor.set(0.5);
        t.position.set(d.shape.width / 2, d.shape.height / 2);
        v.root.addChild(t);
      }
      v.root.eventMode = editing && this.#canEdit(d) ? "static" : "none";
      v.root.cursor = "move";
      if (editing && this.#selected === d._id) {
        const b = v.root.getLocalBounds();
        v.root.addChild(new Graphics().rect(b.x - 6, b.y - 6, b.width + 12, b.height + 12).stroke({ width: 3, color: 0xff9f1c }));
      }
    }
  }

  #onDown(id: string, e: FederatedPointerEvent): void {
    if (e.button !== 0 || this.tool !== "select") return;
    e.stopPropagation();
    const d = game.get<DrawingDoc>("Drawing", id);
    if (!d || !this.#canEdit(d)) return;
    this.#selected = id;
    this.redraw();
    if (d.locked) return;
    const p = this.#board.toWorld(e);
    const off = { x: p.x - d.x, y: p.y - d.y };
    const stage = this.#board.app.stage;
    const move = (ev: FederatedPointerEvent) => {
      const q = this.#board.toWorld(ev);
      this.#views.get(id)?.root.position.set(q.x - off.x, q.y - off.y);
    };
    const up = (ev: FederatedPointerEvent) => {
      stage.off("globalpointermove", move);
      stage.off("pointerup", up);
      stage.off("pointerupoutside", up);
      const q = this.#board.toWorld(ev);
      const at = { x: Math.round(q.x - off.x), y: Math.round(q.y - off.y) };
      if (at.x !== d.x || at.y !== d.y) game.update("Drawing", { _id: id, ...at }, d._parent);
    };
    stage.on("globalpointermove", move);
    stage.on("pointerup", up);
    stage.on("pointerupoutside", up);
  }

  deactivate(): void {
    this.#selected = null;
    this.#draft = null;
    this.#polygon = null;
    this.#preview.clear();
  }

  down(p: Point, e: FederatedPointerEvent): boolean {
    if (this.tool === "select") {
      this.#selected = null;
      this.redraw();
      return false;
    }
    if (this.tool === "text") {
      this.#createText(p);
      return true;
    }
    if (this.tool === "polygon") {
      const at = this.#board.snap(p, !e.shiftKey);
      if (!this.#polygon) {
        this.#polygon = [0, 0];
        this.#polyOrigin = at;
      } else this.#polygon.push(at.x - this.#polyOrigin!.x, at.y - this.#polyOrigin!.y);
      this.#previewPolygon(at);
      return true;
    }
    const start = this.tool === "freehand" ? p : this.#board.snap(p, !e.shiftKey);
    this.#draft = { start, points: [0, 0], last: start };
    return true;
  }

  move(p: Point, e: FederatedPointerEvent): void {
    if (this.#polygon) return this.#previewPolygon(this.#board.snap(p, !e.shiftKey));
    const d = this.#draft;
    if (!d) return;
    if (this.tool === "freehand") {
      // Keep a point every few pixels so long lines stay light.
      if (Math.hypot(p.x - d.last.x, p.y - d.last.y) < 6) return;
      d.points.push(p.x - d.start.x, p.y - d.start.y);
      d.last = p;
      this.#preview.clear().position.set(d.start.x, d.start.y);
      paint(this.#preview, { ...this.#style(), shape: { type: "freehand", width: 0, height: 0, points: d.points } });
      return;
    }
    const end = this.#board.snap(p, !e.shiftKey);
    d.last = end;
    const x = Math.min(d.start.x, end.x), y = Math.min(d.start.y, end.y);
    this.#preview.clear().position.set(x, y);
    paint(this.#preview, { ...this.#style(), shape: { type: this.tool as "rectangle", width: Math.abs(end.x - d.start.x), height: Math.abs(end.y - d.start.y), points: [] } });
  }

  async up(): Promise<void> {
    const d = this.#draft;
    this.#draft = null;
    const scene = this.#board.scene;
    if (!d || !scene) return;
    this.#preview.clear();
    const levels = game.viewedLevelId ? [game.viewedLevelId] : [];
    if (this.tool === "freehand") {
      if (d.points.length < 6) return;
      const xs = d.points.filter((_, i) => i % 2 === 0), ys = d.points.filter((_, i) => i % 2 === 1);
      await game.create("Drawing", {
        ...this.#style(), x: d.start.x, y: d.start.y, levels,
        shape: { type: "freehand", width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), points: d.points.map(n => Math.round(n)) }
      }, scene._id);
      return;
    }
    const w = Math.abs(d.last.x - d.start.x), h = Math.abs(d.last.y - d.start.y);
    if (w < 4 && h < 4) return;
    await game.create("Drawing", {
      ...this.#style(), x: Math.min(d.start.x, d.last.x), y: Math.min(d.start.y, d.last.y), levels,
      shape: { type: this.tool, width: w, height: h, points: [] }
    }, scene._id);
  }

  async #createText(p: Point): Promise<void> {
    const scene = this.#board.scene;
    const v = await prompt("Texto no mapa", [{ name: "text", label: "Texto" }]);
    if (!v?.text.trim() || !scene) return;
    await game.create("Drawing", {
      ...this.#style(), strokeWidth: 0, fillColor: null, x: p.x - 150, y: p.y - 40, text: v.text.trim(),
      textColor: game.get<UserDoc>("User", game.userId)?.color ?? "#ffffff",
      shape: { type: "text", width: 300, height: 80, points: [] }, levels: game.viewedLevelId ? [game.viewedLevelId] : []
    }, scene._id);
  }

  #previewPolygon(cursor: Point): void {
    const o = this.#polyOrigin!;
    this.#preview.clear().position.set(o.x, o.y);
    paint(this.#preview, { ...this.#style(), shape: { type: "freehand", width: 0, height: 0, points: [...this.#polygon!, cursor.x - o.x, cursor.y - o.y] } });
  }

  async #finishPolygon(): Promise<void> {
    const pts = this.#polygon, o = this.#polyOrigin, scene = this.#board.scene;
    this.#polygon = null;
    this.#preview.clear();
    if (!pts || !o || !scene || pts.length < 6) return;
    const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1);
    await game.create("Drawing", {
      ...this.#style(), x: o.x, y: o.y, levels: game.viewedLevelId ? [game.viewedLevelId] : [],
      shape: { type: "polygon", width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), points: pts }
    }, scene._id);
  }

  key(e: KeyboardEvent): boolean {
    if (this.#board.tool !== "drawings") return false;
    if (this.#polygon && (e.key === "Enter" || e.key === "Escape")) {
      if (e.key === "Enter") this.#finishPolygon();
      else {
        this.#polygon = null;
        this.#preview.clear();
      }
      return true;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.#selected) {
      const d = game.get<DrawingDoc>("Drawing", this.#selected);
      if (d) game.delete("Drawing", d._id, d._parent);
      this.#selected = null;
      return true;
    }
    return false;
  }

  dblclick(p: Point): boolean {
    if (this.#board.tool !== "drawings") return false;
    if (this.#polygon) {
      this.#finishPolygon();
      return true;
    }
    if (this.tool !== "select" || !this.#selected) return false;
    const d = game.get<DrawingDoc>("Drawing", this.#selected);
    if (!d) return false;
    void p;
    openDrawingConfig(d._id, d._parent!);
    return true;
  }

  /** GM: remove every drawing on the scene. */
  clearAll(): void {
    const scene = this.#board.scene;
    if (!scene) return;
    const ids = game.children<DrawingDoc>("Drawing", scene._id).map(d => d._id);
    if (ids.length) game.delete("Drawing", ids, scene._id);
  }
}
