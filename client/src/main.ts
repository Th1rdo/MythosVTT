import "@fontsource/signika/400.css";
import "@fontsource/signika/600.css";
import "@fontsource/signika/700.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./style.css";
import type { UserDoc } from "../../shared/protocol.ts";
import { game } from "./game.ts";
import { Board } from "./canvas/board.ts";
import { Perception } from "./canvas/perception.ts";
import { WallsLayer } from "./canvas/walls.ts";
import { LightsLayer } from "./canvas/lights.ts";
import { Ruler } from "./canvas/ruler.ts";
import { sceneControls } from "./shell/controls.ts";
import { sceneNavigation } from "./shell/navigation.ts";
import { playersList } from "./shell/players.ts";
import { hotbar } from "./shell/hotbar.ts";
import { sidebar } from "./shell/sidebar.ts";
import type { SidebarTab } from "./shell/sidebar.ts";
import { applyUiScale, readUiScale, uiScaleSettings } from "./shell/ui-scale.ts";
import { TurnMarker } from "./canvas/turn-marker.ts";
import { combatPanel } from "./ui/combat.ts";
import { h } from "./dom.ts";
import { chatPanel } from "./ui/chat.ts";
import { actorsPanel, itemsPanel, journalPanel, playersPanel, scenesPanel } from "./ui/panels.ts";

interface WorldInfo {
  world: { id: string; title: string; system: string };
  users: Pick<UserDoc, "_id" | "name" | "role" | "color">[];
  me: string | null;
}

const app = document.getElementById("app")!;
applyUiScale(readUiScale());

async function boot(): Promise<void> {
  const info: WorldInfo = await fetch("/api/world").then(r => r.json());
  document.title = `${info.world.title} · Mesa`;
  if (!info.me) return joinScreen(info);
  try {
    await startGame();
  } catch {
    joinScreen(info);
  }
}

function joinScreen(info: WorldInfo): void {
  const error = h("p.error");
  const user = h("select", { name: "user" }, info.users.map(u => h("option", { value: u._id }, u.name + (u.role === "gm" ? " (mestre)" : ""))));
  const password = h("input", { type: "password", name: "password", placeholder: "Palavra-passe", autocomplete: "current-password" });
  app.replaceChildren(h("main.join", null,
    h("form.join-card.stack", {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        error.textContent = "";
        const res = await fetch("/api/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.value, password: password.value })
        });
        if (!res.ok) {
          error.textContent = (await res.json().catch(() => ({}))).error ?? "Erro";
          return;
        }
        await startGame();
      }
    },
      h("h1", null, info.world.title),
      h("p.muted", null, "Mesa · ", info.world.system),
      h("label.field", null, h("span", null, "Quem és?"), user),
      h("label.field", null, h("span", null, "Palavra-passe"), password),
      error,
      h("button.primary", { type: "submit" }, "Entrar")
    )
  ));
}

async function startGame(): Promise<void> {
  const boardHost = h("div.board");
  const stage = h("div.stage", null, boardHost);
  app.replaceChildren(stage);

  await game.connect();

  const board = new Board();
  await board.mount(boardHost);
  const perception = new Perception(board);
  const walls = new WallsLayer(board, perception);
  const lights = new LightsLayer(board);
  new Ruler(board);
  new TurnMarker(board);
  perception.refresh();
  // Debug handle for development only (stripped from production builds).
  if (import.meta.env.DEV) Object.assign(window, { mesa: { game, board, perception, walls } });

  const tabs: SidebarTab[] = [
    { id: "chat", icon: "fa-solid fa-comments", label: "Chat", make: chatPanel },
    { id: "combat", icon: "fa-solid fa-khanda", label: "Combate", make: () => combatPanel(id => board.panTo(id)) },
    ...(game.isGM ? [{ id: "scenes", icon: "fa-solid fa-map", label: "Cenas", make: scenesPanel }] : []),
    { id: "actors", icon: "fa-solid fa-user", label: "Atores", make: actorsPanel },
    { id: "items", icon: "fa-solid fa-suitcase", label: "Itens", make: itemsPanel },
    { id: "journal", icon: "fa-solid fa-book-open", label: "Diário", make: journalPanel },
    { id: "settings", icon: "fa-solid fa-gears", label: "Definições", make: settingsPanel }
  ];
  stage.append(
    sceneControls(board, walls, lights),
    sceneNavigation(),
    playersList(board),
    hotbar(),
    sidebar(tabs)
  );
}

function settingsPanel(): HTMLElement {
  return h("div.panel", null,
    h("div.settings-block", null,
      h("h3", null, game.world.title),
      h("p.muted.small", null, `Mesa · ${game.world.system}`),
      h("p", null, "Ligado como ", h("strong", null, game.user.name), game.isGM ? " (mestre)" : ""),
      h("button", { onclick: async () => { await fetch("/api/logout", { method: "POST" }); location.reload(); } }, h("i.fa-solid.fa-right-from-bracket"), " Sair")
    ),
    uiScaleSettings(),
    game.isGM && h("h4.settings-title", null, "Jogadores"),
    game.isGM && playersPanel()
  );
}

boot();
