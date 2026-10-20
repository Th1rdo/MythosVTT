import { game } from "../game.ts";
import { h } from "../dom.ts";
import { isPaused, togglePause } from "./pause.ts";
import { openSettingsConfig } from "../ui/settings.ts";
import { openUserConfig } from "../ui/user-config.ts";

let menu: HTMLElement | null = null;

export function closeMainMenu(): boolean {
  if (!menu) return false;
  menu.remove();
  menu = null;
  return true;
}

/** Esc with nothing else to close: Foundry-style main menu. */
export function toggleMainMenu(): void {
  if (closeMainMenu()) return;
  const item = (icon: string, label: string, run: () => void) => h("li", null, h("button", { onclick: () => { closeMainMenu(); run(); } }, h("i", { className: icon }), " ", label));
  menu = h("div#main-menu", { onclick: (e: Event) => e.target === menu && closeMainMenu() },
    h("menu", null,
      h("li.menu-title", null, game.world.title),
      item("fa-solid fa-user-gear", "A minha conta", () => openUserConfig(game.userId)),
      item("fa-solid fa-gears", "Definições", () => openSettingsConfig()),
      item("fa-solid fa-keyboard", "Teclas", () => openSettingsConfig("keys")),
      game.isGM ? item(isPaused() ? "fa-solid fa-play" : "fa-solid fa-pause", isPaused() ? "Retomar o jogo" : "Pausar o jogo", togglePause) : null,
      item("fa-solid fa-rotate", "Recarregar", () => location.reload()),
      item("fa-solid fa-right-from-bracket", "Sair", async () => { await fetch("/api/logout", { method: "POST" }); location.reload(); }),
      h("li", null, h("button.muted", { onclick: closeMainMenu }, "Voltar ao jogo (Esc)"))));
  document.body.append(menu);
}
