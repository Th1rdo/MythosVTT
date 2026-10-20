import type { ActorDoc, UserDoc } from "../../../shared/protocol.ts";
import { game } from "../game.ts";
import { h, setChildren } from "../dom.ts";
import type { Board } from "../canvas/board.ts";
import { openUserConfig } from "../ui/user-config.ts";
import { t } from "../i18n.ts";
import { openContextMenu } from "../ui/context-menu.ts";
import { openImagePopout } from "../ui/journal.ts";
import { confirmDialog } from "../ui/windows.ts";

/** Players (bottom-left): who's online, their character, and connection/frame-rate stats. */
export function playersList(board: Board): HTMLElement {
  const el = h("aside#players");
  let expanded = false;
  const latency = h("span.stat-value", null, "--");
  const fps = h("span.stat-value", null, "--");

  const row = (u: UserDoc) => {
    const character = game.get<ActorDoc>("Actor", u.character);
    const editable = game.isGM || u._id === game.userId;
    return h("li", {
      className: `${game.online.includes(u._id) ? "player online" : "player"}${editable ? " editable" : ""}`, style: { "--player-color": u.color },
      title: editable ? t("Clica para configurar") : u.pronouns || "",
      onclick: () => editable && openUserConfig(u._id),
      // Right-click: Foundry's User Configuration, View Avatar, Pull To Scene, Kick.
      oncontextmenu: (e: MouseEvent) => openContextMenu(e, [
        { label: "Configurar utilizador", icon: "fa-solid fa-user-gear", visible: editable, onClick: () => openUserConfig(u._id) },
        { label: "Ver avatar", icon: "fa-solid fa-image", visible: !!u.avatar, onClick: () => openImagePopout(u.avatar!, u.name) },
        { label: "Puxar para esta cena", icon: "fa-solid fa-person-walking-arrow-right", group: "gm",
          visible: game.isGM && u._id !== game.userId && game.online.includes(u._id) && !!game.viewedSceneId,
          onClick: () => game.pullPlayers(game.viewedSceneId!, [u._id]) },
        { label: "Expulsar", icon: "fa-solid fa-door-open", group: "gm", classes: "danger",
          visible: game.isGM && u._id !== game.userId && game.online.includes(u._id),
          onClick: async () => { if (await confirmDialog(t("Expulsar {nome}? Volta ao ecrã de entrada (pode entrar outra vez).", { nome: u.name }), t("Expulsar"))) game.socket.emit("kick", u._id); } }
      ], u, "User")
    },
      u.avatar ? h("img.player-avatar", { src: u.avatar, alt: "" }) : h("span.player-dot"),
      h("span.player-name", null, u.name, u.role === "gm" ? " [GM]" : character ? ` (${character.name})` : ""),
      u.pronouns ? h("span.player-pronouns", null, u.pronouns) : null);
  };

  const render = () => {
    const users = game.all<UserDoc>("User").sort((a, b) => (a.role === "gm" ? -1 : 0) - (b.role === "gm" ? -1 : 0) || a.name.localeCompare(b.name, "pt"));
    const active = users.filter(u => game.online.includes(u._id));
    const inactive = users.filter(u => !game.online.includes(u._id));
    setChildren(el, 
      expanded && inactive.length ? h("ol.players-list.inactive", null, inactive.map(row)) : null,
      h("ol.players-list", null, active.map(row)),
      h("div.perf", null,
        h("span.stat", null, t("Latência "), latency),
        h("span.stat", null, "FPS ", fps),
        inactive.length ? h("button.icon.small", { title: expanded ? t("Esconder offline") : t("Mostrar offline"), onclick: () => { expanded = !expanded; render(); } },
          h("i", { className: `fa-solid fa-caret-${expanded ? "down" : "up"}` })) : null)
    );
  };
  const stats = () => {
    latency.textContent = game.latency === null ? "--" : `${Math.round(game.latency)}ms`;
    fps.textContent = String(Math.round(board.app.ticker.FPS));
  };
  game.on("presence", () => { render(); stats(); });
  game.on("User", render);
  game.on("Actor", render);
  setInterval(stats, 1000);
  render();
  return el;
}
