import type { MacroDoc, RegionBehavior, RegionDoc, RegionEvent, SceneDoc } from "../../../shared/protocol.ts";
import { REGION_VISIBILITY } from "../../../shared/protocol.ts";
import { CONDITIONS } from "../../../shared/conditions.ts";
import { randomId } from "../../../shared/objects.ts";
import { game } from "../game.ts";
import { h } from "../dom.ts";
import { closeWindow, openWindow } from "./windows.ts";
import { levelsField } from "./canvas-config.ts";

const BEHAVIORS: [RegionBehavior["type"], string][] = [
  ["teleportToken", "Teletransportar token"],
  ["changeLevel", "Mudar de nível (escadas)"],
  ["applyActiveEffect", "Aplicar efeito enquanto dentro"],
  ["displayScrollingText", "Mostrar texto"],
  ["adjustDarkness", "Ajustar escuridão"],
  ["toggleBehavior", "Ligar/desligar comportamentos"],
  ["executeMacro", "Executar macro"]
];

function defaultSystem(type: RegionBehavior["type"]): RegionBehavior["system"] {
  switch (type) {
    case "teleportToken": return { destinations: [] };
    case "changeLevel": return {};
    case "applyActiveEffect": return { effect: { name: "Efeito da região", icon: "✨", disabled: false, statuses: [], changes: [], duration: { rounds: null, startRound: null, combat: null }, description: "" } };
    case "displayScrollingText": return { text: "", color: "#ffffff", events: ["tokenEnter"], visibility: "all" };
    case "adjustDarkness": return { mode: "brighten", amount: 1 };
    case "toggleBehavior": return { events: ["tokenEnter"], enable: [], disable: [] };
    case "executeMacro": return { macroId: null, events: ["tokenEnter"], everyone: false };
  }
}

const field = (label: string, input: HTMLElement) => h("label.field", null, h("span", null, label), input);

function eventsPicker(events: RegionEvent[], onChange: (e: RegionEvent[]) => void): HTMLElement {
  const box = (ev: RegionEvent, label: string) => {
    const input = h("input", { type: "checkbox", checked: events.includes(ev) });
    input.addEventListener("change", () => onChange(input.checked ? [...new Set([...events, ev])] : events.filter(x => x !== ev)));
    return h("label.row", null, input, label);
  };
  return h("div.row", null, box("tokenEnter", "Ao entrar"), box("tokenExit", "Ao sair"));
}

function multiSelect(options: [string, string][], selected: string[], onChange: (ids: string[]) => void): HTMLSelectElement {
  const el = h("select", { multiple: true, size: Math.min(6, Math.max(3, options.length)) },
    options.map(([v, l]) => h("option", { value: v, selected: selected.includes(v) }, l)));
  el.addEventListener("change", () => onChange([...el.selectedOptions].map(o => o.value)));
  return el;
}

