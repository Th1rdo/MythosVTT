import type { ActorDoc, CombatAction, CombatDoc, CombatantDoc, DocResponse, TokenDoc } from "../../../shared/protocol.ts";
import { turnOrder } from "../../../shared/combat.ts";
import { game, toast } from "../game.ts";
import { avatar, h } from "../dom.ts";
import { confirmDialog } from "./windows.ts";

export async function combatAction(action: CombatAction): Promise<boolean> {
  const res: DocResponse = await game.socket.timeout(10_000).emitWithAck("combat", action);
  if (!res.ok) toast(res.error, "error");
  return res.ok;
}

/** Encounters for the scene being viewed, oldest first. */
export function sceneCombats(): CombatDoc[] {
  return game.all<CombatDoc>("Combat").filter(c => c.sceneId === game.viewedSceneId).sort((a, b) => a.sort - b.sort || (a._id > b._id ? 1 : -1));
}

/** The encounter shown in the tracker (and used for the turn marker). */
let selectedCombatId: string | null = null;
export function viewedCombat(): CombatDoc | undefined {
  const list = sceneCombats();
  return list.find(c => c._id === selectedCombatId) ?? list[0];
}

export function combatantsOf(combatId: string): CombatantDoc[] {
  return game.children<CombatantDoc>("Combatant", combatId);
}

/** Toggle tokens in/out of the scene's encounter. */
export function toggleCombat(tokenIds: string[]): void {
  if (game.viewedSceneId) combatAction({ action: "toggleTokens", sceneId: game.viewedSceneId, tokenIds });
}

export function combatPanel(onFocusToken: (tokenId: string) => void): HTMLElement {
  const head = h("div.combat-head");
  const list = h("ol.combat-list");
  const foot = h("div.combat-foot");

  const render = () => {
    const combats = sceneCombats();
    const combat = viewedCombat();
    selectedCombatId = combat?._id ?? null;
    head.replaceChildren(
      h("div.row", null,
        combats.length > 1
          ? h("select", { onchange: (e: Event) => { selectedCombatId = (e.target as HTMLSelectElement).value; render(); } },
              combats.map((c, i) => h("option", { value: c._id, selected: c._id === combat?._id }, `Encontro ${i + 1}`)))
          : h("strong.grow", null, combat ? "Encontro" : "Sem combate"),
        combats.length > 1 && h("span.grow"),
        combat && h("span.round", null, combat.round ? `Ronda ${combat.round}` : "Por começar"),
        game.isGM && h("button.icon.small", { title: "Novo encontro nesta cena", onclick: () => game.create("Combat", { sceneId: game.viewedSceneId, sort: Date.now() }) }, "＋"),
        game.isGM && combat && h("button.icon.small", {
          title: "Apagar encontro",
          onclick: async () => { if (await confirmDialog("Apagar este encontro?")) game.delete("Combat", combat._id); }
        }, "✕")
      )
    );

    if (!combat) {
      list.replaceChildren(h("li.muted.empty", null, game.isGM
        ? "Seleciona tokens no mapa e carrega em C, ou cria um encontro com ＋."
        : "Não há combate nesta cena."));
      foot.replaceChildren();
      return;
    }

    const order = turnOrder(combatantsOf(combat._id));
    list.replaceChildren(...order.map(c => combatantRow(combat, c, onFocusToken)));
    if (!order.length) list.append(h("li.muted.empty", null, "Sem combatentes. Seleciona tokens e carrega em C."));

    const id = combat._id;
    const current = order.find(c => c._id === combat.current);
    const myTurn = !!current && game.owns(game.get<ActorDoc>("Actor", current.actorId));
    foot.replaceChildren(...(game.isGM
      ? [
          h("div.row.wrap", null,
            h("button.small", { title: "Rolar iniciativa de todos sem iniciativa", onclick: () => combatAction({ action: "rollAll", combatId: id }) }, "🎲 Todos"),
            h("button.small", { title: "Rolar iniciativa das ameaças", onclick: () => combatAction({ action: "rollNPCs", combatId: id }) }, "🎲 Ameaças"),
            h("button.small", { title: "Limpar iniciativas", onclick: () => combatAction({ action: "resetInitiative", combatId: id }) }, "↺")
          ),
          combat.round === 0
            ? h("button.primary", { onclick: () => combatAction({ action: "start", combatId: id }) }, "Iniciar combate")
            : h("div.row.turn-controls", null,
                h("button", { title: "Ronda anterior", onclick: () => combatAction({ action: "previousRound", combatId: id }) }, "⏮"),
                h("button", { title: "Turno anterior", onclick: () => combatAction({ action: "previousTurn", combatId: id }) }, "◀"),
                h("button.grow.danger", { onclick: async () => { if (await confirmDialog("Terminar o combate?")) combatAction({ action: "end", combatId: id }); } }, "Terminar"),
                h("button", { title: "Próximo turno", onclick: () => combatAction({ action: "nextTurn", combatId: id }) }, "▶"),
                h("button", { title: "Próxima ronda", onclick: () => combatAction({ action: "nextRound", combatId: id }) }, "⏭"))
        ]
      : myTurn ? [h("button.primary", { onclick: () => combatAction({ action: "nextTurn", combatId: id }) }, "Terminar o meu turno")] : []));
  };

  for (const t of ["Combat", "Combatant", "Actor"] as const) game.on(t, render);
  game.on("view", render);
  game.on("ready", render);
  render();
  return h("div.panel.combat", null, head, list, foot);
}

