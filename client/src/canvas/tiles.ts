import { Container, Graphics, Sprite } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type { TileDoc } from "../../../shared/protocol.ts";
import type { Point } from "../../../shared/geometry.ts";
import { onLevel } from "../../../shared/levels.ts";
import { game, toast } from "../game.ts";
import { imageSize } from "../dom.ts";
import { browseFiles } from "../ui/file-picker.ts";
import type { Board, Tool } from "./board.ts";
import { loadTexture } from "./board.ts";
import { openTileConfig } from "../ui/canvas-config.ts";

interface TileView {
  root: Container;
  sprite: Sprite | null;
  frame: Graphics;
  doc: TileDoc;
  key: string;
}

/**
 * Tiles: images placed on the scene. Background tiles draw under tokens; foreground tiles (roofs,
 * canopies) draw over them and fade while a token the viewer controls stands underneath.
 * GM tools: select/move (drag, snap; Shift = free), place (pick an image, click to drop it at its
 * natural size), Delete, double-click to configure.
 */
export class TilesLayer implements Tool {
  /** "select" moves/edits; "place" drops `pending` where the user clicks. */
  mode: "select" | "place" = "select";
  #board: Board;
  #below = new Container();
  #above = new Container();
  #views = new Map<string, TileView>();
  #selected: string | null = null;
  #drag: { id: string; dx: number; dy: number } | null = null;
  #pending: { src: string; width: number; height: number } | null = null;

