import type { EffectChange, EffectData } from "../../../shared/protocol.ts";
import { CONDITIONS } from "../../../shared/conditions.ts";
import { h } from "../dom.ts";
import type { ActorRef } from "../actors.ts";
import { newEffect, ownEffects, saveEffect } from "../actors.ts";
import { closeWindow, openWindow } from "./windows.ts";

const CHANGE_TYPES: [EffectChange["type"], string][] = [
  ["add", "Somar"], ["multiply", "Multiplicar"], ["override", "Substituir"], ["upgrade", "No mínimo"], ["downgrade", "No máximo"]
];

/** Common targets for Ordem Paranormal actors (free text is allowed too). */
const KEY_SUGGESTIONS = [
  "system.defense.value", "system.PV.max", "system.SAN.max", "system.PE.max", "system.desloc.value",
  "system.attributes.dex.value", "system.attributes.str.value", "system.attributes.int.value",
  "system.attributes.pre.value", "system.attributes.vit.value", "system.skills.reflexes.mod", "system.skills.fighting.mod",
  "system.skills.aim.mod", "system.skills.perception.mod", "system.skills.will.mod", "system.skills.resilience.mod"
];

/** Create (effectId = null) or edit an active effect on an actor or an unlinked token. */
export function openEffectConfig(ref: ActorRef, effectId: string | null): void {
  const existing = effectId ? ownEffects(ref).find(e => e._id === effectId) : undefined;
  const key = `effect-${effectId ?? Math.random()}`;
  const body = openWindow(key, existing ? `Efeito: ${existing.name}` : "Novo efeito", { width: 520 });
  if (!body) return;
  const e: Omit<EffectData, "_id"> & { _id?: string } = existing ? structuredClone(existing) : newEffect();

  const name = h("input", { value: e.name });
  const icon = h("input", { value: e.icon, maxLength: 4, style: { width: "56px" } });
  const disabled = h("input", { type: "checkbox", checked: e.disabled });
  const rounds = h("input", { type: "number", min: 0, value: e.duration.rounds ?? "", placeholder: "∞" });
  const description = h("textarea", { rows: 3 }, e.description);
  const statuses = h("select", { multiple: true, size: 6 }, CONDITIONS.map(c => h("option", { value: c.id, selected: e.statuses.includes(c.id) }, `${c.icon} ${c.name}`)));
  const changesHost = h("div.stack");
  const datalist = h("datalist", { id: "effect-keys" }, KEY_SUGGESTIONS.map(k => h("option", { value: k })));

  const renderChanges = () => {
    changesHost.replaceChildren(...e.changes.map((c, i) => h("div.row.change", null,
      h("input.grow", { value: c.key, placeholder: "system.defense.value", list: "effect-keys", oninput: (ev: Event) => (c.key = (ev.target as HTMLInputElement).value) }),
      h("select", { onchange: (ev: Event) => (c.type = (ev.target as HTMLSelectElement).value as EffectChange["type"]) },
        CHANGE_TYPES.map(([v, l]) => h("option", { value: v, selected: v === c.type }, l))),
      h("input", { value: c.value, style: { width: "70px" }, oninput: (ev: Event) => (c.value = (ev.target as HTMLInputElement).value) }),
      h("button.icon.small", { type: "button", onclick: () => { e.changes.splice(i, 1); renderChanges(); } }, "✕")
    )));
  };
  renderChanges();

  body.append(datalist, h("form.stack", {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      const r = Number(rounds.value);
      await saveEffect(ref, {
        ...e,
        name: name.value.trim() || "Efeito",
        icon: icon.value.trim() || "✨",
        disabled: disabled.checked,
        description: description.value,
        statuses: [...statuses.selectedOptions].map(o => o.value),
        changes: e.changes.filter(c => c.key.trim()),
        duration: { ...e.duration, rounds: r > 0 ? r : null }
      });
      closeWindow(key);
    }
  },
    h("div.row", null, h("label.field", null, h("span", null, "Nome"), name), h("label.field", null, h("span", null, "Ícone"), icon)),
    h("div.row", null,
      h("label.field", null, h("span", null, "Duração (rondas de combate)"), rounds),
      h("label.row", null, disabled, "Desativado")),
    h("label.field", null, h("span", null, "Condições (Ctrl/⌘ para várias)"), statuses),
    h("div.row", null, h("h4.grow", null, "Alterações"), h("button.small", { type: "button", onclick: () => { e.changes.push({ key: "", type: "add", value: "0" }); renderChanges(); } }, "+ Alteração")),
    changesHost,
    h("label.field", null, h("span", null, "Descrição"), description),
    h("div.row.end", null, h("button.primary", { type: "submit" }, "Guardar"))
  ));
}
