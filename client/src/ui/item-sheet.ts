import type { ActorDoc, ItemDoc } from "../../../shared/protocol.ts";
import { ITEM_TYPES, SKILL_LABELS, itemTemplate, skillFormula } from "../../../shared/ordem.ts";
import { parseFormula } from "../../../shared/dice.ts";
import { game, toast } from "../game.ts";
import { avatar, h, safeHtml } from "../dom.ts";
import { browseFiles } from "./file-picker.ts";
import { closeWindow, openWindow, setWindowTitle } from "./windows.ts";
import { ownershipEditor } from "./sheet.ts";

function canEditItem(item: ItemDoc): boolean {
  if (game.isGM) return true;
  return !!item._parent && game.owns(game.get<ActorDoc>("Actor", item._parent));
}

function save(item: ItemDoc, changes: Record<string, unknown>): void {
  game.update("Item", { _id: item._id, ...changes }, item._parent);
}

/** Item sheet with fields per Ordem Paranormal item type; anything else gets a JSON editor. */
export function openItemSheet(itemId: string): void {
  const key = `item-${itemId}`;
  const item = game.get<ItemDoc>("Item", itemId);
  if (!item) return;
  let off = () => {};
  let pending = false;
  const body = openWindow(key, item.name, { width: 460, onClose: () => off() });
  if (!body) return;

  const render = () => {
    const it = game.get<ItemDoc>("Item", itemId);
    if (!it) return closeWindow(key);
    setWindowTitle(key, it.name);
    body.replaceChildren(itemForm(it));
  };
  body.addEventListener("focusout", () => {
    if (pending) {
      pending = false;
      setTimeout(render);
    }
  });
  off = game.on("Item", e => {
    if (!e.ids.includes(itemId)) return;
    if (e.op === "delete") return closeWindow(key);
    if (body.contains(document.activeElement)) pending = true;
    else render();
  });
  render();
}

function itemForm(item: ItemDoc): HTMLElement {
  const editable = canEditItem(item);
  const s = item.system ?? {};
  const text = (label: string, path: string, value: unknown, attrs: Record<string, unknown> = {}) =>
    h("label.field", null, h("span", null, label), h("input", {
      value: value == null ? "" : String(value), disabled: !editable, ...attrs,
      onchange: (e: Event) => {
        const raw = (e.target as HTMLInputElement).value;
        save(item, { [path]: attrs.type === "number" ? Number(raw) || 0 : raw });
      }
    }));
  const select = (label: string, path: string, value: string, options: [string, string][]) =>
    h("label.field", null, h("span", null, label), h("select", {
      disabled: !editable,
      onchange: (e: Event) => save(item, { [path]: (e.target as HTMLSelectElement).value })
    }, options.map(([v, l]) => h("option", { value: v, selected: v === value }, l))));

  const img = avatar(item.img, item.name, 64);
  if (editable) {
    img.classList.add("clickable");
    img.title = "Mudar imagem";
    img.addEventListener("click", async () => {
      const chosen = await browseFiles("image", item.img);
      if (chosen) save(item, { img: chosen });
    });
  }

  const typeFields: (HTMLElement | null)[] = [];
  switch (item.type) {
    case "armament":
      typeFields.push(
        h("div.row", null,
          select("Perícia de ataque", "system.formulas.attack.skill", s.formulas?.attack?.skill ?? "fighting",
            [["fighting", SKILL_LABELS.fighting], ["aim", SKILL_LABELS.aim], ["", "—"]]),
          text("Bónus de ataque", "system.formulas.attack.bonus", s.formulas?.attack?.bonus, { placeholder: "0" })),
        h("div.row", null,
          text("Dano", "system.formulas.damage.formula", s.formulas?.damage?.formula, { placeholder: "1d8" }),
          text("Bónus de dano", "system.formulas.damage.bonus", s.formulas?.damage?.bonus, { placeholder: "0" }),
          text("Tipo de dano", "system.formulas.damage.type", s.formulas?.damage?.type)),
        h("div.row", null, text("Crítico", "system.critical", s.critical, { placeholder: "19/x3" }), text("Alcance", "system.range", s.range))
      );
      break;
    case "protection":
      typeFields.push(h("div.row", null, text("Defesa", "system.defense", s.defense, { type: "number" }), text("Penalidade", "system.penalty", s.penalty)));
      break;
    case "ritual":
      typeFields.push(
        h("div.row", null, text("Círculo", "system.circle", s.circle, { type: "number", min: 1, max: 4 }), text("Elemento", "system.element", s.element)),
        h("div.row", null, text("Execução", "system.execution", s.execution), text("Alcance", "system.range", s.range)),
        h("div.row", null, text("Alvo", "system.target", s.target), text("Duração", "system.duration", s.duration)),
        text("Resistência", "system.resistance", s.resistance)
      );
      break;
    case "ability":
      typeFields.push(h("div.row", null, text("Tipo", "system.abilityType", s.abilityType), text("Pré-requisito", "system.preRequisite", s.preRequisite)));
      break;
  }
  const carried = ["armament", "protection", "generalEquipment"].includes(item.type);
  const description = h("div.prose.journal", { contentEditable: editable ? "true" : "false" }, safeHtml(String(s.description ?? "")));
  if (editable) description.addEventListener("blur", () => save(item, { "system.description": description.innerHTML }));

  return h("div.sheet", null,
    h("div.sheet-head", null, img, h("div.stack.grow", null,
      h("input.title-input", { value: item.name, disabled: !editable, onchange: (e: Event) => save(item, { name: (e.target as HTMLInputElement).value.trim() || item.name }) }),
      h("div.row", null, h("label.field", null, h("span", null, "Tipo"), h("select", {
        disabled: !editable,
        onchange: (e: Event) => {
          const type = (e.target as HTMLSelectElement).value;
          save(item, { type, system: withTemplate(type, item.system) });
        }
      }, ITEM_TYPES.map(([v, l]) => h("option", { value: v, selected: v === item.type }, l)))))
    )),
    carried && h("div.row", null,
      text("Quantidade", "system.quantity", s.quantity ?? 1, { type: "number", min: 0 }),
      text("Espaços", "system.weight", s.weight ?? 1, { type: "number", min: 0 }),
      text("Categoria", "system.category", s.category ?? 0, { type: "number", min: 0, max: 4 })),
    ...typeFields,
    h("h4", null, "Descrição"),
    description,
    game.isGM && !item._parent && ownershipEditor(item, "Item")
  );
}

