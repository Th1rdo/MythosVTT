import type { SettingCategory, SettingDef } from "../../../shared/settings.ts";
import { CATEGORY_LABELS, SETTINGS } from "../../../shared/settings.ts";
import { game, toast } from "../game.ts";
import { h, setChildren } from "../dom.ts";
import { settings } from "../settings.ts";
import { openWindow } from "./windows.ts";
import { uiScaleSettings } from "../shell/ui-scale.ts";
import { volumeControls } from "./audio-config.ts";
import { toursPanel } from "../tours.ts";
import { bindingFromEvent, bindingLabel, bindingsOf, conflictsFor, keyActions, onBindingsChange, resetAllBindings, setBindings } from "../keybindings.ts";
import { t } from "../i18n.ts";

const SCOPE_NOTE: Record<SettingDef["scope"], string> = {
  world: "para toda a mesa", user: "a tua conta, em qualquer computador", client: "só neste browser"
};

/** Sections that aren't plain settings but belong in the same window (labels are translated when shown). */
const EXTRA: { id: string; label: string; make: () => HTMLElement }[] = [
  { id: "keys", label: "Teclas", make: () => keybindingsPanel() },
  { id: "audio", label: "Som", make: () => h("div.settings-block", null, h("p.muted.small", null, t("Volumes deste browser.")), volumeControls()) },
  { id: "size", label: "Tamanho da interface", make: uiScaleSettings },
  { id: "tours", label: "Visitas guiadas", make: () => toursPanel() }
];

function input(def: SettingDef, value: unknown): { node: HTMLElement; read: () => unknown } {
  const ty = def.type;
  switch (ty.kind) {
    case "boolean": {
      const el = h("input", { type: "checkbox", checked: !!value });
      return { node: el, read: () => el.checked };
    }
    case "number": {
      if (ty.range) {
        const el = h("input", { type: "range", min: ty.min ?? 0, max: ty.max ?? 100, step: ty.step ?? 1, value: String(value) });
        const out = h("span.scale-value", null, String(value));
        el.addEventListener("input", () => (out.textContent = el.value));
        return { node: h("div.row", null, el, out), read: () => Number(el.value) };
      }
      const el = h("input.num", { type: "number", min: ty.min, max: ty.max, step: ty.step ?? "any", value: String(value) });
      return { node: el, read: () => Number(el.value) };
    }
    case "string": {
      const el = ty.multiline ? h("textarea", { rows: 3, value: String(value ?? "") }) : h("input", { value: String(value ?? "") });
      return { node: el, read: () => el.value };
    }
    case "select": {
      const el = h("select", null, ty.choices.map(([v, l]) => h("option", { value: v, selected: v === value }, t(l))));
      return { node: el, read: () => el.value };
    }
  }
}

/** The settings a user may change: world ones only for the GM. */
const visible = () => SETTINGS.filter(d => !d.hidden && (d.scope !== "world" || game.isGM));

/**
 * Definições: categories on the left, the category's settings on the right. "Guardar" applies the
 * changes (world settings go to the server and reach everyone); "Repor" puts the category back to defaults.
 */
export function openSettingsConfig(initial?: string): void {
  const body = openWindow("settings-config", t("Definições"), { width: 760 });
  if (!body) return;
  const cats = [...new Set(visible().map(d => d.category))] as SettingCategory[];
  let current = initial ?? cats[0];
  const nav = h("nav.settings-nav");
  const pane = h("div.settings-pane");

  const render = () => {
    setChildren(nav,
      cats.map(c => h("button", { className: c === current ? "active" : "", onclick: () => { current = c; render(); } }, t(CATEGORY_LABELS[c]))),
      EXTRA.map(x => h("button", { className: x.id === current ? "active" : "", onclick: () => { current = x.id; render(); } }, t(x.label))));
    const extra = EXTRA.find(x => x.id === current);
    if (extra) {
      setChildren(pane, h("h3", null, t(extra.label)), extra.make());
      return;
    }
    const defs = visible().filter(d => d.category === current);
    const fields = defs.map(d => ({ def: d, ...input(d, settings.get(d.key)) }));
    setChildren(pane,
      h("h3", null, t(CATEGORY_LABELS[current as SettingCategory])),
      h("div.settings-fields", null, fields.map(f => h("div.setting", null,
        f.def.type.kind === "boolean"
          ? h("label.row.setting-head", null, f.node, h("strong", null, t(f.def.name)))
          : h("label.field", null, h("strong", null, t(f.def.name)), f.node),
        h("p.muted.small", null, [f.def.hint && t(f.def.hint), `(${t(SCOPE_NOTE[f.def.scope])})`].filter(Boolean).join(" "))))),
      h("div.row.end", null,
        h("button", {
          onclick: async () => {
            for (const f of fields) await settings.set(f.def.key, f.def.default);
            toast(t("Predefinições repostas"));
            render();
          }
        }, h("i.fa-solid.fa-rotate-left"), (" " + t("Repor predefinições"))),
        h("button.primary", {
          onclick: async () => {
            let changed = 0, reload = false;
            for (const f of fields) {
              const v = f.read();
              if (JSON.stringify(v) === JSON.stringify(settings.get(f.def.key))) continue;
              if (await settings.set(f.def.key, v)) {
                changed++;
                reload ||= !!f.def.reload;
                // A new language needs the page drawn again.
                if (f.def.key === "core.language") return location.reload();
              }
            }
            toast(changed ? (reload ? t("Guardado — recarrega a página para aplicar") : t("Guardado")) : t("Nada mudou"));
          }
        }, t("Guardar"))));
  };
  body.append(h("div.settings-config", null, nav, pane));
  render();
}

