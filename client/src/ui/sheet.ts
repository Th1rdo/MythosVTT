import type { ActorDoc, ItemDoc, UserDoc } from "../../../shared/protocol.ts";
import { OWNERSHIP } from "../../../shared/protocol.ts";
import { opTestFormula } from "../../../shared/dice.ts";
import { game, toast } from "../game.ts";
import { avatar, h, pickFile, safeHtml, upload } from "../dom.ts";
import { closeWindow, openWindow, setWindowTitle } from "./windows.ts";

// Ordem Paranormal labels (pt-PT). Keys match the ordemparanormal Foundry system's data.
const ATTRIBUTES: [key: string, label: string][] = [
  ["dex", "AGI"], ["str", "FOR"], ["int", "INT"], ["pre", "PRE"], ["vit", "VIG"]
];
const SKILLS: Record<string, string> = {
  acrobatics: "Acrobacia", animal: "Adestramento", arts: "Artes", athleticism: "Atletismo", relevance: "Atualidades",
  sciences: "Ciências", crime: "Crime", diplomacy: "Diplomacia", deception: "Enganação", resilience: "Fortitude",
  stealth: "Furtividade", initiative: "Iniciativa", intimidation: "Intimidação", intuition: "Intuição",
  investigation: "Investigação", fighting: "Luta", medicine: "Medicina", occultism: "Ocultismo", perception: "Percepção",
  driving: "Pilotagem", aim: "Pontaria", reflexes: "Reflexos", religion: "Religião", survival: "Sobrevivência",
  tactics: "Tática", technology: "Tecnologia", will: "Vontade", freeSkill: "Perícia livre"
};
const DEGREES: [label: string, name: string, bonus: number][] = [
  ["untrained", "Destreinado", 0], ["trained", "Treinado", 5], ["veteran", "Veterano", 10], ["expert", "Expert", 15]
];
const RESOURCES: [key: string, label: string][] = [["PV", "PV"], ["SAN", "SAN"], ["PE", "PE"], ["PD", "PD"]];
const OWNERSHIP_LABELS: [number, string][] = [
  [OWNERSHIP.NONE, "Nenhum"], [OWNERSHIP.LIMITED, "Limitado"], [OWNERSHIP.OBSERVER, "Observador"], [OWNERSHIP.OWNER, "Dono"]
];

function isOrdem(actor: ActorDoc): boolean {
  return !!actor.system?.attributes && !!actor.system?.skills;
}

export function skillBonus(skill: any): number {
  const degree = DEGREES.find(d => d[0] === skill?.degree?.label)?.[2] ?? 0;
  return degree + (Number(skill?.mod) || 0) + (Number(skill?.value) || 0);
}

