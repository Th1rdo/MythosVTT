import { Container, Graphics, Text } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type { JournalEntryDoc, NoteDoc } from "../../../shared/protocol.ts";
import type { Point } from "../../../shared/geometry.ts";
import { onLevel } from "../../../shared/levels.ts";
import { game, toast } from "../game.ts";
import type { Board, Tool } from "./board.ts";
import type { Perception } from "./perception.ts";
import { openNoteConfig } from "../ui/canvas-config.ts";
import { openJournal } from "../ui/journal.ts";

/**
 * Map notes: pins linked to journal entries. Players see a pin when they can see its entry and the
 * spot is in view (or the note is global). Double-click opens the entry; the GM edits pins in the
 * notes tool (drag, Del, double-click to configure) and creates them by dropping a journal entry
 * from the sidebar onto the map.
 */
export class NotesLayer implements Tool {
  #board: Board;
  #perception: Perception;
  #layer = new Container();
  #views = new Map<string, Container>();
  #selected: string | null = null;

  constructor(board: Board, perception: Perception) {
    this.#board = board;
    this.#perception = perception;
    board.layers.doors.addChild(this.#layer);
    board.registerTool("notes", this);
    const redraw = () => this.redraw();
    board.on("scene", redraw);
    board.on("tool", redraw);
    game.on("Note", redraw);
    game.on("JournalEntry", redraw);
    game.on("view", redraw);
    board.on("frame", () => this.#visibility());
    board.on("tokens", () => this.#visibility());
    board.app.canvas.addEventListener("drop", e => this.#onDrop(e));
    redraw();
  }

  redraw(): void {
    const scene = this.#board.scene;
    const notes = scene ? game.children<NoteDoc>("Note", scene._id).filter(n => onLevel(n, game.viewedLevelId)) : [];
    const keep = new Set(notes.map(n => n._id));
    for (const [id, c] of this.#views) if (!keep.has(id)) { c.destroy({ children: true }); this.#views.delete(id); }
    for (const n of notes) {
      let c = this.#views.get(n._id);
      if (!c) {
        c = new Container();
        c.eventMode = "static";
        c.cursor = "pointer";
        c.on("pointerdown", e => this.#onDown(n._id, e));
        this.#layer.addChild(c);
        this.#views.set(n._id, c);
      }
      c.removeChildren().forEach(ch => ch.destroy());
      const entry = game.get<JournalEntryDoc>("JournalEntry", n.entryId);
      const r = n.iconSize / 2;
      const selected = this.#selected === n._id && this.#board.tool === "notes";
      c.addChild(new Graphics().circle(0, 0, r).fill({ color: 0x14141a, alpha: 0.9 }).stroke({ width: selected ? 4 : 2, color: selected ? 0xff9f1c : 0xefe6d8 }));
      const icon = new Text({ text: n.icon || "📌", style: { fontSize: r * 1.1 } });
      icon.anchor.set(0.5);
      c.addChild(icon);
      const label = n.text || entry?.name || "";
      if (label) {
        const t = new Text({ text: label, style: { fill: n.textColor, fontSize: n.fontSize, fontFamily: "Signika, sans-serif", fontWeight: "600", stroke: { color: 0x000000, width: 4 } } });
        t.anchor.set(0.5, 0);
        t.position.set(0, r + 4);
        c.addChild(t);
      }
      c.position.set(n.x, n.y);
    }
    this.#visibility();
  }

  #visibility(): void {
    for (const [id, c] of this.#views) {
      const n = game.get<NoteDoc>("Note", id);
      c.visible = !!n && (game.isGM || n.global || this.#perception.canSee({ x: n.x, y: n.y }));
    }
  }

  #onDown(id: string, e: FederatedPointerEvent): void {
    if (e.button !== 0) return;
    const n = game.get<NoteDoc>("Note", id);
    if (!n) return;
    e.stopPropagation();
    if (e.detail >= 2 || this.#board.tool !== "notes" || !game.isGM) {
      // Double-click (or any click outside the GM's notes tool) opens the entry.
      if (e.detail >= 2 || this.#board.tool !== "notes") {
        if (n.entryId && game.get("JournalEntry", n.entryId)) openJournal(n.entryId, { pageId: n.pageId });
        else if (game.isGM) openNoteConfig(id, n._parent!);
      }
      return;
    }
    this.#selected = id;
    this.redraw();
    const p = this.#board.toWorld(e);
    const off = { x: p.x - n.x, y: p.y - n.y };
    const stage = this.#board.app.stage;
    const move = (ev: FederatedPointerEvent) => {
      const q = this.#board.toWorld(ev);
      this.#views.get(id)?.position.set(q.x - off.x, q.y - off.y);
    };
    const up = (ev: FederatedPointerEvent) => {
      stage.off("globalpointermove", move);
      stage.off("pointerup", up);
      stage.off("pointerupoutside", up);
      const q = this.#board.snap({ x: this.#board.toWorld(ev).x - off.x, y: this.#board.toWorld(ev).y - off.y }, !ev.shiftKey);
      if (q.x !== n.x || q.y !== n.y) game.update("Note", { _id: id, x: q.x, y: q.y }, n._parent);
    };
    stage.on("globalpointermove", move);
    stage.on("pointerup", up);
    stage.on("pointerupoutside", up);
  }

  async #onDrop(e: DragEvent): Promise<void> {
    const raw = e.dataTransfer?.getData("application/x-mesa-doc");
    if (!raw) return;
    const { type, id } = JSON.parse(raw) as { type: string; id: string };
    if (type !== "JournalEntry") return;
    e.preventDefault();
    const scene = this.#board.scene;
    if (!scene) return;
    if (!game.isGM) return toast("Só o mestre pode pôr notas no mapa");
    const p = this.#board.snap(this.#board.eventToWorld(e));
    await game.create("Note", { entryId: id, x: p.x, y: p.y, levels: game.viewedLevelId ? [game.viewedLevelId] : [] }, scene._id);
  }

  deactivate(): void {
    this.#selected = null;
  }

  down(): boolean {
    this.#selected = null;
    this.redraw();
    return false;
  }

  key(e: KeyboardEvent): boolean {
    if (this.#board.tool !== "notes" || !this.#selected) return false;
    if (e.key === "Delete" || e.key === "Backspace") {
      const n = game.get<NoteDoc>("Note", this.#selected);
      if (n) game.delete("Note", n._id, n._parent);
      this.#selected = null;
      return true;
    }
    return false;
  }

  dblclick(_p: Point): boolean {
    return false;
  }
}
