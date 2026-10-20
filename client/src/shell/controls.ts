import type { SceneDoc } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { h } from "../dom.ts";
import type { Board, ToolName } from "../canvas/board.ts";
import type { WallPreset, WallsLayer } from "../canvas/walls.ts";
import type { LightsLayer } from "../canvas/lights.ts";
import type { TilesLayer } from "../canvas/tiles.ts";
import type { DrawingsLayer } from "../canvas/drawings.ts";
import { confirmDialog } from "../ui/windows.ts";

interface ToolDef {
  name: string;
  icon: string;
  title: string;
  /** Toggle tools become the active tool; button tools just run `run`. */
  button?: boolean;
  run: () => void;
}

interface GroupDef {
  name: string;
  icon: string;
  title: string;
  gm: boolean;
  tools: ToolDef[];
}

/**
 * Scene controls, laid out like Foundry's: the left column picks a layer group, the right column
 * shows that group's tools. Hover a button for what it does.
 */
export function sceneControls(board: Board, walls: WallsLayer, lights: LightsLayer, tiles: TilesLayer, drawings: DrawingsLayer): HTMLElement {
  const el = h("nav#controls");
  let group = "tokens";
  let tool = "select";

  const use = (boardTool: ToolName, after?: () => void) => () => {
    board.setTool(boardTool);
    after?.();
  };
  const wallTool = (name: WallPreset, icon: string, title: string): ToolDef => ({
    name, icon, title: `${title} — arrastar para desenhar; Ctrl ao largar encadeia; Shift sem grelha`,
    run: use("walls", () => (walls.preset = name))
  });
  const setDarkness = (darkness: number) => {
    const scene = board.scene as SceneDoc | undefined;
    if (scene) game.update("Scene", { _id: scene._id, environment: { ...scene.environment, darkness } });
  };

  const groups: GroupDef[] = [
    {
      name: "tokens", icon: "fa-solid fa-user-large", title: "Tokens", gm: false,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: "Selecionar tokens — clique, Shift+clique, caixa; botão direito: HUD", run: use("tokens") },
        { name: "ruler", icon: "fa-solid fa-ruler", title: "Régua — arrastar para medir, Espaço: ponto intermédio", run: use("ruler") }
      ]
    },
    {
      name: "drawings", icon: "fa-solid fa-pencil", title: "Desenhos", gm: false,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: "Selecionar desenhos — arrastar, duplo clique: configurar, Del: apagar", run: use("drawings", () => (drawings.tool = "select")) },
        { name: "rectangle", icon: "fa-regular fa-square", title: "Retângulo", run: use("drawings", () => (drawings.tool = "rectangle")) },
        { name: "ellipse", icon: "fa-regular fa-circle", title: "Elipse", run: use("drawings", () => (drawings.tool = "ellipse")) },
        { name: "polygon", icon: "fa-solid fa-draw-polygon", title: "Polígono — clicar pontos, duplo clique ou Enter para fechar", run: use("drawings", () => (drawings.tool = "polygon")) },
        { name: "freehand", icon: "fa-solid fa-signature", title: "Mão livre", run: use("drawings", () => (drawings.tool = "freehand")) },
        { name: "text", icon: "fa-solid fa-font", title: "Texto — clicar no mapa", run: use("drawings", () => (drawings.tool = "text")) },
        ...(game.isGM ? [{ name: "clear", icon: "fa-solid fa-trash", title: "Apagar todos os desenhos da cena", button: true, run: async () => { if (await confirmDialog("Apagar todos os desenhos desta cena?")) drawings.clearAll(); } }] : [])
      ]
    },
    {
      name: "notes", icon: "fa-solid fa-bookmark", title: "Notas", gm: true,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: "Notas — arrasta uma entrada do Diário para o mapa; arrastar para mover, Del: apagar, duplo clique: abrir", run: use("notes") }
      ]
    },
    {
      name: "tiles", icon: "fa-solid fa-cubes", title: "Tiles", gm: true,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: "Selecionar tiles — arrastar para mover, duplo clique: configurar, Del: apagar", run: use("tiles", () => (tiles.mode = "select")) },
        { name: "place", icon: "fa-solid fa-image", title: "Pôr tile — escolhe uma imagem e clica no mapa", button: true, run: () => { board.setTool("tiles"); group = "tiles"; tool = "select"; render(); tiles.startPlacing(); } }
      ]
    },
    {
      name: "walls", icon: "fa-solid fa-dungeon", title: "Paredes", gm: true,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: "Selecionar paredes — clicar, arrastar pontas, duplo clique: configurar, Del: apagar", run: use("walls", () => (walls.preset = null)) },
        wallTool("wall", "fa-solid fa-bars", "Parede"),
        wallTool("terrain", "fa-solid fa-tree", "Parede de terreno (vê-se através de uma)"),
        wallTool("invisible", "fa-solid fa-eye-slash", "Parede invisível (só bloqueia movimento)"),
        wallTool("ethereal", "fa-solid fa-ghost", "Parede etérea (bloqueia visão, não movimento)"),
        wallTool("window", "fa-regular fa-window-maximize", "Janela (deixa ver e passar luz)"),
        wallTool("door", "fa-solid fa-door-open", "Porta"),
        wallTool("secret", "fa-solid fa-user-secret", "Porta secreta")
      ]
    },
    {
      name: "lighting", icon: "fa-regular fa-lightbulb", title: "Iluminação", gm: true,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: "Selecionar luzes — arrastar para mover, duplo clique: configurar, botão direito: ligar/desligar", run: use("lights", () => (lights.drawing = false)) },
        { name: "light", icon: "fa-regular fa-lightbulb", title: "Nova luz — arrastar define o raio", run: use("lights", () => (lights.drawing = true)) },
        { name: "day", icon: "fa-solid fa-sun", title: "Dia (escuridão 0)", button: true, run: () => setDarkness(0) },
        { name: "night", icon: "fa-solid fa-moon", title: "Noite (escuridão 1)", button: true, run: () => setDarkness(1) },
        {
          name: "reset-fog", icon: "fa-solid fa-cloud", title: "Repor nevoeiro de guerra desta cena", button: true,
          run: async () => {
            const sceneId = board.scene?._id;
            if (!sceneId || !(await confirmDialog("Repor o nevoeiro de guerra desta cena para todos?"))) return;
            const res = await game.socket.timeout(10_000).emitWithAck("resetFog", sceneId);
            toast(res.ok ? "Nevoeiro reposto" : res.error, res.ok ? "info" : "error");
          }
        }
      ]
    }
  ];

  const select = (g: GroupDef, t: ToolDef) => {
    if (t.button) return t.run();
    group = g.name;
    tool = t.name;
    t.run();
    render();
  };

  const render = () => {
    const visible = groups.filter(g => !g.gm || game.isGM);
    const active = visible.find(g => g.name === group) ?? visible[0];
    el.replaceChildren(
      h("menu.control-layers", null, visible.map(g => h("li", null, h("button", {
        className: `control-btn${g.name === active.name ? " active" : ""}`,
        title: g.title,
        onclick: () => {
          if (g.name === group) return;
          select(g, g.tools[0]);
        }
      }, h("i", { className: g.icon }))))),
      h("menu.control-tools", null, active.tools.map(t => h("li", null, h("button", {
        className: `control-btn tool${!t.button && t.name === tool && active.name === group ? " active" : ""}`,
        title: t.title,
        onclick: () => select(active, t)
      }, h("i", { className: t.icon })))))
    );
  };
  // Keep in sync if something else changes the board tool (e.g. a scene change resets it).
  board.on("tool", () => {
    const owner = ({ tokens: "tokens", ruler: "tokens", walls: "walls", lights: "lighting", tiles: "tiles", drawings: "drawings", notes: "notes" } as const)[board.tool];
    if (owner !== group) {
      group = owner;
      tool = board.tool === "ruler" ? "ruler" : "select";
      render();
    }
  });
  render();
  return el;
}
