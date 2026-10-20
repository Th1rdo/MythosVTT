import { Container, Graphics, Text } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type { LevelDoc, LevelPromptEvent, RegionDoc, RegionShape, ScrollingTextEvent, UserDoc } from "../../../shared/protocol.ts";
import { REGION_VISIBILITY } from "../../../shared/protocol.ts";
import type { Point } from "../../../shared/geometry.ts";
import { onLevel } from "../../../shared/levels.ts";
import { regionContainsPoint, shapePolygon } from "../../../shared/regions.ts";
import { game } from "../game.ts";
import { h } from "../dom.ts";
import type { Board, Tool } from "./board.ts";
import { formatNumber } from "./board.ts";
import { openRegionConfig } from "../ui/region-config.ts";
import { closeWindow, openWindow } from "../ui/windows.ts";

export type RegionTool = "select" | "circle" | "cone" | "rectangle" | "line" | "region-rectangle" | "region-ellipse" | "region-polygon";

/** Foundry's default cone width. */
const CONE_ANGLE = 53.13;

/**
 * Regions and measured templates (Foundry v14 made templates a kind of region).
 * Templates: everyone; drag from the origin. Regions: GM; drag (rectangle/ellipse) or click points
 * (polygon, Enter/double-click to close); double-click a region to configure it and its behaviours.
 */
export class RegionsLayer implements Tool {
  tool: RegionTool = "select";
  #board: Board;
  #layer = new Container();
  #preview = new Graphics();
  #previewLabel = new Text({ text: "", style: { fill: 0xffffff, fontSize: 22, fontWeight: "700", fontFamily: "Signika, sans-serif", stroke: { color: 0x000000, width: 5 } } });
  #views = new Map<string, Container>();
  #selected: string | null = null;
  #draft: { from: Point; to: Point } | null = null;
  #polygon: number[] | null = null;
  #floating = new Container();

