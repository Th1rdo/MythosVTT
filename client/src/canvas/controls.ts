import { game, toast } from "../game.ts";
import { h } from "../dom.ts";
import type { Board, ToolName } from "./board.ts";
import type { WallPreset, WallsLayer } from "./walls.ts";
import { WALL_PRESETS } from "./walls.ts";
import { confirmDialog } from "../ui/windows.ts";

const TOOLS: { name: ToolName; icon: string; label: string; gm: boolean; hint: string }[] = [
  { name: "tokens", icon: "♟", label: "Tokens", gm: false, hint: "Clicar/arrastar caixa: selecionar (Shift soma) · Botão direito: HUD do token · Arrastar com botão direito ou Espaço: deslocar · C: combate · Duplo clique: ficha / ping" },
  { name: "ruler", icon: "📏", label: "Régua", gm: false, hint: "Arrastar para medir · Espaço: ponto intermédio" },
  { name: "walls", icon: "🧱", label: "Paredes", gm: true, hint: "Arrastar: nova parede · Ctrl ao largar: encadear · Esc: parar · Shift: sem grelha · Duplo clique: configurar · Del: apagar" },
  { name: "lights", icon: "💡", label: "Luzes", gm: true, hint: "Arrastar: nova luz (raio) · Arrastar ícone: mover · Botão direito: ligar/desligar · Duplo clique: configurar" }
];

/** Left-hand toolbar over the canvas (like Foundry's scene controls). */
export function sceneControls(board: Board, walls: WallsLayer, hint: HTMLElement): HTMLElement {
  const bar = h("div.scene-controls");
  const sub = h("div.scene-subcontrols");

  const render = () => {
    const tools = TOOLS.filter(t => !t.gm || game.isGM);
    bar.replaceChildren(...tools.map(t => h("button", {
      className: board.tool === t.name ? "tool active" : "tool",
      title: t.label,
      onclick: () => board.setTool(t.name)
    }, t.icon)));
    hint.textContent = TOOLS.find(t => t.name === board.tool)?.hint ?? "";

    sub.replaceChildren();
    if (board.tool === "walls") {
      sub.append(...(Object.entries(WALL_PRESETS) as [WallPreset, (typeof WALL_PRESETS)[WallPreset]][]).map(([key, p]) => h("button", {
        className: walls.preset === key ? "sub active" : "sub",
        onclick: () => {
          walls.preset = key;
          render();
        }
      }, p.label)));
    }
    if (game.isGM && (board.tool === "walls" || board.tool === "lights")) {
      sub.append(h("button.sub.danger", {
        title: "Apagar a exploração de todos os jogadores nesta cena",
        onclick: async () => {
          const sceneId = board.scene?._id;
          if (!sceneId || !(await confirmDialog("Repor o nevoeiro de guerra desta cena para todos?"))) return;
          const res = await game.socket.timeout(10_000).emitWithAck("resetFog", sceneId);
          toast(res.ok ? "Nevoeiro reposto" : res.error, res.ok ? "info" : "error");
        }
      }, "Repor nevoeiro"));
    }
    sub.hidden = !sub.childElementCount;
  };
  board.on("tool", render);
  render();
  return h("div.controls-wrap", null, bar, sub);
}
