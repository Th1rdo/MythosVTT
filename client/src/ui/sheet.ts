import type { ActorDoc, EffectData, ItemDoc, UserDoc } from "../../../shared/protocol.ts";
import { OWNERSHIP } from "../../../shared/protocol.ts";
import { opTestFormula } from "../../../shared/dice.ts";
import { ATTRIBUTES, DEGREES, ITEM_TYPES, SKILL_LABELS, isOrdemActor, skillBonus, skillFormula } from "../../../shared/ordem.ts";
import { game, toast } from "../game.ts";
import { avatar, h, safeHtml } from "../dom.ts";
import { browseFiles } from "./file-picker.ts";
import type { ActorRef } from "../actors.ts";
import { deleteEffect, ownEffects, saveEffect, stateOf, tokenOf, updateActor } from "../actors.ts";
import { closeWindow, openWindow, setWindowTitle } from "./windows.ts";
import { PACK_DRAG, packAction } from "./compendia.ts";
import { openItemSheet, rollItem, useItem } from "./item-sheet.ts";
import { openEffectConfig } from "./effect-config.ts";
import { openPrototypeConfig } from "./canvas-config.ts";

const RESOURCES: [key: string, label: string][] = [["PV", "PV"], ["SAN", "SAN"], ["PE", "PE"], ["PD", "PD"]];
const OWNERSHIP_LABELS: [number, string][] = [
  [OWNERSHIP.NONE, "Nenhum"], [OWNERSHIP.LIMITED, "Limitado"], [OWNERSHIP.OBSERVER, "Observador"], [OWNERSHIP.OWNER, "Dono"]
];
export const ITEM_DRAG = "application/x-mesa-item";

/**
 * Actor sheet. Opened for an actor, or for an unlinked token (pass `token`), in which case edits go
 * to that token's delta and the base actor is untouched.
 */
export function openSheet(actorId: string, token?: { tokenId: string; sceneId: string }): void {
  const ref: ActorRef = { actorId, token };
  const key = token ? `token-actor-${token.tokenId}` : `actor-${actorId}`;
  const state = stateOf(ref);
  if (!state) return;
  let pending = false;
  let off = () => {};
  const body = openWindow(key, state.source.name, { width: 720, onClose: () => off() });
  if (!body) return;

  const render = () => {
    const s = stateOf(ref);
    if (!s) return closeWindow(key);
    setWindowTitle(key, s.source.name + (token ? " (token)" : ""));
    body.replaceChildren(isOrdemActor(s.source) ? ordemSheet(ref) : genericSheet(ref));
  };
  const refresh = () => {
    // Don't yank an input out from under the user while they type.
    if (body.contains(document.activeElement) && document.activeElement !== body) pending = true;
    else render();
  };
  body.addEventListener("focusout", () => {
    if (pending) {
      pending = false;
      setTimeout(render);
    }
  });
  // Drop items (from the Items directory or another sheet) to give them to this actor.
  body.addEventListener("dragover", e => {
    if (e.dataTransfer?.types.includes(ITEM_DRAG) || e.dataTransfer?.types.includes(PACK_DRAG)) e.preventDefault();
  });
  body.addEventListener("drop", async e => {
    // An item from a compendium: the server copies it into this actor.
    const fromPack = e.dataTransfer?.getData(PACK_DRAG);
    if (fromPack) {
      e.preventDefault();
      const { packId, entryId, type } = JSON.parse(fromPack) as { packId: string; entryId: string; type: string };
      if (type !== "Item") return toast("Só itens podem ir para uma ficha", "error");
      await packAction({ action: "importToActor", packId, entryId, actorId });
      return;
    }
    const raw = e.dataTransfer?.getData(ITEM_DRAG);
    if (!raw) return;
    e.preventDefault();
    const { id } = JSON.parse(raw) as { id: string };
    const item = game.get<ItemDoc>("Item", id);
    if (!item || item._parent === actorId) return;
    await game.create("Item", { name: item.name, type: item.type, img: item.img, system: structuredClone(item.system) }, actorId).catch(() => {});
  });

  const relevant = (ids: string[], docs: { _parent?: string }[]) => ids.includes(actorId) || docs.some(d => d._parent === actorId);
  const offs = [
    game.on("Actor", e => (e.op === "delete" && e.ids.includes(actorId) ? closeWindow(key) : relevant(e.ids, e.docs) && refresh())),
    game.on("Item", e => relevant([], e.docs) && refresh()),
    game.on("ActiveEffect", e => relevant([], e.docs) && refresh()),
    game.on("Token", e => token && e.ids.includes(token.tokenId) && (e.op === "delete" ? closeWindow(key) : refresh()))
  ];
  off = () => offs.forEach(o => o());
  render();
}