function combatantRow(combat: CombatDoc, c: CombatantDoc, onFocusToken: (tokenId: string) => void): HTMLElement {
  const actor = game.get<ActorDoc>("Actor", c.actorId);
  const owner = game.owns(actor);
  const token = game.get<TokenDoc>("Token", c.tokenId);
  const isCurrent = combat.current === c._id && combat.round > 0;
  const initiative = game.isGM
    ? h("input.init", {
        type: "number", value: c.initiative ?? "", placeholder: "—",
        onclick: (e: Event) => e.stopPropagation(),
        onchange: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          game.update("Combatant", { _id: c._id, initiative: v === "" ? null : Number(v) }, combat._id);
        }
      })
    : h("span.init", null, String(c.initiative ?? "—"));
  return h("li", {
    className: ["combatant", isCurrent && "current", c.defeated && "defeated", c.hidden && "hidden"].filter(Boolean).join(" "),
    onclick: () => c.tokenId && onFocusToken(c.tokenId)
  },
    avatar(c.img ?? actor?.img, c.name, 32),
    h("span.grow.name", null, c.name),
    c.initiative === null && (owner || game.isGM)
      ? h("button.icon", { title: "Rolar iniciativa", onclick: (e: Event) => { e.stopPropagation(); combatAction({ action: "rollInitiative", combatId: combat._id, combatantIds: [c._id] }); } }, "🎲")
      : null,
    initiative,
    game.isGM && h("button.icon.small", {
      title: c.hidden ? "Mostrar aos jogadores" : "Esconder dos jogadores",
      onclick: (e: Event) => { e.stopPropagation(); game.update("Combatant", { _id: c._id, hidden: !c.hidden }, combat._id); }
    }, c.hidden ? "🙈" : "👁"),
    (game.isGM || owner) && h("button.icon.small", {
      title: c.defeated ? "Não derrotado" : "Derrotado",
      onclick: (e: Event) => { e.stopPropagation(); game.update("Combatant", { _id: c._id, defeated: !c.defeated }, combat._id); }
    }, c.defeated ? "☠" : "♡"),
    game.isGM && h("button.icon.small", {
      title: "Remover do combate",
      onclick: (e: Event) => { e.stopPropagation(); game.delete("Combatant", c._id, combat._id); }
    }, "✕"),
    !token && h("span.tag", { title: "O token já não está na cena" }, "sem token")
  );
}