  constructor(board: Board) {
    this.#board = board;
    board.layers.glow.parent!.addChildAt(this.#layer, board.world.getChildIndex(board.layers.markers));
    board.layers.controls.addChild(this.#preview, this.#previewLabel, this.#floating);
    this.#preview.eventMode = "none";
    this.#previewLabel.anchor.set(0, 1);
    board.registerTool("regions", this);
    const redraw = () => this.redraw();
    board.on("scene", redraw);
    board.on("tool", redraw);
    game.on("Region", redraw);
    game.on("view", redraw);
    game.socket.on("scrollingText", (e: ScrollingTextEvent) => this.#scrollingText(e));
    game.socket.on("levelPrompt", (e: LevelPromptEvent) => levelPrompt(e));
    redraw();
  }

  #isTemplate(r: RegionDoc): boolean {
    return !!r.template;
  }

  #canEdit(r: RegionDoc): boolean {
    return game.isGM || r.template?.author === game.userId;
  }

  /** Which regions the local user sees right now. */
  #visible(r: RegionDoc): boolean {
    if (this.#isTemplate(r)) return true;
    if (!game.isGM) return r.visibility === REGION_VISIBILITY.ALWAYS && !r.hidden;
    return r.visibility !== REGION_VISIBILITY.LAYER || this.#board.tool === "regions";
  }

  redraw(): void {
    const scene = this.#board.scene;
    const regions = scene ? game.children<RegionDoc>("Region", scene._id).filter(r => onLevel(r, game.viewedLevelId) && this.#visible(r)) : [];
    const keep = new Set(regions.map(r => r._id));
    for (const [id, c] of this.#views) if (!keep.has(id)) { c.destroy({ children: true }); this.#views.delete(id); }
    const editing = this.#board.tool === "regions" && this.tool === "select";
    for (const r of regions) {
      let c = this.#views.get(r._id);
      if (!c) {
        c = new Container();
        c.on("pointerdown", e => this.#onDown(r._id, e));
        this.#layer.addChild(c);
        this.#views.set(r._id, c);
      }
      c.removeChildren().forEach(ch => ch.destroy());
      const g = new Graphics();
      const selected = editing && this.#selected === r._id;
      for (const s of r.shapes) {
        g.poly(shapePolygon(s)).fill({ color: r.color, alpha: this.#isTemplate(r) ? 0.22 : 0.15 })
          .stroke({ width: selected ? 5 : 3, color: selected ? 0xff9f1c : r.color, alpha: 0.9 });
      }
      c.addChild(g);
      const label = this.#label(r);
      if (label && r.shapes[0]) {
        const t = new Text({ text: label, style: { fill: 0xffffff, fontSize: 20, fontWeight: "700", fontFamily: "Signika, sans-serif", stroke: { color: 0x000000, width: 4 } } });
        const at = labelPoint(r.shapes[0]);
        t.anchor.set(0.5);
        t.position.set(at.x, at.y);
        c.addChild(t);
      }
      c.eventMode = editing && this.#canEdit(r) ? "static" : "none";
      c.cursor = "move";
      c.alpha = r.hidden ? 0.5 : 1;
    }
  }

  #label(r: RegionDoc): string {
    const s = r.shapes[0];
    if (!s) return "";
    if (!r.displayMeasurements && !this.#isTemplate(r)) return game.isGM && this.#board.tool === "regions" ? r.name : "";
    const u = (px: number) => `${formatNumber(Math.round((px / this.#board.pxPerUnit) * 10) / 10)} ${this.#board.scene?.grid.units ?? ""}`;
    switch (s.type) {
      case "circle": return u(s.radius);
      case "cone": return u(s.radius);
      case "line": return u(s.length);
      case "rectangle": return `${u(s.width)} × ${u(s.height)}`;
      default: return r.name;
    }
  }

  // -------------------------------------------------------------------------
  // Editing

  #onDown(id: string, e: FederatedPointerEvent): void {
    if (e.button !== 0) return;
    const r = game.get<RegionDoc>("Region", id);
    if (!r || !this.#canEdit(r)) return;
    e.stopPropagation();
    this.#selected = id;
    this.redraw();
    const start = this.#board.toWorld(e);
    const stage = this.#board.app.stage;
    const move = (ev: FederatedPointerEvent) => {
      const q = this.#board.toWorld(ev);
      this.#views.get(id)?.position.set(q.x - start.x, q.y - start.y);
    };
    const up = (ev: FederatedPointerEvent) => {
      stage.off("globalpointermove", move);
      stage.off("pointerup", up);
      stage.off("pointerupoutside", up);
      const q = this.#board.toWorld(ev);
      const dx = Math.round(q.x - start.x), dy = Math.round(q.y - start.y);
      this.#views.get(id)?.position.set(0, 0);
      if (dx || dy) game.update("Region", { _id: id, shapes: r.shapes.map(s => offset(s, dx, dy)) }, r._parent);
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
    this.#previewLabel.text = "";
  }

  down(p: Point, e: FederatedPointerEvent): boolean {
    if (this.tool === "select") {
      this.#selected = null;
      this.redraw();
      return false;
    }
    if (this.tool === "region-polygon") {
      if (!game.isGM) return false;
      const at = this.#board.snap(p, !e.shiftKey);
      this.#polygon = [...(this.#polygon ?? []), at.x, at.y];
      this.#drawPreview([{ type: "polygon", points: [...this.#polygon, at.x, at.y] }], "");
      return true;
    }
    if (this.tool.startsWith("region-") && !game.isGM) return false;
    // Templates start on grid centres/corners; regions too unless Shift.
    const from = this.#board.snap(p, !e.shiftKey);
    this.#draft = { from, to: from };
    return true;
  }

  move(p: Point, e: FederatedPointerEvent): void {
    if (this.#polygon) {
      const at = this.#board.snap(p, !e.shiftKey);
      this.#drawPreview([{ type: "polygon", points: [...this.#polygon, at.x, at.y] }], "");
      return;
    }
    if (!this.#draft) return;
    this.#draft.to = this.tool === "cone" || this.tool === "line" || this.tool === "circle" ? p : this.#board.snap(p, !e.shiftKey);
    const shape = this.#shapeFromDraft();
    if (shape) this.#drawPreview([shape], this.#measure(shape));
  }

  async up(): Promise<void> {
    const d = this.#draft;
    this.#draft = null;
    this.#preview.clear();
    this.#previewLabel.text = "";
    const scene = this.#board.scene;
    if (!d || !scene) return;
    const shape = this.#shapeFromDraft(d);
    if (!shape) return;
    const color = game.get<UserDoc>("User", game.userId)?.color ?? "#ff9f1c";
    const levels = game.viewedLevelId ? [game.viewedLevelId] : [];
    if (this.tool.startsWith("region-")) {
      const [created] = await game.create<RegionDoc>("Region", { name: "Região", shapes: [shape], levels }, scene._id);
      if (created) openRegionConfig(created._id, scene._id);
    } else {
      await game.create("Region", { name: "Modelo", color, shapes: [shape], levels, displayMeasurements: true, visibility: REGION_VISIBILITY.ALWAYS, template: { author: game.userId } }, scene._id);
    }
  }

  #shapeFromDraft(d = this.#draft): RegionShape | null {
    if (!d) return null;
    const { from, to } = d;
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const size = this.#board.scene?.grid.size ?? 100;
    switch (this.tool) {
      case "circle": return dist < 5 ? null : { type: "circle", x: from.x, y: from.y, radius: snapDistance(dist, size) };
      case "cone": return dist < 5 ? null : { type: "cone", x: from.x, y: from.y, radius: snapDistance(dist, size), angle: CONE_ANGLE, rotation: angle };
      case "line": return dist < 5 ? null : { type: "line", x: from.x, y: from.y, length: snapDistance(dist, size), width: size, rotation: angle };
      case "rectangle":
      case "region-rectangle":
        return Math.abs(dx) < 5 || Math.abs(dy) < 5 ? null : { type: "rectangle", x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(dx), height: Math.abs(dy) };
      case "region-ellipse":
        return Math.abs(dx) < 5 || Math.abs(dy) < 5 ? null : { type: "ellipse", x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, radiusX: Math.abs(dx) / 2, radiusY: Math.abs(dy) / 2 };
      default: return null;
    }
  }

  #measure(s: RegionShape): string {
    const u = (px: number) => `${formatNumber(Math.round((px / this.#board.pxPerUnit) * 10) / 10)} ${this.#board.scene?.grid.units ?? ""}`;
    if (s.type === "circle" || s.type === "cone") return u(s.radius);
    if (s.type === "line") return u(s.length);
    if (s.type === "rectangle") return `${u(s.width)} × ${u(s.height)}`;
    return "";
  }

  #drawPreview(shapes: RegionShape[], label: string): void {
    const color = game.get<UserDoc>("User", game.userId)?.color ?? "#ff9f1c";
    this.#preview.clear();
    for (const s of shapes) this.#preview.poly(shapePolygon(s)).fill({ color, alpha: 0.2 }).stroke({ width: 3, color });
    this.#previewLabel.text = label;
    const d = this.#draft;
    if (d) this.#previewLabel.position.set(d.to.x + 12, d.to.y - 12);
  }

  async #finishPolygon(): Promise<void> {
    const pts = this.#polygon;
    this.#polygon = null;
    this.#preview.clear();
    const scene = this.#board.scene;
    if (!pts || pts.length < 6 || !scene) return;
    const [created] = await game.create<RegionDoc>("Region", { name: "Região", shapes: [{ type: "polygon", points: pts }], levels: game.viewedLevelId ? [game.viewedLevelId] : [] }, scene._id);
    if (created) openRegionConfig(created._id, scene._id);
  }

  key(e: KeyboardEvent): boolean {
    if (this.#board.tool !== "regions") return false;
    if (this.#polygon && (e.key === "Enter" || e.key === "Escape")) {
      if (e.key === "Enter") this.#finishPolygon();
      else { this.#polygon = null; this.#preview.clear(); }
      return true;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.#selected) {
      const r = game.get<RegionDoc>("Region", this.#selected);
      if (r) game.delete("Region", r._id, r._parent);
      this.#selected = null;
      return true;
    }
    return false;
  }

  dblclick(p: Point): boolean {
    if (this.#board.tool !== "regions") return false;
    if (this.#polygon) {
      this.#finishPolygon();
      return true;
    }
    if (!game.isGM) return false;
    const scene = this.#board.scene;
    const hit = scene && game.children<RegionDoc>("Region", scene._id).find(r => !r.template && regionContainsPoint(r, p) && onLevel(r, game.viewedLevelId));
    if (!hit) return false;
    openRegionConfig(hit._id, hit._parent!);
    return true;
  }

  /** Remove the local user's templates (GM: all templates) on this scene. */
  clearTemplates(): void {
    const scene = this.#board.scene;
    if (!scene) return;
    const ids = game.children<RegionDoc>("Region", scene._id).filter(r => r.template && (game.isGM || r.template.author === game.userId)).map(r => r._id);
    if (ids.length) game.delete("Region", ids, scene._id);
  }

  #scrollingText(e: ScrollingTextEvent): void {
    if (e.sceneId !== game.viewedSceneId) return;
    const t = new Text({ text: e.text, style: { fill: e.color, fontSize: 28, fontWeight: "700", fontFamily: "Signika, sans-serif", stroke: { color: 0x000000, width: 5 } } });
    t.anchor.set(0.5, 1);
    t.position.set(e.x, e.y);
    this.#floating.addChild(t);
    const start = performance.now();
    const tick = () => {
      const k = (performance.now() - start) / 2500;
      if (k >= 1) {
        this.#board.app.ticker.remove(tick);
        t.destroy();
        return;
      }
      t.y = e.y - k * 60;
      t.alpha = 1 - Math.max(0, k - 0.6) / 0.4;
    };
    this.#board.app.ticker.add(tick);
  }
}

function snapDistance(px: number, size: number): number {
  // Templates grow in half-square steps, like measuring on the grid.
  return Math.max(size / 2, Math.round(px / (size / 2)) * (size / 2));
}

function offset(s: RegionShape, dx: number, dy: number): RegionShape {
  if (s.type === "polygon") return { ...s, points: s.points.map((n, i) => n + (i % 2 ? dy : dx)) };
  return { ...s, x: s.x + dx, y: s.y + dy };
}

function labelPoint(s: RegionShape): Point {
  switch (s.type) {
    case "rectangle": return { x: s.x + s.width / 2, y: s.y + s.height / 2 };
    case "polygon": {
      const xs = s.points.filter((_, i) => i % 2 === 0), ys = s.points.filter((_, i) => i % 2 === 1);
      return { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length };
    }
    case "cone":
    case "line": {
      const r = ((s.rotation ?? 0) * Math.PI) / 180, len = s.type === "cone" ? s.radius * 0.6 : s.length / 2;
      return { x: s.x + Math.cos(r) * len, y: s.y + Math.sin(r) * len };
    }
    default: return { x: s.x, y: s.y };
  }
}

/** Ask the player which floor to go to after stepping on stairs (a "change level" region). */
function levelPrompt(e: LevelPromptEvent): void {
  const key = `level-prompt-${e.tokenId}`;
  const body = openWindow(key, e.regionName || "Mudar de nível", { width: 300 });
  if (!body) return;
  const levels = e.levels.map(id => game.get<LevelDoc>("Level", id)).filter((l): l is LevelDoc => !!l);
  body.append(h("div.stack", null,
    h("p", null, "Para onde vais?"),
    ...levels.map(l => h("button.primary", {
      onclick: async () => {
        await game.update("Token", { _id: e.tokenId, level: l._id }, e.sceneId).catch(() => {});
        if (e.sceneId === game.viewedSceneId) game.viewLevel(l._id);
        closeWindow(key);
      }
    }, l.name)),
    h("button", { onclick: () => closeWindow(key) }, "Ficar aqui")
  ));
}