function canEdit(ref: ActorRef): boolean {
  return game.owns(game.get<ActorDoc>("Actor", ref.actorId));
}

function numberInput(ref: ActorRef, path: string, value: unknown, editable: boolean, cls = ""): HTMLInputElement {
  return h("input", {
    type: "number", value: String(value ?? 0), disabled: !editable, className: cls,
    onchange: (e: Event) => updateActor(ref, { [path]: Number((e.target as HTMLInputElement).value) || 0 })
  });
}

/** Shows "→ 13" next to a value when effects change it. */
function derivedBadge(source: unknown, derived: unknown): HTMLElement | null {
  return source !== derived && derived !== undefined ? h("span.derived", { title: "Valor com efeitos" }, `→ ${derived}`) : null;
}

function header(ref: ActorRef, actor: ActorDoc, editable: boolean): HTMLElement {
  const img = avatar(actor.img, actor.name, 84);
  if (game.isGM) {
    img.classList.add("clickable");
    img.title = "Mudar imagem";
    img.addEventListener("click", async () => {
      const path = await browseFiles("image", actor.img);
      if (!path) return;
      await updateActor(ref, ref.token ? { img: path } : { img: path, "token.img": path });
    });
  }
  return h("div.sheet-head", null,
    img,
    h("div.stack.grow", null,
      h("input.title-input", {
        value: actor.name, disabled: !editable,
        onchange: (e: Event) => updateActor(ref, { name: (e.target as HTMLInputElement).value.trim() || actor.name })
      }),
      h("div.row.muted.small", null,
        actor.type,
        ref.token && h("span.tag", { title: "Token não ligado: as alterações ficam só neste token" }, "cópia do token"),
        game.isGM && !ref.token && h("button.small", { onclick: () => openPrototypeConfig(actor._id) }, "Token…")
      )
    )
  );
}

