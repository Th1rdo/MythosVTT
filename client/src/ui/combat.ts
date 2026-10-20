import type { ActorDoc, CombatAction, CombatDoc, CombatantDoc, DocResponse, TokenDoc } from "../../../shared/protocol.ts";
import { turnOrder } from "../../../shared/combat.ts";
import { game, toast } from "../game.ts";
import { avatar, h } from "../dom.ts";
import { confirmDialog, prompt } from "./windows.ts";
import { t } from "../i18n.ts";
import { openContextMenu } from "./context-menu.ts";

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
        game.isGM && h("button.icon.small", { title: "Novo encontro nesta cena", onclick: () => game.create("Combat", { sceneId: game.viewedSceneId, sort: Date.now() }) }, h("i.fa-solid.fa-plus"))
      )
    );
    // Right-click the encounter header: Foundry's tracker options.
    head.oncontextmenu = (e: MouseEvent) => {
      if (!game.isGM || !combat) return;
      openContextMenu(e, [
        { label: "Limpar iniciativas", icon: "fa-solid fa-rotate-left", onClick: () => combatAction({ action: "resetInitiative", combatId: combat._id }) },
        { label: "Terminar combate", icon: "fa-solid fa-flag-checkered", group: "end", visible: combat.round > 0,
          onClick: async () => { if (await confirmDialog(t("Terminar o combate?"), t("Terminar"))) combatAction({ action: "end", combatId: combat._id }); } },
        { label: "Apagar encontro", icon: "fa-solid fa-trash", group: "end", classes: "danger",
          onClick: async () => { if (await confirmDialog(t("Apagar este encontro?"))) game.delete("Combat", combat._id); } }
      ], combat, "Combat");
    };

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
            h("button.small", { title: "Rolar iniciativa de todos sem iniciativa", onclick: () => combatAction({ action: "rollAll", combatId: id }) }, h("i.fa-solid.fa-users"), " ", h("i.fa-solid.fa-dice-d20")),
            h("button.small", { title: "Rolar iniciativa das ameaças", onclick: () => combatAction({ action: "rollNPCs", combatId: id }) }, h("i.fa-solid.fa-users-slash"), " ", h("i.fa-solid.fa-dice-d20"))
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
  const roll = () => combatAction({ action: "rollInitiative", combatId: combat._id, combatantIds: [c._id] });
  return h("li", {
    className: ["combatant", isCurrent && "current", c.defeated && "defeated", c.hidden && "hidden"].filter(Boolean).join(" "),
    onclick: () => c.tokenId && onFocusToken(c.tokenId),
    // Right-click: Foundry's Update Combatant, Clear/Re-roll Initiative, Remove Combatant.
    oncontextmenu: (e: MouseEvent) => openContextMenu(e, [
      { label: "Editar combatente", icon: "fa-solid fa-pen-to-square", visible: game.isGM, onClick: async () => {
        const v = await prompt(t("Combatente"), [{ name: "name", label: t("Nome"), value: c.name }, { name: "initiative", label: t("Iniciativa"), value: c.initiative === null ? "" : String(c.initiative), type: "number" }]);
        if (v) game.update("Combatant", { _id: c._id, name: v.name.trim() || c.name, initiative: v.initiative === "" ? null : Number(v.initiative) }, combat._id);
      } },
      { label: "Limpar iniciativa", icon: "fa-solid fa-eraser", group: "init", visible: game.isGM && c.initiative !== null, onClick: () => game.update("Combatant", { _id: c._id, initiative: null }, combat._id) },
      { label: "Rolar iniciativa outra vez", icon: "fa-solid fa-dice-d20", group: "init", visible: game.isGM || owner, onClick: roll },
      { label: "Remover combatente", icon: "fa-solid fa-trash", group: "remove", classes: "danger", visible: game.isGM, onClick: () => game.delete("Combatant", c._id, combat._id) }
    ], c, "Combatant")
  },
    avatar(c.img ?? actor?.img, c.name, 32),
    h("span.grow.name", null, c.name),
    c.initiative === null && (owner || game.isGM)
      ? h("button.icon", { title: "Rolar iniciativa", onclick: (e: Event) => { e.stopPropagation(); roll(); } }, h("i.fa-solid.fa-dice-d20"))
      : null,
    initiative,
    game.isGM && h("button.icon.small", {
      title: c.hidden ? "Mostrar aos jogadores" : "Esconder dos jogadores",
      onclick: (e: Event) => { e.stopPropagation(); game.update("Combatant", { _id: c._id, hidden: !c.hidden }, combat._id); }
    }, h("i", { className: c.hidden ? "fa-solid fa-eye-slash" : "fa-solid fa-eye" })),
    (game.isGM || owner) && h("button.icon.small", {
      title: c.defeated ? "Não derrotado" : "Derrotado",
      onclick: (e: Event) => { e.stopPropagation(); game.update("Combatant", { _id: c._id, defeated: !c.defeated }, combat._id); }
    }, h("i", { className: c.defeated ? "fa-solid fa-skull active" : "fa-solid fa-skull" })),
    !token && h("span.tag", { title: "O token já não está na cena" }, "sem token")
  );
}
