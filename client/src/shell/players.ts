import type { ActorDoc, UserDoc } from "../../../shared/protocol.ts";
import { game } from "../game.ts";
import { h, setChildren } from "../dom.ts";
import type { Board } from "../canvas/board.ts";

/** Players (bottom-left): who's online, their character, and connection/frame-rate stats. */
export function playersList(board: Board): HTMLElement {
  const el = h("aside#players");
  let expanded = false;
  const latency = h("span.stat-value", null, "--");
  const fps = h("span.stat-value", null, "--");

  const row = (u: UserDoc) => {
    const character = game.get<ActorDoc>("Actor", u.character);
    return h("li", { className: game.online.includes(u._id) ? "player online" : "player", style: { "--player-color": u.color } },
      h("span.player-dot"),
      h("span.player-name", null, u.name, u.role === "gm" ? " [GM]" : character ? ` (${character.name})` : ""));
  };

  const render = () => {
    const users = game.all<UserDoc>("User").sort((a, b) => (a.role === "gm" ? -1 : 0) - (b.role === "gm" ? -1 : 0) || a.name.localeCompare(b.name, "pt"));
    const active = users.filter(u => game.online.includes(u._id));
    const inactive = users.filter(u => !game.online.includes(u._id));
    setChildren(el, 
      expanded && inactive.length ? h("ol.players-list.inactive", null, inactive.map(row)) : null,
      h("ol.players-list", null, active.map(row)),
      h("div.perf", null,
        h("span.stat", null, "Latência ", latency),
        h("span.stat", null, "FPS ", fps),
        inactive.length ? h("button.icon.small", { title: expanded ? "Esconder offline" : "Mostrar offline", onclick: () => { expanded = !expanded; render(); } },
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