  constructor(board: Board) {
    this.#board = board;
    board.layers.tiles.addChild(this.#below);
    board.layers.foreground.addChild(this.#above);
    board.registerTool("tiles", this);
    const redraw = () => this.redraw();
    board.on("scene", redraw);
    board.on("tool", redraw);
    game.on("Tile", redraw);
    game.on("view", redraw);
    board.on("frame", () => this.#occlusion());
    board.on("tokens", () => this.#occlusion());
    board.on("selection", () => this.#occlusion());
    redraw();
  }

  get #tiles(): TileDoc[] {
    const scene = this.#board.scene;
    if (!scene) return [];
    return game.children<TileDoc>("Tile", scene._id).filter(t => onLevel(t, game.viewedLevelId)).sort((a, b) => a.elevation - b.elevation || a.sort - b.sort);
  }

  redraw(): void {
    const tiles = this.#tiles;
    const keep = new Set(tiles.map(t => t._id));
    for (const [id, v] of this.#views) {
      if (!keep.has(id)) {
        v.root.destroy({ children: true });
        this.#views.delete(id);
      }
    }
    const editing = this.#board.tool === "tiles" && game.isGM;
    for (const t of tiles) {
      let v = this.#views.get(t._id);
      if (!v) {
        const root = new Container();
        root.on("pointerdown", e => this.#onTileDown(t._id, e));
        v = { root, sprite: null, frame: new Graphics(), doc: t, key: "" };
        root.addChild(v.frame);
        this.#views.set(t._id, v);
      }
      v.doc = t;
      (t.foreground ? this.#above : this.#below).addChild(v.root);
      v.root.eventMode = editing ? "static" : "none";
      v.root.cursor = editing ? "move" : "default";
      v.root.position.set(t.x + t.width / 2, t.y + t.height / 2);
      v.root.pivot.set(t.width / 2, t.height / 2);
      v.root.angle = t.rotation;
      v.root.alpha = t.hidden ? 0.5 * t.alpha : t.alpha;
      const key = `${t.img}|${t.width}|${t.height}`;
      if (v.key !== key) {
        v.key = key;
        v.sprite?.destroy();
        v.sprite = null;
        if (t.img) {
          const view = v;
          loadTexture(t.img).then(tex => {
            if (!tex || view.key !== key || !this.#views.has(t._id)) return;
            const sprite = new Sprite(tex);
            sprite.width = t.width;
            sprite.height = t.height;
            view.sprite = sprite;
            view.root.addChildAt(sprite, 0);
          });
        }
      }
      v.frame.clear();
      if (editing) {
        const sel = this.#selected === t._id;
        v.frame.rect(0, 0, t.width, t.height).stroke({ width: sel ? 4 : 2, color: sel ? 0xff9f1c : t.foreground ? 0x4fd3e8 : 0xffffff, alpha: sel ? 1 : 0.5 });
      }
    }
    this.#occlusion();
  }

  /** Foreground tiles fade while a token the viewer controls (or observes) is under them. */
  #occlusion(): void {
    const viewers = this.#board.selected.length ? this.#board.selected : [...this.#board.tokens.values()].filter(v => this.#board.isObserver(v.doc) && !game.isGM);
    for (const v of this.#views.values()) {
      const t = v.doc;
      if (!t.foreground || !t.occlusion.fade) continue;
      const covered = viewers.some(tok => {
        const c = this.#board.tokenCenter(tok);
        return c.x >= t.x && c.x <= t.x + t.width && c.y >= t.y && c.y <= t.y + t.height;
      });
      const base = t.hidden ? 0.5 * t.alpha : t.alpha;
      v.root.alpha = covered ? Math.min(base, t.occlusion.alpha) : base;
    }
  }

  // -------------------------------------------------------------------------
  // Tool

  /** Ask for an image; the next click places it. */
  async startPlacing(): Promise<void> {
    const src = await browseFiles("imagevideo");
    if (!src) return;
    try {
      const size = await imageSize(src).catch(() => ({ width: 200, height: 200 }));
      this.#pending = { src, ...size };
      this.mode = "place";
      toast("Clica no mapa para pôr o tile");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  deactivate(): void {
    this.#selected = null;
    this.#pending = null;
    this.mode = "select";
  }

  #onTileDown(id: string, e: FederatedPointerEvent): void {
    if (e.button !== 0 || this.mode === "place") return;
    e.stopPropagation();
    const t = game.get<TileDoc>("Tile", id);
    if (!t) return;
    this.#selected = id;
    this.redraw();
    if (t.locked) return;
    const p = this.#board.toWorld(e);
    this.#drag = { id, dx: p.x - t.x, dy: p.y - t.y };
    const stage = this.#board.app.stage;
    const move = (ev: FederatedPointerEvent) => {
      const q = this.#board.toWorld(ev);
      const v = this.#views.get(id);
      if (v && this.#drag) v.root.position.set(q.x - this.#drag.dx + t.width / 2, q.y - this.#drag.dy + t.height / 2);
    };
    const up = (ev: FederatedPointerEvent) => {
      stage.off("globalpointermove", move);
      stage.off("pointerup", up);
      stage.off("pointerupoutside", up);
      const d = this.#drag;
      this.#drag = null;
      if (!d) return;
      const q = this.#board.toWorld(ev);
      const at = this.#board.snap({ x: q.x - d.dx, y: q.y - d.dy }, !ev.shiftKey);
      if (at.x !== t.x || at.y !== t.y) game.update("Tile", { _id: id, x: at.x, y: at.y }, t._parent);
      else this.redraw();
    };
    stage.on("globalpointermove", move);
    stage.on("pointerup", up);
    stage.on("pointerupoutside", up);
  }

  down(p: Point, e: FederatedPointerEvent): boolean {
    if (!game.isGM) return false;
    if (this.mode === "place" && this.#pending) {
      const scene = this.#board.scene;
      if (!scene) return true;
      const { src, width, height } = this.#pending;
      const at = this.#board.snap({ x: p.x - width / 2, y: p.y - height / 2 }, !e.shiftKey);
      const maxSort = Math.max(0, ...game.children<TileDoc>("Tile", scene._id).map(t => t.sort));
      game.create("Tile", {
        img: src, x: at.x, y: at.y, width, height, sort: maxSort + 1,
        levels: game.viewedLevelId ? [game.viewedLevelId] : []
      }, scene._id);
      this.#pending = null;
      this.mode = "select";
      return true;
    }
    this.#selected = null;
    this.redraw();
    return false;
  }

  /** Delete the selected tile (the "delete" shortcut). */
  delete(): boolean {
    const t = this.#selected ? game.get<TileDoc>("Tile", this.#selected) : undefined;
    if (!t) return false;
    game.delete("Tile", t._id, t._parent);
    this.#selected = null;
    return true;
  }

  key(e: KeyboardEvent): boolean {
    if (this.#board.tool !== "tiles" || !this.#selected) return false;
    const t = game.get<TileDoc>("Tile", this.#selected);
    if (!t) return false;
    if (e.key === "Escape") {
      this.#selected = null;
      this.redraw();
      return true;
    }
    return false;
  }

  dblclick(p: Point): boolean {
    if (!game.isGM || this.#board.tool !== "tiles") return false;
    const hit = [...this.#tiles].reverse().find(t => p.x >= t.x && p.x <= t.x + t.width && p.y >= t.y && p.y <= t.y + t.height);
    if (!hit) return false;
    openTileConfig(hit._id, hit._parent!);
    return true;
  }
}
