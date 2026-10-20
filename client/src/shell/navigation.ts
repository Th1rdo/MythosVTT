import type { SceneDoc, UserDoc } from "../../../shared/protocol.ts";
import { game } from "../game.ts";
import { h, setChildren } from "../dom.ts";

/**
 * Scene navigation (top-left, like Foundry's): the viewed scene as a pill with the players who are
 * looking at it; the caret expands the list of navigable scenes. GMs click a scene to view it and
 * right-click to activate it for everyone.
 */
export function sceneNavigation(): HTMLElement {
  const el = h("nav#navigation");
  let expanded = false;

  const pips = (sceneId: string) => {
    const users = game.all<UserDoc>("User").filter(u => game.online.includes(u._id) && game.viewing[u._id] === sceneId);
    return users.length
      ? h("ul.scene-players", null, users.map(u => h("li", { title: u.name, style: { background: u.color } }, u.name[0]?.toUpperCase() ?? "?")))
      : null;
  };

  const pill = (s: SceneDoc, viewed: boolean) => h("li", {
    className: ["scene-pill", viewed && "viewed", s.active && "active"].filter(Boolean).join(" "),
    title: game.isGM ? "Clique: ver · Botão direito: ativar para todos" : s.name,
    onclick: () => game.isGM && game.view(s._id),
    oncontextmenu: (e: Event) => {
      e.preventDefault();
      if (game.isGM && !s.active) game.update("Scene", { _id: s._id, active: true });
    }
  },
    h("span.scene-name", null, s.name),
    s.active && h("i.fa-solid.fa-bullseye", { title: "Cena ativa" }),
    !s.navigation && game.isGM && h("i.fa-solid.fa-eye-slash", { title: "Escondida da navegação dos jogadores" }),
    pips(s._id)
  );

  const render = () => {
    const viewed = game.viewedScene;
    const others = game.all<SceneDoc>("Scene")
      .filter(s => s._id !== viewed?._id && (game.isGM ? s.navigation || s.active : s.active))
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"));
    setChildren(el, 
      others.length > 0 ? h("button.nav-expand", { title: expanded ? "Esconder cenas" : "Mostrar cenas", onclick: () => { expanded = !expanded; render(); } },
        h("i", { className: `fa-solid fa-caret-${expanded ? "up" : "down"}` })) : null,
      h("menu.scene-list", null,
        viewed ? pill(viewed, true) : h("li.scene-pill.viewed", null, h("span.scene-name", null, "Sem cena")),
        expanded ? others.map(s => pill(s, false)) : null,
        viewed && game.isGM && !viewed.active ? h("li.scene-note", null, "pré-visualização — os jogadores não veem esta cena") : null
      )
    );
  };
  game.on("Scene", render);
  game.on("view", render);
  game.on("presence", render);
  game.on("User", render);
  render();
  return el;
}