/** GM: a region's shape settings, visibility, levels and behaviours. Behaviours run on the server. */
export function openRegionConfig(regionId: string, sceneId: string): void {
  const key = `region-${regionId}`;
  const r = game.get<RegionDoc>("Region", regionId);
  if (!r) return;
  const body = openWindow(key, `Região: ${r.name}`, { width: 520 });
  if (!body) return;
  const behaviors: RegionBehavior[] = structuredClone(r.behaviors);
  const name = h("input", { value: r.name });
  const color = h("input", { type: "color", value: r.color });
  const visibility = h("select", null, [
    [REGION_VISIBILITY.LAYER, "Só com a ferramenta de regiões"], [REGION_VISIBILITY.GAMEMASTER, "Sempre para o mestre"], [REGION_VISIBILITY.ALWAYS, "Para todos"]
  ].map(([v, l]) => h("option", { value: String(v), selected: r.visibility === v }, String(l))));
  const hidden = h("input", { type: "checkbox", checked: r.hidden });
  const bottom = h("input", { type: "number", value: r.elevation.bottom ?? "", placeholder: "−∞" });
  const top = h("input", { type: "number", value: r.elevation.top ?? "", placeholder: "∞" });
  const measure = h("input", { type: "checkbox", checked: r.displayMeasurements });
  const lv = levelsField(sceneId, r.levels);
  const list = h("div.stack");

  // Destinations can be regions on any scene.
  const allRegions = game.all<RegionDoc>("Region").filter(x => !x.template && x._id !== regionId)
    .map(x => [x._id, `${game.get<SceneDoc>("Scene", x._parent)?.name ?? "?"}: ${x.name}`] as [string, string]);
  const sceneBehaviors = () => game.children<RegionDoc>("Region", sceneId).flatMap(x => (x._id === regionId ? behaviors : x.behaviors).map(b => [b._id, `${x.name}: ${b.name || BEHAVIORS.find(([t]) => t === b.type)?.[1]}`] as [string, string]));

  const renderList = () => {
    list.replaceChildren(...behaviors.map((b, i) => {
      const s = b.system as any;
      const set = (patch: Record<string, unknown>) => { b.system = { ...s, ...patch } as never; };
      let fields: HTMLElement[] = [];
      switch (b.type) {
        case "teleportToken":
          fields = [field("Destinos (um ao calhas)", multiSelect(allRegions, s.destinations, ids => set({ destinations: ids })))];
          break;
        case "changeLevel":
          fields = [h("p.muted.small", null, "Pergunta ao jogador para que nível ir, entre os níveis desta região (marca 2 ou mais em Níveis).")];
          break;
        case "applyActiveEffect": {
          const effectName = h("input", { value: s.effect.name, oninput: (e: Event) => (s.effect.name = (e.target as HTMLInputElement).value) });
          const icon = h("input", { value: s.effect.icon, maxLength: 4, style: { width: "56px" }, oninput: (e: Event) => (s.effect.icon = (e.target as HTMLInputElement).value) });
          fields = [
            h("div.row", null, field("Efeito", effectName), field("Ícone", icon)),
            field("Condições", multiSelect(CONDITIONS.map(c => [c.id, `${c.icon} ${c.name}`]), s.effect.statuses, ids => (s.effect.statuses = ids)))
          ];
          break;
        }
        case "displayScrollingText":
          fields = [
            h("div.row", null,
              field("Texto", h("input", { value: s.text, oninput: (e: Event) => set({ text: (e.target as HTMLInputElement).value }) })),
              field("Cor", h("input", { type: "color", value: s.color, oninput: (e: Event) => set({ color: (e.target as HTMLInputElement).value }) }))),
            h("div.row", null, eventsPicker(s.events, ev => set({ events: ev })),
              field("Quem vê", h("select", { onchange: (e: Event) => set({ visibility: (e.target as HTMLSelectElement).value }) },
                [["all", "Todos"], ["owner", "Dono do token"], ["gm", "Só o mestre"]].map(([v, l]) => h("option", { value: v, selected: s.visibility === v }, l)))))
          ];
          break;
        case "adjustDarkness":
          fields = [h("div.row", null,
            field("Modo", h("select", { onchange: (e: Event) => set({ mode: (e.target as HTMLSelectElement).value }) },
              [["brighten", "Iluminar (sem escuridão)"], ["darken", "Escurecer"]].map(([v, l]) => h("option", { value: v, selected: s.mode === v }, l)))),
            field("Intensidade", h("input", { type: "range", min: 0, max: 1, step: 0.05, value: String(s.amount), oninput: (e: Event) => set({ amount: Number((e.target as HTMLInputElement).value) }) })))];
          break;
        case "toggleBehavior":
          fields = [
            eventsPicker(s.events, ev => set({ events: ev })),
            h("div.row", null,
              field("Ligar", multiSelect(sceneBehaviors(), s.enable, ids => set({ enable: ids }))),
              field("Desligar", multiSelect(sceneBehaviors(), s.disable, ids => set({ disable: ids }))))
          ];
          break;
        case "executeMacro": {
          const macros = game.all<MacroDoc>("Macro").sort((a, c) => a.name.localeCompare(c.name, "pt"));
          fields = [
            field("Macro", h("select", { onchange: (e: Event) => set({ macroId: (e.target as HTMLSelectElement).value || null }) },
              h("option", { value: "" }, "— escolhe uma macro —"),
              macros.map(m => h("option", { value: m._id, selected: s.macroId === m._id }, m.name)))),
            h("div.row", null, eventsPicker(s.events, ev => set({ events: ev })),
              h("label.row", null, h("input", { type: "checkbox", checked: s.everyone, onchange: (e: Event) => set({ everyone: (e.target as HTMLInputElement).checked }) }),
                "Executar para todos"))
          ];
          break;
        }
      }
      const disabled = h("input", { type: "checkbox", checked: b.disabled, onchange: (e: Event) => (b.disabled = (e.target as HTMLInputElement).checked) });
      return h("fieldset.behavior", null,
        h("legend", null, BEHAVIORS.find(([t]) => t === b.type)?.[1] ?? b.type),
        h("div.row", null,
          h("input.grow", { value: b.name, placeholder: "Nome (opcional)", oninput: (e: Event) => (b.name = (e.target as HTMLInputElement).value) }),
          h("label.row", null, disabled, "Desligado"),
          h("button.icon.small", { type: "button", title: "Remover", onclick: () => { behaviors.splice(i, 1); renderList(); } }, "✕")),
        ...fields
      );
    }));
  };
  renderList();
  const addType = h("select", null, BEHAVIORS.map(([t, l]) => h("option", { value: t }, l)));

  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      await game.update("Region", {
        _id: regionId, name: name.value.trim() || r.name, color: color.value, visibility: Number(visibility.value), hidden: hidden.checked,
        elevation: { bottom: numOrNull(bottom.value), top: numOrNull(top.value) }, displayMeasurements: measure.checked,
        levels: lv.read(), behaviors
      }, sceneId);
      closeWindow(key);
    }
  },
    h("div.row", null, field("Nome", name), field("Cor", color)),
    h("div.row", null, field("Visível", visibility), h("label.row", null, hidden, "Escondida"), h("label.row", null, measure, "Mostrar medidas")),
    h("div.row", null, field("Elevação de baixo", bottom), field("Elevação de cima", top)),
    lv.node,
    h("h4", null, "Comportamentos"),
    list,
    h("div.row", null, addType, h("button", {
      type: "button",
      onclick: () => {
        const type = addType.value as RegionBehavior["type"];
        behaviors.push({ _id: randomId(), name: "", disabled: false, type, system: defaultSystem(type) } as RegionBehavior);
        renderList();
      }
    }, "+ Comportamento")),
    h("div.row.end", null,
      h("button.danger", { type: "button", onclick: () => { game.delete("Region", regionId, sceneId); closeWindow(key); } }, "Apagar"),
      h("button.primary", { type: "submit" }, "Guardar"))
  ));
}
