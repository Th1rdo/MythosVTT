import "@fontsource/signika/400.css";
import "@fontsource/signika/600.css";
import "@fontsource/signika/700.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./style.css";
import type { UserDoc } from "../../shared/protocol.ts";
import type { PlayAudioEvent, RunMacroEvent, ShareImageEvent, ShowEntryEvent } from "../../shared/protocol.ts";
import { openImagePopout, openJournal } from "./ui/journal.ts";
import { game, toast } from "./game.ts";
import { Board } from "./canvas/board.ts";
import { Perception } from "./canvas/perception.ts";
import { WallsLayer } from "./canvas/walls.ts";
import { LightsLayer } from "./canvas/lights.ts";
import { SoundsLayer } from "./canvas/sounds.ts";
import { AmbientPlayer } from "./audio/ambient.ts";
import { PlaylistPlayer } from "./audio/playlists.ts";
import { audio } from "./audio/engine.ts";
import { playlistsPanel } from "./ui/playlists.ts";
import { macrosPanel } from "./ui/macros.ts";
import { tablesPanel } from "./ui/tables.ts";
import { compendiaPanel } from "./ui/compendia.ts";
import { cardsPanel } from "./ui/cards.ts";
import { onRunMacro, setMacroBoard } from "./macros.ts";
import { registerCoreKeys } from "./shell/keys.ts";
import { pauseBanner } from "./shell/pause.ts";
import { openUserConfig } from "./ui/user-config.ts";
import { setupScreen } from "./setup.ts";
import { offerFirstTour } from "./tours.ts";
import { hooks } from "./hooks.ts";
import { volumeControls } from "./ui/audio-config.ts";
import { openSettingsConfig } from "./ui/settings.ts";
import { TilesLayer } from "./canvas/tiles.ts";
import { DrawingsLayer } from "./canvas/drawings.ts";
import { NotesLayer } from "./canvas/notes.ts";
import { RegionsLayer } from "./canvas/regions.ts";
import { Ruler } from "./canvas/ruler.ts";
import { sceneControls } from "./shell/controls.ts";
import { sceneNavigation } from "./shell/navigation.ts";
import { playersList } from "./shell/players.ts";
import { hotbar } from "./shell/hotbar.ts";
import { sidebar } from "./shell/sidebar.ts";
import type { SidebarTab } from "./shell/sidebar.ts";
import { applyUiScale, readUiScale } from "./shell/ui-scale.ts";
import { TurnMarker } from "./canvas/turn-marker.ts";
import { combatPanel } from "./ui/combat.ts";
import { h } from "./dom.ts";
import { chatPanel } from "./ui/chat.ts";
import { actorsPanel, itemsPanel, journalPanel, playersPanel, scenesPanel } from "./ui/panels.ts";
import { t } from "./i18n.ts";

interface WorldInfo {
  world: { id: string; title: string; system: string };
  users: Pick<UserDoc, "_id" | "name" | "role" | "color">[];
  me: string | null;
}

const app = document.getElementById("app")!;
applyUiScale(readUiScale());

async function boot(): Promise<void> {
  const info: WorldInfo & { setup?: boolean } = await fetch("/api/world").then(r => r.json());
  if (location.pathname === "/setup" || info.setup || !info.world) {
    document.title = t("Configuração · Mesa");
    return setupScreen(app);
  }
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
  const user = h("select", { name: "user" }, info.users.map(u => h("option", { value: u._id }, u.name + (u.role === "gm" ? (" " + t("(mestre)")) : ""))));
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
          error.textContent = (await res.json().catch(() => ({}))).error ?? t("Erro");
          return;
        }
        await startGame();
      }
    },
      h("h1", null, info.world.title),
      h("p.muted", null, t("Mesa · "), info.world.system),
      h("label.field", null, h("span", null, t("Quem és?")), user),
      h("label.field", null, h("span", null, "Palavra-passe"), password),
      error,
      h("button.primary", { type: "submit" }, t("Entrar")),
      h("a.muted.small.setup-link", { href: "/setup" }, h("i.fa-solid.fa-gear"), (" " + t("Configuração")))
    )
  ));
}

