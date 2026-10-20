import { game } from "../game.ts";
import { h } from "../dom.ts";
import { isPaused, togglePause } from "./pause.ts";
import { openSettingsConfig } from "../ui/settings.ts";
import { openUserConfig } from "../ui/user-config.ts";
import { t } from "../i18n.ts";
import { openModuleManagement } from "../ui/modules.ts";

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
      item("fa-solid fa-user-gear", t("A minha conta"), () => openUserConfig(game.userId)),
      item("fa-solid fa-gears", t("Definições"), () => openSettingsConfig()),
      item("fa-solid fa-keyboard", t("Teclas"), () => openSettingsConfig("keys")),
      game.isGM ? item(isPaused() ? "fa-solid fa-play" : "fa-solid fa-pause", isPaused() ? t("Retomar o jogo") : t("Pausar o jogo"), togglePause) : null,
      item("fa-solid fa-rotate", t("Recarregar"), () => location.reload()),
      game.isGM ? item("fa-solid fa-cube", t("Gerir módulos"), () => openModuleManagement()) : null,
      game.isGM ? item("fa-solid fa-server", t("Configuração (mundos)"), () => (location.href = "/setup")) : null,
      item("fa-solid fa-right-from-bracket", t("Sair"), async () => { await fetch("/api/logout", { method: "POST" }); location.reload(); }),
      h("li", null, h("button.muted", { onclick: closeMainMenu }, t("Voltar ao jogo (Esc)")))));
  document.body.append(menu);
}
