import { game } from "../game.ts";
import { h } from "../dom.ts";
import { settings } from "../settings.ts";
import { registerKey } from "../keybindings.ts";
import type { Board } from "../canvas/board.ts";

export const isPaused = () => !!settings.get("core.paused");

/** GM: pause or resume for everyone. */
export function togglePause(): void {
  if (game.isGM) settings.set("core.paused", !isPaused());
}

/**
 * The pause banner (bottom centre, above the hotbar). While paused, players can't move tokens — the
 * server refuses — and see the banner; the GM toggles with Space (released without dragging the view).
 */
export function pauseBanner(board: Board): HTMLElement {
  const el = h("div#pause", { hidden: true },
    h("i.fa-solid.fa-circle-pause"),
    h("span", null, "Jogo em pausa"),
    game.isGM ? h("button.small", { onclick: togglePause }, "Retomar") : null);
  const sync = () => (el.hidden = !isPaused());
  settings.onChange("core.paused", sync);
  game.on("ready", sync);
  sync();
  registerKey({
    id: "core.pause", name: "Pausar / retomar o jogo", category: "Geral", gm: true, bindings: [{ key: "Space" }], precedence: 30,
    // Space also pans the view while held: toggle only on a release without a drag.
    onDown: () => true,
    onUp: () => {
      if (!board.spacePanned) togglePause();
    }
  });
  return el;
}