/** Definições → Teclas: every shortcut with its keys; click a key to change it, ✕ to remove, + to add. */
export function keybindingsPanel(): HTMLElement {
  const box = h("div.keybindings");
  let capturing: { id: string; index: number } | null = null;
  const render = () => {
    const groups = new Map<string, ReturnType<typeof keyActions>>();
    for (const a of keyActions()) groups.set(a.category, [...(groups.get(a.category) ?? []), a]);
    setChildren(box,
      h("p.muted.small", null, t("As teclas são as posições do teclado (funcionam em qualquer disposição). Teclas a cinzento não se mudam. Só neste browser.")),
      [...groups].map(([cat, list]) => h("section.key-group", null, h("h4", null, t(cat)), list.map(a => {
        const current = bindingsOf(a.id);
        return h("div.key-row", null,
          h("span.grow", null, t(a.name)),
          (a.fixed ?? []).map(b => h("kbd.fixed", { title: t("Fixa") }, bindingLabel(b))),
          current.map((b, i) => {
            const clashes = conflictsFor(a.id, b).map(x => x.name);
            return h("span.key-chip", null,
              h("kbd", {
                className: capturing?.id === a.id && capturing.index === i ? "capturing" : clashes.length ? "clash" : "",
                title: clashes.length ? t("Também usada em: {acoes} (corre a primeira que se aplicar)", { acoes: clashes.map(n => t(n)).join(", ") }) : t("Clica para mudar"),
                onclick: () => { capturing = { id: a.id, index: i }; render(); }
              }, capturing?.id === a.id && capturing.index === i ? t("carrega numa tecla…") : bindingLabel(b)),
              h("button.icon.small", { title: t("Tirar"), onclick: () => setBindings(a.id, current.filter((_, k) => k !== i)) }, "✕"));
          }),
          h("button.icon.small", {
            title: t("Juntar uma tecla"),
            onclick: () => { capturing = { id: a.id, index: current.length }; render(); }
          }, capturing?.id === a.id && capturing.index === current.length ? h("span.capturing", null, t("carrega numa tecla…")) : h("i.fa-solid.fa-plus")),
          custom(a.id) && h("button.icon.small", { title: t("Repor esta"), onclick: () => setBindings(a.id, null) }, h("i.fa-solid.fa-rotate-left")));
      }))),
      h("div.row.end", null, h("button", { onclick: () => resetAllBindings() }, h("i.fa-solid.fa-rotate-left"), (" " + t("Repor todas")))));
  };
  const custom = (id: string) => JSON.stringify(bindingsOf(id)) !== JSON.stringify(keyActions().find(a => a.id === id)?.bindings ?? []);
  // While capturing, the next key press becomes the binding (Escape cancels).
  const onKey = (e: KeyboardEvent) => {
    if (!capturing || !box.isConnected) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "Escape") {
      capturing = null;
      return render();
    }
    const b = bindingFromEvent(e);
    if (!b) return;
    const list = [...bindingsOf(capturing.id)];
    list[capturing.index] = b;
    const id = capturing.id;
    capturing = null;
    setBindings(id, list);
  };
  window.addEventListener("keydown", onKey, true);
  const off = onBindingsChange(render);
  const stop = new MutationObserver(() => {
    if (!box.isConnected) {
      window.removeEventListener("keydown", onKey, true);
      off();
      stop.disconnect();
    }
  });
  requestAnimationFrame(() => box.parentElement && stop.observe(document.body, { childList: true, subtree: true }));
  render();
  return box;
}