async function startGame(): Promise<void> {
  const boardHost = h("div.board");
  const stage = h("div.stage", null, boardHost);
  app.replaceChildren(stage);

  await game.connect();
  hooks.callAll("init");
  hooks.callAll("setup");

  const board = new Board();
  await board.mount(boardHost);
  const perception = new Perception(board);
  const walls = new WallsLayer(board, perception);
  const lights = new LightsLayer(board);
  const ambient = new AmbientPlayer(board);
  const sounds = new SoundsLayer(board, ambient);
  const playlists = new PlaylistPlayer();
  setMacroBoard(board);
  registerCoreKeys(board);
  setTimeout(offerFirstTour, 2500);
  game.socket.on("runMacro", (e: RunMacroEvent) => onRunMacro(e));
  game.socket.on("showEntry", (e: ShowEntryEvent) => game.get("JournalEntry", e.entryId) && openJournal(e.entryId, { pageId: e.pageId }));
  game.socket.on("shareImage", (e: ShareImageEvent) => openImagePopout(e.src, e.title));
  game.socket.on("playAudio", (e: PlayAudioEvent) => audio.playOnce(e.src, e));
  game.socket.on("preloadAudio", (src: string) => audio.whenReady(() => fetch(src).catch(() => {})));
  // Browsers keep audio off until the page is used; say so if something is waiting to play.
  setTimeout(() => audio.hasWaiting && toast(t("Clica em qualquer lado para ativar o som.")), 1500);
  const tiles = new TilesLayer(board);
  const drawings = new DrawingsLayer(board);
  new NotesLayer(board, perception);
  const regions = new RegionsLayer(board);
  new Ruler(board);
  new TurnMarker(board);
  perception.refresh();
  // Debug handle for development only (stripped from production builds).
  if (import.meta.env.DEV) Object.assign(window, { mesa: { game, board, perception, walls, audio, ambient, playlists, hooks } });

  const tabs: SidebarTab[] = [
    { id: "chat", icon: "fa-solid fa-comments", label: t("Chat"), make: chatPanel },
    { id: "combat", icon: "fa-solid fa-khanda", label: t("Combate"), make: () => combatPanel(id => board.panTo(id)) },
    ...(game.isGM ? [{ id: "scenes", icon: "fa-solid fa-map", label: t("Cenas"), make: scenesPanel }] : []),
    { id: "actors", icon: "fa-solid fa-user", label: t("Atores"), make: actorsPanel },
    { id: "items", icon: "fa-solid fa-suitcase", label: t("Itens"), make: itemsPanel },
    { id: "journal", icon: "fa-solid fa-book-open", label: t("Diário"), make: journalPanel },
    { id: "tables", icon: "fa-solid fa-table-list", label: t("Tabelas"), make: tablesPanel },
    { id: "cards", icon: "fa-solid fa-clone", label: t("Cartas"), make: cardsPanel },
    { id: "macros", icon: "fa-solid fa-code", label: t("Macros"), make: macrosPanel },
    { id: "playlists", icon: "fa-solid fa-music", label: t("Playlists"), make: () => playlistsPanel(playlists) },
    { id: "compendia", icon: "fa-solid fa-book-atlas", label: t("Compêndios"), make: compendiaPanel },
    { id: "settings", icon: "fa-solid fa-gears", label: t("Definições"), make: settingsPanel }
  ];
  // Packages can add sidebar tabs (before Definições) or change the list.
  hooks.callAll("getSidebarTabs", tabs);
  stage.append(
    sceneControls(board, walls, lights, sounds, tiles, drawings, regions),
    sceneNavigation(),
    playersList(board),
    pauseBanner(board),
    hotbar(),
    sidebar(tabs)
  );
  hooks.callAll("ready");
}

function settingsPanel(): HTMLElement {
  return h("div.panel", null,
    h("div.settings-block", null,
      h("h3", null, game.world.title),
      h("p.muted.small", null, `Mesa · ${game.world.system}`),
      h("p", null, t("Ligado como "), h("strong", null, game.user.name), game.isGM ? (" " + t("(mestre)")) : ""),
      h("div.stack", null,
        h("button", { onclick: () => openUserConfig(game.userId) }, h("i.fa-solid.fa-user-gear"), (" " + t("A minha conta"))),
        h("button", { onclick: () => openSettingsConfig() }, h("i.fa-solid.fa-gears"), (" " + t("Definições"))),
        h("button", { onclick: async () => { await fetch("/api/logout", { method: "POST" }); location.reload(); } }, h("i.fa-solid.fa-right-from-bracket"), (" " + t("Sair"))))
    ),
    h("div.settings-block", null, h("h4", null, t("Volume (só neste browser)")), volumeControls()),
    game.isGM && h("h4.settings-title", null, t("Jogadores")),
    game.isGM && playersPanel()
  );
}

boot();
