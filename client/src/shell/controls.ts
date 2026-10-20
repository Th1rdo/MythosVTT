import type { SceneDoc } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { h } from "../dom.ts";
import type { Board, ToolName } from "../canvas/board.ts";
import type { WallPreset, WallsLayer } from "../canvas/walls.ts";
import type { LightsLayer } from "../canvas/lights.ts";
import type { SoundsLayer } from "../canvas/sounds.ts";
import type { TilesLayer } from "../canvas/tiles.ts";
import type { DrawingsLayer } from "../canvas/drawings.ts";
import type { RegionsLayer } from "../canvas/regions.ts";
import { confirmDialog } from "../ui/windows.ts";
import { t } from "../i18n.ts";
import { hooks } from "../hooks.ts";

export interface ToolDef {
  name: string;
  icon: string;
  title: string;
  /** Toggle tools become the active tool; button tools just run `run`. */
  button?: boolean;
  run: () => void;
}

export interface GroupDef {
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
export function sceneControls(board: Board, walls: WallsLayer, lights: LightsLayer, sounds: SoundsLayer, tiles: TilesLayer, drawings: DrawingsLayer, regions: RegionsLayer): HTMLElement {
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
      name: "tokens", icon: "fa-solid fa-user-large", title: t("Tokens"), gm: false,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: "Selecionar tokens — clique, Shift+clique, caixa; botão direito: HUD", run: use("tokens") },
        { name: "ruler", icon: "fa-solid fa-ruler", title: t("Régua — arrastar para medir, Espaço: ponto intermédio"), run: use("ruler") }
      ]
    },
    {
      name: "templates", icon: "fa-solid fa-ruler-combined", title: t("Medição (modelos)"), gm: false,
      tools: [
        { name: "circle", icon: "fa-regular fa-circle", title: t("Círculo — arrastar a partir do centro"), run: use("regions", () => (regions.tool = "circle")) },
        { name: "cone", icon: "fa-solid fa-play fa-rotate-270", title: t("Cone — arrastar na direção"), run: use("regions", () => (regions.tool = "cone")) },
        { name: "rectangle", icon: "fa-regular fa-square", title: t("Retângulo"), run: use("regions", () => (regions.tool = "rectangle")) },
        { name: "line", icon: "fa-solid fa-arrows-left-right", title: t("Linha (raio)"), run: use("regions", () => (regions.tool = "line")) },
        { name: "select", icon: "fa-solid fa-expand", title: t("Selecionar modelos — arrastar para mover, Del: apagar"), run: use("regions", () => (regions.tool = "select")) },
        { name: "clear", icon: "fa-solid fa-trash", title: game.isGM ? t("Apagar todos os modelos da cena") : t("Apagar os meus modelos"), button: true, run: () => regions.clearTemplates() }
      ]
    },
    {
      name: "regions", icon: "fa-solid fa-vector-square", title: t("Regiões"), gm: true,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: t("Selecionar regiões — arrastar, duplo clique: configurar e comportamentos, Del: apagar"), run: use("regions", () => (regions.tool = "select")) },
        { name: "region-rectangle", icon: "fa-regular fa-square", title: t("Região retangular"), run: use("regions", () => (regions.tool = "region-rectangle")) },
        { name: "region-ellipse", icon: "fa-regular fa-circle", title: t("Região elíptica"), run: use("regions", () => (regions.tool = "region-ellipse")) },
        { name: "region-polygon", icon: "fa-solid fa-draw-polygon", title: t("Região poligonal — clicar pontos, Enter ou duplo clique para fechar"), run: use("regions", () => (regions.tool = "region-polygon")) }
      ]
    },
    {
      name: "drawings", icon: "fa-solid fa-pencil", title: t("Desenhos"), gm: false,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: t("Selecionar desenhos — arrastar, duplo clique: configurar, Del: apagar"), run: use("drawings", () => (drawings.tool = "select")) },
        { name: "rectangle", icon: "fa-regular fa-square", title: t("Retângulo"), run: use("drawings", () => (drawings.tool = "rectangle")) },
        { name: "ellipse", icon: "fa-regular fa-circle", title: t("Elipse"), run: use("drawings", () => (drawings.tool = "ellipse")) },
        { name: "polygon", icon: "fa-solid fa-draw-polygon", title: t("Polígono — clicar pontos, duplo clique ou Enter para fechar"), run: use("drawings", () => (drawings.tool = "polygon")) },
        { name: "freehand", icon: "fa-solid fa-signature", title: t("Mão livre"), run: use("drawings", () => (drawings.tool = "freehand")) },
        { name: "text", icon: "fa-solid fa-font", title: t("Texto — clicar no mapa"), run: use("drawings", () => (drawings.tool = "text")) },
        ...(game.isGM ? [{ name: "clear", icon: "fa-solid fa-trash", title: t("Apagar todos os desenhos da cena"), button: true, run: async () => { if (await confirmDialog(t("Apagar todos os desenhos desta cena?"))) drawings.clearAll(); } }] : [])
      ]
    },
    {
      name: "notes", icon: "fa-solid fa-bookmark", title: t("Notas"), gm: true,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: "Notas — arrasta uma entrada do Diário para o mapa; arrastar para mover, Del: apagar, duplo clique: abrir", run: use("notes") }
      ]
    },
    {
      name: "tiles", icon: "fa-solid fa-cubes", title: t("Tiles"), gm: true,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: t("Selecionar tiles — arrastar para mover, duplo clique: configurar, Del: apagar"), run: use("tiles", () => (tiles.mode = "select")) },
        { name: "place", icon: "fa-solid fa-image", title: t("Pôr tile — escolhe uma imagem e clica no mapa"), button: true, run: () => { board.setTool("tiles"); group = "tiles"; tool = "select"; render(); tiles.startPlacing(); } }
      ]
    },
    {
      name: "walls", icon: "fa-solid fa-dungeon", title: t("Paredes"), gm: true,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: t("Selecionar paredes — clicar, arrastar pontas, duplo clique: configurar, Del: apagar"), run: use("walls", () => (walls.preset = null)) },
        wallTool("wall", "fa-solid fa-bars", t("Parede")),
        wallTool("terrain", "fa-solid fa-tree", t("Parede de terreno (vê-se através de uma)")),
        wallTool("invisible", "fa-solid fa-eye-slash", t("Parede invisível (só bloqueia movimento)")),
        wallTool("ethereal", "fa-solid fa-ghost", t("Parede etérea (bloqueia visão, não movimento)")),
        wallTool("window", "fa-regular fa-window-maximize", t("Janela (deixa ver e passar luz)")),
        wallTool("door", "fa-solid fa-door-open", t("Porta")),
        wallTool("secret", "fa-solid fa-user-secret", t("Porta secreta"))
      ]
    },
    {
      name: "lighting", icon: "fa-regular fa-lightbulb", title: t("Iluminação"), gm: true,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: t("Selecionar luzes — arrastar para mover, duplo clique: configurar, botão direito: ligar/desligar"), run: use("lights", () => (lights.drawing = false)) },
        { name: "light", icon: "fa-regular fa-lightbulb", title: t("Nova luz — arrastar define o raio"), run: use("lights", () => (lights.drawing = true)) },
        { name: "day", icon: "fa-solid fa-sun", title: t("Dia (escuridão 0)"), button: true, run: () => setDarkness(0) },
        { name: "night", icon: "fa-solid fa-moon", title: t("Noite (escuridão 1)"), button: true, run: () => setDarkness(1) },
        {
          name: "reset-fog", icon: "fa-solid fa-cloud", title: t("Repor nevoeiro de guerra desta cena"), button: true,
          run: async () => {
            const sceneId = board.scene?._id;
            if (!sceneId || !(await confirmDialog(t("Repor o nevoeiro de guerra desta cena para todos?")))) return;
            const res = await game.socket.timeout(10_000).emitWithAck("resetFog", sceneId);
            toast(res.ok ? t("Nevoeiro reposto") : res.error, res.ok ? "info" : "error");
          }
        }
      ]
    },
    {
      name: "sounds", icon: "fa-solid fa-music", title: t("Sons ambiente"), gm: true,
      tools: [
        { name: "select", icon: "fa-solid fa-expand", title: "Selecionar sons — arrastar para mover, duplo clique: configurar, botão direito: ligar/desligar; o rato ouve como um token", run: use("sounds", () => (sounds.drawing = false)) },
        { name: "sound", icon: "fa-solid fa-volume-high", title: t("Novo som ambiente — arrastar define o raio"), run: use("sounds", () => (sounds.drawing = true)) }
      ]
    }
  ];

  // Packages add their own groups/tools here (or change the core ones).
  hooks.callAll("getSceneControlButtons", groups, board);

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
    // The regions tool serves two groups (templates for everyone, regions for the GM).
    const owner = board.tool === "regions"
      ? (regions.tool.startsWith("region-") || (group === "regions" && regions.tool === "select") ? "regions" : "templates")
      : ({ tokens: "tokens", ruler: "tokens", walls: "walls", lights: "lighting", sounds: "sounds", tiles: "tiles", drawings: "drawings", notes: "notes" } as const)[board.tool];
    if (owner !== group) {
      group = owner;
      tool = board.tool === "ruler" ? "ruler" : "select";
      render();
    }
  });
  render();
  return el;
}