function ordemSheet(ref: ActorRef): HTMLElement {
  const st = stateOf(ref)!;
  const actor = st.source;
  const d = st.derived.system;
  const s = actor.system;
  const editable = canEdit(ref);
  const speaker = { actor: ref.actorId, alias: actor.name };

  const resources = h("div.resources", null,
    RESOURCES.filter(([k]) => s[k]).map(([k, label]) => h("div.resource", { dataset: { res: k } },
      h("span.res-label", null, label),
      h("div.row", null,
        numberInput(ref, `system.${k}.value`, s[k].value, editable, "res-value"),
        h("span.muted", null, "/"),
        numberInput(ref, `system.${k}.max`, s[k].max, editable, "res-max"),
        derivedBadge(s[k].max, d[k]?.max))
    ))
  );

  const stat = (label: string, path: string, src: any, der: any) =>
    src && h("label.stat", null, h("span", null, label), numberInput(ref, `system.${path}.value`, src.value, editable), derivedBadge(src.value, der?.value));
  const stats = h("div.row.wrap.stats", null,
    stat("NEX %", "NEX", s.NEX, d.NEX),
    stat("Defesa", "defense", s.defense, d.defense),
    stat("Desloc. (m)", "desloc", s.desloc, d.desloc)
  );

  const attributes = h("div.attributes", null,
    ATTRIBUTES.filter(([k]) => s.attributes?.[k]).map(([k, label]) => {
      const value = Number(s.attributes[k].value) || 0;
      const rolled = Number(d.attributes?.[k]?.value) || 0;
      const formula = opTestFormula(rolled, 0);
      return h("div.attribute", null,
        h("button.attr-roll", { title: `Rolar ${label} (${formula})`, onclick: () => game.roll({ formula, flavor: `Teste de ${label}`, speaker }) }, label),
        numberInput(ref, `system.attributes.${k}.value`, value, editable, "attr-value"),
        derivedBadge(value, rolled)
      );
    })
  );

  const skills = h("div.skills", null,
    Object.entries((s.skills ?? {}) as Record<string, any>).map(([key, skill]) => {
      const attrKey = Array.isArray(skill.attr) ? skill.attr[0] : skill.attr;
      const attrLabel = ATTRIBUTES.find(([k]) => k === attrKey)?.[1] ?? "—";
      const bonus = skillBonus(d.skills?.[key] ?? skill);
      const name = SKILL_LABELS[key] ?? key;
      const formula = skillFormula(st.derived, key);
      return h("div.skill", null,
        h("button.link", { title: formula, onclick: () => game.roll({ formula, flavor: name, speaker }) }, name),
        h("span.muted.small", null, attrLabel),
        h("select", {
          disabled: !editable,
          onchange: (e: Event) => updateActor(ref, { [`system.skills.${key}.degree.label`]: (e.target as HTMLSelectElement).value })
        }, DEGREES.map(([label, text]) => h("option", { value: label, selected: skill?.degree?.label === label }, text))),
        h("span.bonus", null, bonus >= 0 ? `+${bonus}` : String(bonus))
      );
    })
  );

  const bio = s.biography ? h("div.stack", null, h("h4", null, "Biografia"), h("div.prose", null, safeHtml(String(s.biography)))) : null;

  return h("div.sheet", null,
    header(ref, actor, editable),
    resources,
    stats,
    h("h4", null, "Atributos"),
    attributes,
    h("h4", null, "Perícias"),
    skills,
    inventory(ref, st.derived, editable),
    effectsSection(ref, st.effects, editable),
    bio,
    game.isGM && !ref.token && ownershipEditor(actor)
  );
}

function inventory(ref: ActorRef, derived: ActorDoc, editable: boolean): HTMLElement {
  const items = game.children<ItemDoc>("Item", ref.actorId).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "pt"));
  const spaces = items.reduce((sum, i) => sum + (Number(i.system?.weight) || 0) * (Number(i.system?.quantity) || 1), 0);
  const groups = ITEM_TYPES.map(([type, label]) => [label, items.filter(i => i.type === type)] as const)
    .concat([["Outros", items.filter(i => !ITEM_TYPES.some(([t]) => t === i.type))]])
    .filter(([, list]) => list.length);
  return h("div.stack", null,
    h("div.row", null,
      h("h4.grow", null, "Inventário"),
      h("span.muted.small", null, `Espaços usados: ${spaces}`),
      editable && h("button.small", {
        onclick: async () => {
          const [item] = await game.create<ItemDoc>("Item", { name: "Novo item", type: "generalEquipment" }, ref.actorId);
          if (item) openItemSheet(item._id);
        }
      }, "+ Item")
    ),
    ref.token && h("p.muted.small", null, "Os itens pertencem ao ator base (partilhados por todos os seus tokens)."),
    groups.length
      ? groups.map(([label, list]) => h("div.item-group", null,
          h("div.muted.small", null, label),
          h("ul.item-list", null, list.map(i => h("li", {
            draggable: true,
            ondragstart: (e: DragEvent) => e.dataTransfer?.setData(ITEM_DRAG, JSON.stringify({ id: i._id }))
          },
            avatar(i.img, i.name, 24),
            h("button.link.grow", { onclick: () => openItemSheet(i._id) }, i.name),
            Number(i.system?.quantity) > 1 && h("span.muted.small", null, `×${i.system.quantity}`),
            i.type === "armament" && h("button.small", { title: "Ataque", onclick: () => rollItem(i, derived, "attack") }, "🎯"),
            i.type === "armament" && h("button.small", { title: "Dano", onclick: () => rollItem(i, derived, "damage") }, "💥"),
            (i.type === "ritual" || i.type === "ability") && h("button.small", { title: "Usar (mostrar no chat)", onclick: () => useItem(i, derived) }, "✦"),
            editable && h("button.icon.small", { title: "Apagar", onclick: () => game.delete("Item", i._id, ref.actorId) }, "✕")
          )))
        ))
      : h("p.muted", null, "Sem itens. Arrasta itens do separador Itens para aqui.")
  );
}