export function openSheet(actorId: string): void {
  const key = `actor-${actorId}`;
  const actor = game.get<ActorDoc>("Actor", actorId);
  if (!actor) return;
  let pending = false;
  let off = () => {};
  const body = openWindow(key, actor.name, { width: 700, onClose: () => off() });
  if (!body) return;

  const render = () => {
    const a = game.get<ActorDoc>("Actor", actorId);
    if (!a) return closeWindow(key);
    setWindowTitle(key, a.name);
    body.replaceChildren(isOrdem(a) ? ordemSheet(a) : genericSheet(a));
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
  const offActor = game.on("Actor", e => {
    if (e.op === "delete" && e.ids.includes(actorId)) closeWindow(key);
    else if (e.ids.includes(actorId)) refresh();
  });
  const offItem = game.on("Item", e => {
    if (e.docs.some(d => d._parent === actorId)) refresh();
  });
  off = () => {
    offActor();
    offItem();
  };
  render();
}

function update(actor: ActorDoc, path: string, value: unknown): void {
  game.update("Actor", { _id: actor._id, [path]: value });
}

function numberInput(actor: ActorDoc, path: string, value: unknown, editable: boolean, cls = ""): HTMLInputElement {
  return h("input", {
    type: "number", value: String(value ?? 0), disabled: !editable, className: cls,
    onchange: (e: Event) => update(actor, path, Number((e.target as HTMLInputElement).value) || 0)
  });
}

function header(actor: ActorDoc, editable: boolean): HTMLElement {
  const img = avatar(actor.img, actor.name, 84);
  if (game.isGM) {
    img.classList.add("clickable");
    img.title = "Mudar imagem";
    img.addEventListener("click", async () => {
      const file = await pickFile("image/*");
      if (!file) return;
      try {
        const path = await upload(file);
        game.update("Actor", { _id: actor._id, img: path, "token.img": path });
      } catch (err) {
        toast((err as Error).message, "error");
      }
    });
  }
  return h("div.sheet-head", null,
    img,
    h("div.stack.grow", null,
      h("input.title-input", {
        value: actor.name, disabled: !editable,
        onchange: (e: Event) => update(actor, "name", (e.target as HTMLInputElement).value.trim() || actor.name)
      }),
      h("div.muted", null, actor.type)
    )
  );
}

function ordemSheet(actor: ActorDoc): HTMLElement {
  const s = actor.system;
  const editable = game.owns(actor);
  const speaker = { actor: actor._id, alias: actor.name };

  const resources = h("div.resources", null,
    RESOURCES.filter(([k]) => s[k]).map(([k, label]) => h("div.resource", { dataset: { res: k } },
      h("span.res-label", null, label),
      h("div.row", null,
        numberInput(actor, `system.${k}.value`, s[k].value, editable, "res-value"),
        h("span.muted", null, "/"),
        numberInput(actor, `system.${k}.max`, s[k].max, editable, "res-max"))
    ))
  );

  const stats = h("div.row.wrap.stats", null,
    s.NEX && h("label.stat", null, h("span", null, "NEX %"), numberInput(actor, "system.NEX.value", s.NEX.value, editable)),
    s.defense && h("label.stat", null, h("span", null, "Defesa"), numberInput(actor, "system.defense.value", s.defense.value, editable)),
    s.desloc && h("label.stat", null, h("span", null, "Desloc. (m)"), numberInput(actor, "system.desloc.value", s.desloc.value, editable))
  );

  const attributes = h("div.attributes", null,
    ATTRIBUTES.filter(([k]) => s.attributes[k]).map(([k, label]) => {
      const value = Number(s.attributes[k].value) || 0;
      return h("div.attribute", null,
        h("button.attr-roll", {
          title: `Rolar ${label} (${opTestFormula(value, 0)})`,
          onclick: () => game.roll({ formula: opTestFormula(value, 0), flavor: `Teste de ${label}`, speaker })
        }, label),
        numberInput(actor, `system.attributes.${k}.value`, value, editable, "attr-value")
      );
    })
  );

  const skills = h("div.skills", null,
    Object.entries(s.skills as Record<string, any>).map(([key, skill]) => {
      const attrKey = Array.isArray(skill.attr) ? skill.attr[0] : skill.attr;
      const attrLabel = ATTRIBUTES.find(([k]) => k === attrKey)?.[1] ?? "—";
      const attrValue = Number(s.attributes?.[attrKey]?.value) || 0;
      const bonus = skillBonus(skill);
      const name = SKILLS[key] ?? key;
      const formula = opTestFormula(attrValue, bonus);
      return h("div.skill", null,
        h("button.link", { title: formula, onclick: () => game.roll({ formula, flavor: name, speaker }) }, name),
        h("span.muted.small", null, attrLabel),
        h("select", {
          disabled: !editable,
          onchange: (e: Event) => update(actor, `system.skills.${key}.degree.label`, (e.target as HTMLSelectElement).value)
        }, DEGREES.map(([label, text]) => h("option", { value: label, selected: skill?.degree?.label === label }, text))),
        h("span.bonus", null, bonus >= 0 ? `+${bonus}` : String(bonus))
      );
    })
  );

  const items = game.children<ItemDoc>("Item", actor._id);
  const inventory = h("div.stack", null,
    h("h4", null, "Inventário"),
    items.length
      ? h("ul.item-list", null, items.map(i => h("li", null, avatar(i.img, i.name, 24), h("span.grow", null, i.name), h("span.muted.small", null, i.type))))
      : h("p.muted", null, "Sem itens.")
  );

  const bio = s.biography ? h("div.stack", null, h("h4", null, "Biografia"), h("div.prose", null, safeHtml(String(s.biography)))) : null;

  return h("div.sheet", null,
    header(actor, editable),
    resources,
    stats,
    h("h4", null, "Atributos"),
    attributes,
    h("h4", null, "Perícias"),
    skills,
    inventory,
    bio,
    game.isGM && ownershipEditor(actor)
  );
}

function genericSheet(actor: ActorDoc): HTMLElement {
  const editable = game.owns(actor);
  const area = h("textarea.code", { rows: 18, disabled: !game.isGM }, JSON.stringify(actor.system, null, 2));
  return h("div.sheet", null,
    header(actor, editable),
    h("p.muted", null, "Ficha genérica — dados do sistema em JSON."),
    area,
    game.isGM && h("div.row.end", null, h("button.primary", {
      onclick: () => {
        try {
          game.update("Actor", { _id: actor._id, system: JSON.parse(area.value) });
        } catch {
          toast("JSON inválido", "error");
        }
      }
    }, "Guardar")),
    game.isGM && ownershipEditor(actor)
  );
}

/** GM-only: who can see / control this actor. */
export function ownershipEditor(doc: { _id: string; ownership: Record<string, number | null> }, type: "Actor" | "JournalEntry" = "Actor"): HTMLElement {
  const players = game.all<UserDoc>("User").filter(u => u.role !== "gm");
  // Per-user entries can be "Padrão" (null), which falls back to the default level.
  const select = (key: string, value: number | null, allowDefault: boolean) => h("select", {
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      game.update(type, { _id: doc._id, [`ownership.${key}`]: v === "" ? null : Number(v) });
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
