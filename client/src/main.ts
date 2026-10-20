import "./style.css";
import type { SceneDoc, UserDoc } from "../../shared/protocol.ts";
import { game } from "./game.ts";
import { Board } from "./canvas/board.ts";
import { Perception } from "./canvas/perception.ts";
import { WallsLayer } from "./canvas/walls.ts";
import { LightsLayer } from "./canvas/lights.ts";
import { Ruler } from "./canvas/ruler.ts";
import { sceneControls } from "./canvas/controls.ts";
import { TurnMarker } from "./canvas/turn-marker.ts";
import { combatPanel } from "./ui/combat.ts";
import { h } from "./dom.ts";
import { chatPanel } from "./ui/chat.ts";
import { actorsPanel, journalPanel, playersPanel, scenesPanel } from "./ui/panels.ts";

interface WorldInfo {
  world: { id: string; title: string; system: string };
  users: Pick<UserDoc, "_id" | "name" | "role" | "color">[];
  me: string | null;
}

const app = document.getElementById("app")!;

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
  const sidebar = h("aside.sidebar");
  const sceneTitle = h("span.scene-name");
  const presence = h("div.presence");
  const hint = h("div.hint.muted.small");
  const controlsHost = h("div");

  app.replaceChildren(h("div.layout", null,
    h("div.stage", null,
      boardHost,
      h("div.hud-top", null, sceneTitle),
      presence,
      controlsHost,
      hint
    ),
    sidebar
  ));

  await game.connect();

  const board = new Board();
  await board.mount(boardHost);
  const perception = new Perception(board);
  const walls = new WallsLayer(board, perception);
  new LightsLayer(board);
  new Ruler(board);
  new TurnMarker(board);
  controlsHost.replaceWith(sceneControls(board, walls, hint));
  perception.refresh();
  // Debug handle for development only (stripped from production builds).
  if (import.meta.env.DEV) Object.assign(window, { mesa: { game, board, perception, walls } });

  const tabs: [string, string, () => HTMLElement][] = [
    ["chat", "Chat", chatPanel],
    ["combat", "Combate", () => combatPanel(id => board.panTo(id))],
    ["actors", "Atores", actorsPanel],
    ["journal", "Diário", journalPanel],
    ...(game.isGM ? [["scenes", "Cenas", scenesPanel], ["players", "Jogadores", playersPanel]] as [string, string, () => HTMLElement][] : [])
  ];
  const panels = new Map(tabs.map(([id, , make]) => [id, make()]));
  const nav = h("nav.tabs", null, tabs.map(([id, label]) => h("button", { dataset: { tab: id }, onclick: () => show(id) }, label)));
  const content = h("div.tab-content");
  const show = (id: string) => {
    for (const b of nav.querySelectorAll("button")) b.classList.toggle("active", b.dataset.tab === id);
    content.replaceChildren(panels.get(id)!);
  };
  sidebar.append(
    h("header.side-head", null,
      h("strong.grow", null, game.world.title),
      h("span.muted.small", null, game.user.name),
      h("button.icon.small", { title: "Sair", onclick: async () => { await fetch("/api/logout", { method: "POST" }); location.reload(); } }, "⏻")
    ),
    nav, content
  );
  show("chat");

  const renderSceneTitle = () => {
    const s: SceneDoc | undefined = game.viewedScene;
    sceneTitle.textContent = s ? s.name + (game.isGM && !s.active ? "  (pré-visualização — não ativa)" : "") : "Sem cena ativa";
  };
  game.on("view", renderSceneTitle);
  game.on("Scene", renderSceneTitle);
  renderSceneTitle();

  const renderPresence = () => {
    presence.replaceChildren(...game.all<UserDoc>("User").map(u => h("div.who", { className: game.online.includes(u._id) ? "who on" : "who" },
      h("span.dot", { style: { background: u.color } }), u.name)));
  };
  game.on("presence", renderPresence);
  game.on("User", renderPresence);
  renderPresence();
}

boot();
