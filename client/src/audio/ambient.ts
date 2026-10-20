import type { AmbientSoundDoc, SoundEffectType, TokenDoc, WallDoc } from "../../../shared/protocol.ts";
import type { Point } from "../../../shared/geometry.ts";
import { movementBlocked, pointInPolygon, visibilityPolygon, wallEdges } from "../../../shared/geometry.ts";
import { distanceVolume, soundActive } from "../../../shared/audio.ts";
import type { Listener } from "../../../shared/audio.ts";
import { onLevel, tokenOnLevel, defaultLevel } from "../../../shared/levels.ts";
import { game } from "../game.ts";
import type { Board } from "../canvas/board.ts";
import { audio, Track } from "./engine.ts";

interface Heard {
  volume: number;
  muffled: boolean;
  sound: AmbientSoundDoc;
}

interface Playing {
  track: Track;
  /** One-shot sounds play once each time they become audible. */
  finished: boolean;
}

/**
 * Ambient sounds of the viewed scene, heard from the listener positions: the tokens you control, or —
 * for players with nothing selected — every token you own. With nothing to listen from, GMs hear
 * nothing (as in Foundry); on the sounds tool the mouse pointer previews what a token would hear.
 *
 * Several sounds with the same file play as one, at the loudest volume any listener hears.
 * Sounds constrained by walls are silent behind sound-blocking walls; unconstrained ones are muffled.
 */
export class AmbientPlayer {
  #board: Board;
  #playing = new Map<string, Playing>();
  #pending = false;
  #preview: Point | null = null;
  /** What was heard at the last refresh: path → volume and muffling (for debugging). */
  lastHeard: Record<string, { volume: number; muffled: boolean }> = {};

  constructor(board: Board) {
    this.#board = board;
    const refresh = () => this.refresh();
    for (const e of ["scene", "tokens", "selection", "frame"] as const) board.on(e, refresh);
    for (const t of ["AmbientSound", "Wall", "Scene", "Token", "Level"] as const) game.on(t, refresh);
    game.on("view", refresh);
    refresh();
  }

  /** Listen from a point instead of tokens (GM previewing on the sounds tool); null ends it. */
  preview(p: Point | null): void {
    this.#preview = p;
    this.refresh();
  }

  refresh(): void {
    if (this.#pending) return;
    this.#pending = true;
    requestAnimationFrame(() => {
      this.#pending = false;
      if (audio.locked) return audio.whenReady(() => this.refresh());
      this.#apply(this.#compute());
    });
  }

  #listeners(): Listener[] {
    const scene = this.#board.scene;
    if (!scene) return [];
    if (this.#preview) return [{ ...this.#preview, elevation: game.viewedLevel?.elevation.bottom ?? 0 }];
    const half = scene.grid.size / 2;
    const at = (t: TokenDoc): Listener => ({ x: t.x + t.width * half, y: t.y + t.height * half, elevation: t.elevation ?? 0 });
    const selected = this.#board.selected.map(v => v.doc);
    if (selected.length) return selected.map(at);
    if (game.isGM) return [];
    const fallback = defaultLevel(scene, game)?._id ?? null;
    return game.children<TokenDoc>("Token", scene._id)
      .filter(t => !t.hidden && tokenOnLevel(t, game.viewedLevelId, fallback) && game.owns(game.get("Actor", t.actorId)))
      .map(at);
  }

  #compute(): Map<string, Heard> {
    const heard = new Map<string, Heard>();
    const scene = this.#board.scene;
    if (!scene) return heard;
    const listeners = this.#listeners();
    if (!listeners.length) return heard;
    const level = game.viewedLevelId;
    const sounds = game.children<AmbientSoundDoc>("AmbientSound", scene._id)
      .filter(s => onLevel(s, level) && soundActive(s, scene.environment.darkness));
    if (!sounds.length) return heard;
    const edges = wallEdges(game.children<WallDoc>("Wall", scene._id).filter(w => onLevel(w, level)), "sound");
    const bounds = { x: 0, y: 0, width: scene.width, height: scene.height };
    const ppu = this.#board.pxPerUnit;

    for (const s of sounds) {
      const reach = s.walls ? visibilityPolygon({ x: s.x, y: s.y }, edges, bounds, { radius: s.radius * ppu }) : null;
      for (const l of listeners) {
        let v = s.volume * distanceVolume(s, l, ppu);
        if (v <= 0) continue;
        if (reach && !pointInPolygon(l, reach)) continue;
        const muffled = !reach && movementBlocked(l, { x: s.x, y: s.y }, edges);
        const best = heard.get(s.path!);
        if (!best || v > best.volume) heard.set(s.path!, { volume: v, muffled, sound: s });
      }
    }
    return heard;
  }

  #apply(heard: Map<string, Heard>): void {
    this.lastHeard = Object.fromEntries([...heard].map(([path, h]) => [path, { volume: Math.round(h.volume * 1000) / 1000, muffled: h.muffled }]));
    for (const [path, p] of this.#playing) {
      if (heard.has(path)) continue;
      p.track.stop(250);
      this.#playing.delete(path);
    }
    for (const [path, h] of heard) {
      let p = this.#playing.get(path);
      if (!p) {
        const track = new Track(audio, path, "environment");
        p = { track, finished: false };
        const entry = p;
        track.onEnded = () => (entry.finished = true);
        this.#playing.set(path, p);
        track.play({ offset: 0, volume: 0, loop: h.sound.repeat });
      }
      if (p.finished) continue;
      p.track.el.loop = h.sound.repeat;
      const fx = h.muffled && h.sound.effects?.muffled?.type ? h.sound.effects.muffled : h.sound.effects?.base;
      p.track.setEffect((fx?.type ?? null) as SoundEffectType | null, fx?.intensity ?? 5);
      p.track.fade(h.volume, 250);
    }
  }
}
