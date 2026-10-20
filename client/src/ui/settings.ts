import type { SettingCategory, SettingDef } from "../../../shared/settings.ts";
import { CATEGORY_LABELS, SETTINGS } from "../../../shared/settings.ts";
import { game, toast } from "../game.ts";
import { h, setChildren } from "../dom.ts";
import { settings } from "../settings.ts";
import { openWindow } from "./windows.ts";
import { uiScaleSettings } from "../shell/ui-scale.ts";
import { volumeControls } from "./audio-config.ts";

const SCOPE_NOTE: Record<SettingDef["scope"], string> = {
  world: "para toda a mesa", user: "a tua conta, em qualquer computador", client: "só neste browser"
};

/** Sections that aren't plain settings but belong in the same window. */
const EXTRA: { id: string; label: string; make: () => HTMLElement }[] = [
  { id: "audio", label: "Som", make: () => h("div.settings-block", null, h("p.muted.small", null, "Volumes deste browser."), volumeControls()) },
  { id: "size", label: "Tamanho da interface", make: uiScaleSettings }
];

function input(def: SettingDef, value: unknown): { node: HTMLElement; read: () => unknown } {
  const t = def.type;
  switch (t.kind) {
    case "boolean": {
      const el = h("input", { type: "checkbox", checked: !!value });
      return { node: el, read: () => el.checked };
    }
    case "number": {
      if (t.range) {
        const el = h("input", { type: "range", min: t.min ?? 0, max: t.max ?? 100, step: t.step ?? 1, value: String(value) });
        const out = h("span.scale-value", null, String(value));
        el.addEventListener("input", () => (out.textContent = el.value));
        return { node: h("div.row", null, el, out), read: () => Number(el.value) };
      }
      const el = h("input.num", { type: "number", min: t.min, max: t.max, step: t.step ?? "any", value: String(value) });
      return { node: el, read: () => Number(el.value) };
    }
    case "string": {
      const el = t.multiline ? h("textarea", { rows: 3, value: String(value ?? "") }) : h("input", { value: String(value ?? "") });
      return { node: el, read: () => el.value };
    }
    case "select": {
      const el = h("select", null, t.choices.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
      return { node: el, read: () => el.value };
    }
  }
}

/** The settings a user may change: world ones only for the GM. */
const visible = () => SETTINGS.filter(d => d.scope !== "world" || game.isGM);

/**
 * Definições: categories on the left, the category's settings on the right. "Guardar" applies the
 * changes (world settings go to the server and reach everyone); "Repor" puts the category back to defaults.
 */
export function openSettingsConfig(initial?: string): void {
  const body = openWindow("settings-config", "Definições", { width: 760 });
  if (!body) return;
  const cats = [...new Set(visible().map(d => d.category))] as SettingCategory[];
  let current = initial ?? cats[0];
  const nav = h("nav.settings-nav");
  const pane = h("div.settings-pane");

  const render = () => {
    setChildren(nav,
      cats.map(c => h("button", { className: c === current ? "active" : "", onclick: () => { current = c; render(); } }, CATEGORY_LABELS[c])),
      EXTRA.map(x => h("button", { className: x.id === current ? "active" : "", onclick: () => { current = x.id; render(); } }, x.label)));
    const extra = EXTRA.find(x => x.id === current);
    if (extra) {
      setChildren(pane, h("h3", null, extra.label), extra.make());
      return;
    }
    const defs = visible().filter(d => d.category === current);
    const fields = defs.map(d => ({ def: d, ...input(d, settings.get(d.key)) }));
    setChildren(pane,
      h("h3", null, CATEGORY_LABELS[current as SettingCategory]),
      h("div.settings-fields", null, fields.map(f => h("div.setting", null,
        f.def.type.kind === "boolean"
          ? h("label.row.setting-head", null, f.node, h("strong", null, f.def.name))
          : h("label.field", null, h("strong", null, f.def.name), f.node),
        h("p.muted.small", null, [f.def.hint, `(${SCOPE_NOTE[f.def.scope]})`].filter(Boolean).join(" "))))),
      h("div.row.end", null,
        h("button", {
          onclick: async () => {
            for (const f of fields) await settings.set(f.def.key, f.def.default);
            toast("Predefinições repostas");
            render();
          }
        }, h("i.fa-solid.fa-rotate-left"), " Repor predefinições"),
        h("button.primary", {
          onclick: async () => {
            let changed = 0, reload = false;
            for (const f of fields) {
              const v = f.read();
              if (JSON.stringify(v) === JSON.stringify(settings.get(f.def.key))) continue;
              if (await settings.set(f.def.key, v)) {
                changed++;
                reload ||= !!f.def.reload;
              }
            }
            toast(changed ? (reload ? "Guardado — recarrega a página para aplicar" : "Guardado") : "Nada mudou");
          }
        }, "Guardar")));
  };
  body.append(h("div.settings-config", null, nav, pane));
  render();
}
