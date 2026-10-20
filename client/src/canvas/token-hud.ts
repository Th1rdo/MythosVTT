import type { CombatantDoc, TokenDoc } from "../../../shared/protocol.ts";
import { barValue } from "../../../shared/actors.ts";
import { CONDITIONS } from "../../../shared/conditions.ts";
import { game } from "../game.ts";
import { h } from "../dom.ts";
import { refForToken, stateOf, toggleCondition, updateActor } from "../actors.ts";
import { openSheet } from "../ui/sheet.ts";
import { openTokenConfig } from "../ui/canvas-config.ts";
import { combatantsOf, sceneCombats, toggleCombat } from "../ui/combat.ts";
import type { Board } from "./board.ts";

let current: { el: HTMLElement; tokenId: string; close: () => void } | null = null;

export function closeTokenHUD(): void {
  current?.close();
}

/** Parse a bar entry: "12" sets the value, "+5" / "-3" change it. */
export function parseBarInput(text: string, value: number): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return /^[+-]/.test(t) ? value + n : n;
}

/**
 * Token HUD (right-click a token): resource bars, elevation, conditions, combat, visibility,
 * sheet and config. Positioned over the token and kept there while the view moves.
 */
export function openTokenHUD(board: Board, tokenId: string): void {
  closeTokenHUD();
  const host = board.app.canvas.parentElement!;
  const el = h("div.token-hud");
  host.append(el);
  let showConditions = false;

  const render = () => {
    const token = game.get<TokenDoc>("Token", tokenId);
    const view = board.tokens.get(tokenId);
    if (!token || !view) return close();
    const ref = refForToken(token);
    const state = ref ? stateOf(ref) : null;
    const scene = board.scene!;
    const inCombat = sceneCombats().some(c => combatantsOf(c._id).some((x: CombatantDoc) => x.tokenId === tokenId));

    const barInput = (attr: string | null, cls: string) => {
      if (!ref || !state) return null;
      const bar = barValue(state.source, attr);
      if (!bar || !attr) return null;
      const input = h("input", { className: `hud-bar ${cls}`, value: String(bar.value), title: `${attr}: ${bar.value}/${bar.max} (escreve 12, +5 ou -3)` });
      input.addEventListener("keydown", e => {
        if (e.key !== "Enter") return;
        const next = parseBarInput(input.value, bar.value);
        if (next !== null) updateActor(ref, { [`system.${attr}.value`]: next });
        input.blur();
      });
      return h("div", { className: `hud-bar-wrap ${cls}` }, input, h("span.muted.small", null, `/ ${bar.max}`));
    };

    const elevation = h("input.hud-elev", { type: "number", value: String(token.elevation ?? 0), title: "Elevação" });
    elevation.addEventListener("change", () => game.update("Token", { _id: tokenId, elevation: Number(elevation.value) || 0 }, scene._id));

    const button = (icon: string, title: string, onclick: () => void, active = false) =>
      h("button", { className: active ? "hud-btn active" : "hud-btn", title, onclick: (e: Event) => { e.stopPropagation(); onclick(); } }, icon);

    el.replaceChildren(...[
      h("div.hud-col.left", null,
        elevation,
        token.actorId && button("📄", "Ficha", () => { openSheet(token.actorId!, token.actorLink ? undefined : { tokenId, sceneId: scene._id }); close(); }),
        game.isGM && button("⚙", "Configurar token", () => { openTokenConfig(tokenId, scene._id); close(); })
      ),
      h("div.hud-col.right", null,
        button("⚔", inCombat ? "Sair do combate" : "Entrar no combate", () => toggleCombat([tokenId]), inCombat),
        ref && button("🎭", "Condições", () => { showConditions = !showConditions; render(); }, showConditions),
        game.isGM && button(token.hidden ? "🙈" : "👁", token.hidden ? "Mostrar aos jogadores" : "Esconder dos jogadores",
          () => game.update("Token", { _id: tokenId, hidden: !token.hidden }, scene._id), token.hidden)
      ),
      barInput(token.bar2.attribute, "top"),
      barInput(token.bar1.attribute, "bottom"),
      showConditions && ref && h("div.hud-conditions", null, CONDITIONS.map(c => h("button", {
        className: state?.statuses.has(c.id) ? "cond active" : "cond",
        title: c.name,
        onclick: (e: Event) => { e.stopPropagation(); toggleCondition(ref, c.id); }
      }, c.icon)))
    ].filter((n): n is HTMLDivElement => !!n));
    position();
  };

  const position = () => {
    const view = board.tokens.get(tokenId);
    if (!view) return;
    const r = board.tokenScreenRect(view);
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  };

  const offs = [
    game.on("Token", e => { if (e.ids.includes(tokenId)) e.op === "delete" ? close() : render(); }),
    game.on("Actor", render),
    game.on("ActiveEffect", render),
    game.on("Combatant", render),
    board.on("scene", () => close()),
    board.on("tool", () => close())
  ];
  const tick = () => position();
  board.app.ticker.add(tick);
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  setTimeout(() => window.addEventListener("pointerdown", onDown, true));
  window.addEventListener("keydown", onKey);

  function close() {
    for (const off of offs) off();
    board.app.ticker.remove(tick);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey);
    el.remove();
    if (current?.el === el) current = null;
  }
  current = { el, tokenId, close };
  render();
}