/** When an item's type changes, give it that type's default fields (keeping what's already there). */
export function withTemplate(type: string, system: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...itemTemplate(type), ...system };
}

function formulaWithBonus(formula: string, bonus: unknown): string {
  const b = String(bonus ?? "").trim();
  if (!b || b === "0") return formula;
  return /^[+-]/.test(b) ? `${formula}${b}` : `${formula}+${b}`;
}

/** Weapon attack (skill test + bonus) or damage roll, posted to chat. */
export function rollItem(item: ItemDoc, actor: ActorDoc, kind: "attack" | "damage"): void {
  const f = item.system?.formulas ?? {};
  const formula = kind === "attack"
    ? formulaWithBonus(skillFormula(actor, f.attack?.skill || "fighting"), f.attack?.bonus)
    : formulaWithBonus(String(f.damage?.formula || "1d6"), f.damage?.bonus);
  try {
    parseFormula(formula);
  } catch {
    return toast(`Fórmula que a Mesa ainda não percebe: ${formula}`, "error");
  }
  const flavor = kind === "attack"
    ? `${item.name} — ataque${item.system?.critical ? ` (crítico ${item.system.critical})` : ""}`
    : `${item.name} — dano${f.damage?.type ? ` (${f.damage.type})` : ""}`;
  game.roll({ formula, flavor, speaker: { actor: actor._id, alias: actor.name } });
}

/** Post a ritual / ability to chat. */
export function useItem(item: ItemDoc, actor: ActorDoc): void {
  const s = item.system ?? {};
  const lines = item.type === "ritual"
    ? [
        `${item.name} (${s.circle ?? "?"}º círculo${s.element ? `, ${s.element}` : ""})`,
        ...[["Execução", s.execution], ["Alcance", s.range], ["Alvo", s.target], ["Duração", s.duration], ["Resistência", s.resistance]]
          .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)
      ]
    : [item.name];
  const plain = String(s.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (plain) lines.push("", plain);
  game.create("ChatMessage", { content: lines.join("\n"), speaker: { actor: actor._id, alias: actor.name } });
}
