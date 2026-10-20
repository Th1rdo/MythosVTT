import type { ActorDoc } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import type { Board } from "../canvas/board.ts";
import { registerKey, startKeybindings } from "../keybindings.ts";
import { openSheet } from "../ui/sheet.ts";
import { closeMainMenu, toggleMainMenu } from "./main-menu.ts";

/**
 * The core keyboard shortcuts (Foundry's set, where Mesa has the feature). Defaults follow Foundry;
 * everything editable can be rebound in Definições → Teclas.
 */
export function registerCoreKeys(board: Board): void {
  registerKey({
    id: "core.dismiss", name: "Fechar / largar a seleção", category: "Geral", bindings: [], fixed: [{ key: "Escape" }], precedence: 10,
    onDown: () => {
      // The newest window first, then the selection.
      if (closeMainMenu()) return true;
      const wins = [...document.querySelectorAll<HTMLElement>("#windows .win")];
      const top = wins.sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0];
      if (top) {
        top.querySelector<HTMLButtonElement>(".win-head button")?.click();
        return true;
      }
      if (board.deselect()) return true;
      // Nothing else to close: the main menu.
      toggleMainMenu();
      return true;
    }
  });
  registerKey({ id: "core.delete", name: "Apagar o selecionado", category: "Mapa", bindings: [{ key: "Backspace" }], fixed: [{ key: "Delete" }], onDown: () => board.deleteSelected() });
  registerKey({ id: "core.selectAll", name: "Selecionar todos os teus tokens", category: "Mapa", bindings: [], fixed: [{ key: "KeyA", modifiers: ["Control"] }], onDown: () => board.selectAll() });
  registerKey({ id: "core.toggleHidden", name: "Esconder / mostrar tokens", category: "Mapa", gm: true, bindings: [{ key: "KeyH" }], onDown: () => board.toggleHidden() });
  registerKey({ id: "core.toggleCombat", name: "Pôr / tirar do combate", category: "Combate", bindings: [{ key: "KeyC" }], onDown: () => board.toggleCombatSelected() });
  // Same key as combat in Foundry's defaults: with tokens selected C is combat, otherwise your sheet.
  registerKey({
    id: "core.characterSheet", name: "Abrir a ficha da tua personagem", category: "Geral", bindings: [{ key: "KeyC" }], precedence: 5,
    onDown: () => {
      const actor = game.get<ActorDoc>("Actor", game.user.character);
      if (!actor) {
        toast("Não tens personagem atribuída (o mestre escolhe-a em Definições → Jogadores).");
        return true;
      }
      openSheet(actor._id);
      return true;
    }
  });
  const move = (id: string, name: string, cx: number, cy: number, keys: string[], arrows: string[]) => registerKey({
    id, name, category: "Mover tokens", repeat: true, allow: ["Shift"],
    bindings: keys.map(key => ({ key })), fixed: arrows.map(key => ({ key })),
    onDown: () => board.moveSelected(cx, cy)
  });
  move("core.moveUp", "Mover para cima", 0, -1, ["KeyW", "Numpad8"], ["ArrowUp"]);
  move("core.moveDown", "Mover para baixo", 0, 1, ["KeyS", "Numpad2"], ["ArrowDown"]);
  move("core.moveLeft", "Mover para a esquerda", -1, 0, ["KeyA", "Numpad4"], ["ArrowLeft"]);
  move("core.moveRight", "Mover para a direita", 1, 0, ["KeyD", "Numpad6"], ["ArrowRight"]);
  move("core.moveUpLeft", "Mover na diagonal ↖", -1, -1, ["Numpad7"], []);
  move("core.moveUpRight", "Mover na diagonal ↗", 1, -1, ["Numpad9"], []);
  move("core.moveDownLeft", "Mover na diagonal ↙", -1, 1, ["Numpad1"], []);
  move("core.moveDownRight", "Mover na diagonal ↘", 1, 1, ["Numpad3"], []);
  registerKey({ id: "core.zoomIn", name: "Aproximar", category: "Vista", repeat: true, bindings: [{ key: "PageUp" }, { key: "Equal" }], onDown: () => board.zoomBy(1.15) });
  registerKey({ id: "core.zoomOut", name: "Afastar", category: "Vista", repeat: true, bindings: [{ key: "PageDown" }, { key: "Minus" }], onDown: () => board.zoomBy(1 / 1.15) });
  registerKey({
    id: "core.focusChat", name: "Escrever no chat", category: "Geral", bindings: [{ key: "Enter" }], precedence: 20,
    onDown: () => {
      const input = [...document.querySelectorAll<HTMLTextAreaElement>(".chat-input")].find(el => el.offsetParent !== null);
      if (!input) return false;
      input.focus();
      return true;
    }
  });
  startKeybindings();
}
