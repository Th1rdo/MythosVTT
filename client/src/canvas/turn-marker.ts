import { Graphics } from "pixi.js";
import type { CombatantDoc } from "../../../shared/protocol.ts";
import { game } from "../game.ts";
import { viewedCombat } from "../ui/combat.ts";
import type { Board } from "./board.ts";

/** Pulsing ring under the token whose turn it is in the viewed scene's encounter. */
export class TurnMarker {
  #board: Board;
  #ring = new Graphics();
  #time = 0;

  constructor(board: Board) {
    this.#board = board;
    board.layers.markers.addChild(this.#ring);
    board.app.ticker.add(t => this.#tick(t.deltaMS));
  }

  #tick(dt: number): void {
    this.#time += dt / 1000;
    const combat = viewedCombat();
    const current = combat?.round ? game.get<CombatantDoc>("Combatant", combat.current) : undefined;
    const view = current?.tokenId ? this.#board.tokens.get(current.tokenId) : undefined;
    const scene = this.#board.scene;
    this.#ring.clear();
    if (!view || !view.root.visible || !scene) return;
    const c = this.#board.tokenCenter(view);
    const r = (Math.max(view.doc.width, view.doc.height) * scene.grid.size) / 2;
    const pulse = 0.5 + 0.5 * Math.sin(this.#time * 3);
    this.#ring.circle(c.x, c.y, r * (1.08 + pulse * 0.08)).stroke({ width: r * 0.12, color: 0xff9f1c, alpha: 0.5 + pulse * 0.4 });
    this.#ring.circle(c.x, c.y, r * 0.98).fill({ color: 0xff9f1c, alpha: 0.12 });
  }
}