function effectsSection(ref: ActorRef, all: EffectData[], editable: boolean): HTMLElement {
  const own = new Set(ownEffects(ref).map(e => e._id));
  return h("div.stack", null,
    h("div.row", null,
      h("h4.grow", null, "Efeitos"),
      editable && h("button.small", { onclick: () => openEffectConfig(ref, null) }, "+ Efeito")
    ),
    all.length
      ? h("ul.item-list", null, all.map(e => h("li", { className: e.disabled ? "disabled" : "" },
          h("span.effect-icon", null, e.icon.length <= 4 ? e.icon : "✨"),
          h("button.link.grow", { disabled: !own.has(e._id), onclick: () => openEffectConfig(ref, e._id) }, e.name),
          e.duration?.rounds ? h("span.muted.small", null, `${e.duration.rounds} rondas`) : null,
          !own.has(e._id) && h("span.tag", { title: "Vem do ator base" }, "base"),
          editable && own.has(e._id) && h("button.icon.small", {
            title: e.disabled ? "Ativar" : "Desativar",
            onclick: () => saveEffect(ref, { ...e, disabled: !e.disabled })
          }, e.disabled ? "○" : "●"),
          editable && own.has(e._id) && h("button.icon.small", { title: "Apagar", onclick: () => deleteEffect(ref, e._id) }, "✕")
        )))
      : h("p.muted", null, "Sem efeitos.")
  );
}

function genericSheet(ref: ActorRef): HTMLElement {
  const st = stateOf(ref)!;
  const actor = st.source;
  const editable = canEdit(ref);
  const area = h("textarea.code", { rows: 18, disabled: !game.isGM }, JSON.stringify(actor.system, null, 2));
  return h("div.sheet", null,
    header(ref, actor, editable),
    h("p.muted", null, "Ficha genérica — dados do sistema em JSON."),
    area,
    game.isGM && h("div.row.end", null, h("button.primary", {
      onclick: () => {
        try {
          // Unlinked tokens store the whole system object in their delta.
          const system = JSON.parse(area.value);
          if (tokenOf(ref)) updateActor(ref, { system });
          else game.update("Actor", { _id: actor._id, system });
        } catch {
          toast("JSON inválido", "error");
        }
      }
    }, "Guardar")),
    inventory(ref, st.derived, editable),
    effectsSection(ref, st.effects, editable),
    game.isGM && !ref.token && ownershipEditor(actor)
  );
}

/** GM-only: who can see / control a document. */
export function ownershipEditor(
  doc: { _id: string; _parent?: string; ownership: Record<string, number | null> },
  type: "Actor" | "JournalEntry" | "Item" | "Cards" = "Actor"
): HTMLElement {
  const players = game.all<UserDoc>("User").filter(u => u.role !== "gm");
  // Per-user entries can be "Padrão" (null), which falls back to the default level.
  const select = (key: string, value: number | null, allowDefault: boolean) => h("select", {
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      game.update(type, { _id: doc._id, [`ownership.${key}`]: v === "" ? null : Number(v) }, doc._parent);
    }
  },
    allowDefault && h("option", { value: "", selected: value === null }, "Padrão"),
    OWNERSHIP_LABELS.map(([v, label]) => h("option", { value: String(v), selected: v === value }, label)));
  return h("details.ownership", null,
    h("summary", null, "Permissões"),
    h("div.grid2", null,
      h("span", null, "Todos"), select("default", doc.ownership.default ?? 0, false),
      players.flatMap(u => [h("span", null, u.name), select(u._id, doc.ownership[u._id] ?? null, true)])
    )
  );
}
