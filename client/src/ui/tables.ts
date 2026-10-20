import type { BaseDoc, LinkType, RollMode, RollTableDoc, TableAction, TableResultDoc } from "../../../shared/protocol.ts";
import { LINK_TYPES, OWNERSHIP } from "../../../shared/protocol.ts";
import { ownershipLevel } from "../../../shared/permissions.ts";
import { parseFormula } from "../../../shared/dice.ts";
import { game, toast } from "../game.ts";
import { avatar, h, pickFile, safeHtml, setChildren, upload } from "../dom.ts";
import { directory } from "./directory.ts";
import { closeWindow, confirmDialog, openWindow, prompt, setWindowTitle } from "./windows.ts";
import { linkChip } from "./links.ts";

const DOC_DRAG = "application/x-mesa-doc";
const level = (t: RollTableDoc) => ownershipLevel(t.ownership, game.user);
const results = (tableId: string) => game.children<TableResultDoc>("TableResult", tableId)
  .sort((a, b) => a.range[0] - b.range[0] || a._id.localeCompare(b._id));

export async function tableAction(action: TableAction): Promise<boolean> {
  const res = await game.socket.timeout(10_000).emitWithAck("table", action);
  if (!res.ok) toast(res.error, "error");
  return res.ok;
}

/** Draw from a table (the server rolls and posts the card). */
export function drawTable(tableId: string, count = 1, mode: RollMode = "public"): Promise<boolean> {
  return tableAction({ action: "draw", tableId, count, mode });
}

export function tablesPanel(): HTMLElement {
  const dir = directory<RollTableDoc>({
    type: "RollTable",
    create: { label: "Criar tabela", icon: "fa-solid fa-table-list", run: () => createTable() },
    docs: () => game.all<RollTableDoc>("RollTable"),
    empty: game.isGM ? "Sem tabelas." : "O mestre ainda não partilhou tabelas.",
    sort: (a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"),
    onOpen: t => (level(t) >= OWNERSHIP.OBSERVER ? openTableSheet(t._id) : undefined),
    entry: t => [
      avatar(t.img, t.name, 32),
      h("span.grow", null, t.name),
      level(t) >= OWNERSHIP.OBSERVER && h("button.icon.small", {
        title: "Rolar na tabela", onclick: (e: Event) => { e.stopPropagation(); drawTable(t._id); }
      }, h("i.fa-solid.fa-dice-d20")),
      game.isGM && h("button.icon.small", {
        title: "Apagar",
        onclick: async (e: Event) => {
          e.stopPropagation();
          if (await confirmDialog(`Apagar a tabela "${t.name}"?`)) game.delete("RollTable", t._id);
        }
      }, "✕")
    ]
  });
  return h("div.panel", null, dir.element);
}

async function createTable(): Promise<void> {
  const v = await prompt("Nova tabela", [{ name: "name", label: "Nome" }]);
  if (!v?.name.trim()) return;
  const [t] = await game.create<RollTableDoc>("RollTable", { name: v.name.trim(), sort: Date.now() });
  if (t) openTableSheet(t._id);
}

const MODE_OPTIONS: [RollMode, string][] = [["public", "Para todos"], ["gm", "Mestre e eu"], ["blind", "Às cegas"], ["self", "Só eu"]];

/**
 * A table's sheet. Owners edit everything in place (each change saves); observers see the results and
 * can draw. Drag an actor, item, journal entry, table… from the sidebar onto a result to link it.
 */
export function openTableSheet(tableId: string): void {
  const key = `table-${tableId}`;
  const offs: (() => void)[] = [];
  const body = openWindow(key, game.get<RollTableDoc>("RollTable", tableId)?.name ?? "Tabela", { width: 640, onClose: () => offs.forEach(f => f()) });
  if (!body) return;
  let count = 1;
  let mode: RollMode = "public";

  const render = () => {
    const t = game.get<RollTableDoc>("RollTable", tableId);
    if (!t) return closeWindow(key);
    // Keep focus/caret when a re-render happens while typing elsewhere in the sheet.
    if (body.contains(document.activeElement) && document.activeElement?.matches("input:not([type=checkbox]), textarea")) return;
    setWindowTitle(key, t.name);
    const owner = level(t) >= OWNERSHIP.OWNER;
    const list = results(tableId);
    const save = (data: Record<string, unknown>) => game.update("RollTable", { _id: tableId, ...data });
    const saveResult = (id: string, data: Record<string, unknown>) => game.update("TableResult", { _id: id, ...data }, tableId);

    const header = owner
      ? h("div.table-head", null,
        h("button.table-img", {
          type: "button", title: "Mudar imagem",
          onclick: async () => {
            const file = await pickFile("image/*");
            if (file) save({ img: await upload(file).catch(err => (toast(err.message, "error"), t.img)) });
          }
        }, avatar(t.img, t.name, 56)),
        h("div.stack.grow", null,
          h("input.table-name", { value: t.name, onchange: (e: Event) => save({ name: (e.target as HTMLInputElement).value.trim() || t.name }) }),
          h("textarea", { rows: 2, placeholder: "Descrição", value: t.description, onchange: (e: Event) => save({ description: (e.target as HTMLTextAreaElement).value }) })))
      : h("div.table-head", null, avatar(t.img, t.name, 56), h("div.stack.grow", null, h("h3", null, t.name),
        t.description && h("div.muted", null, t.description.includes("<") ? safeHtml(t.description) : t.description)));

    const settings = owner && h("div.row.wrap.table-settings", null,
      h("label.field", null, h("span", null, "Fórmula (vazio = pelos pesos)"),
        h("input", {
          value: t.formula, placeholder: "ex.: 1d20, 2d6",
          onchange: (e: Event) => {
            const f = (e.target as HTMLInputElement).value.trim();
            try {
              if (f) parseFormula(f);
              save({ formula: f });
            } catch (err) {
              toast((err as Error).message, "error");
            }
          }
        })),
      h("button", { type: "button", title: "Refaz os intervalos pelos pesos e a fórmula 1dN", onclick: () => tableAction({ action: "normalize", tableId }) },
        h("i.fa-solid.fa-scale-balanced"), " Normalizar"),
      h("label.row", null, h("input", { type: "checkbox", checked: t.replacement, onchange: (e: Event) => save({ replacement: (e.target as HTMLInputElement).checked }) }), "Com reposição"),
      h("label.row", null, h("input", { type: "checkbox", checked: t.displayRoll, onchange: (e: Event) => save({ displayRoll: (e.target as HTMLInputElement).checked }) }), "Mostrar a rolagem"),
      h("label.row", null, h("input", {
        type: "checkbox", checked: (t.ownership.default ?? 0) >= OWNERSHIP.OBSERVER,
        onchange: (e: Event) => save({ ownership: { ...t.ownership, default: (e.target as HTMLInputElement).checked ? OWNERSHIP.OBSERVER : OWNERSHIP.NONE } })
      }), "Jogadores podem rolar"));

    const num = (value: number, onChange: (v: number) => void, attrs: Record<string, unknown> = {}) => h("input.num", {
      type: "number", step: 1, value: String(value), ...attrs,
      onchange: (e: Event) => onChange(Math.round(Number((e.target as HTMLInputElement).value)))
    });

    const row = (r: TableResultDoc) => {
      const doc = r.type === "document" && r.document;
      const cells = owner
        ? [
          h("td.range", null, num(r.range[0], v => saveResult(r._id, { range: [v, Math.max(v, r.range[1])] })), "–",
            num(r.range[1], v => saveResult(r._id, { range: [Math.min(r.range[0], v), v] }))),
          h("td", null, num(r.weight, v => saveResult(r._id, { weight: Math.max(1, v) }), { min: 1, title: "Peso" })),
          h("td.grow", null,
            doc ? h("div.row", null, linkChip(doc.type, doc.id, r.name),
              h("button.icon.small", { title: "Desligar o documento", onclick: () => saveResult(r._id, { type: "text", document: null }) }, h("i.fa-solid.fa-link-slash"))) : null,
            h("input", { value: r.name, placeholder: doc ? "Texto (opcional)" : "Resultado", onchange: (e: Event) => saveResult(r._id, { name: (e.target as HTMLInputElement).value }) })),
          h("td", null, h("input", {
            type: "checkbox", checked: r.drawn, title: "Já saiu",
            onchange: (e: Event) => saveResult(r._id, { drawn: (e.target as HTMLInputElement).checked })
          })),
          h("td", null, h("button.icon.small", { title: "Apagar resultado", onclick: () => game.delete("TableResult", r._id, tableId) }, "✕"))
        ]
        : [
          h("td.range", null, r.range[0] === r.range[1] ? String(r.range[0]) : `${r.range[0]}–${r.range[1]}`),
          h("td.grow", null, doc ? linkChip(doc.type, doc.id, r.name) : r.name),
          h("td", null, r.drawn ? h("i.fa-solid.fa-check", { title: "Já saiu" }) : null)
        ];
      const tr = h("tr", { className: r.drawn ? "drawn" : "" }, cells);
      if (owner) {
        tr.addEventListener("dragover", e => { if (e.dataTransfer?.types.includes(DOC_DRAG)) { e.preventDefault(); tr.classList.add("drop-target"); } });
        tr.addEventListener("dragleave", () => tr.classList.remove("drop-target"));
        tr.addEventListener("drop", e => {
          tr.classList.remove("drop-target");
          const raw = e.dataTransfer?.getData(DOC_DRAG);
          if (!raw) return;
          e.preventDefault();
          const { type, id } = JSON.parse(raw) as { type: LinkType; id: string };
          if (!LINK_TYPES.includes(type) || (type === "RollTable" && id === tableId)) return;
          saveResult(r._id, { type: "document", document: { type, id }, name: r.name || game.get<BaseDoc & { name: string }>(type, id)?.name || "" });
        });
      }
      return tr;
    };

    const addResult = (names: string[]) => {
      const top = list.reduce((m, r) => Math.max(m, r.range[1]), 0);
      game.create("TableResult", names.map((name, i) => ({ name, weight: 1, range: [top + i + 1, top + i + 1] })), tableId);
    };

    setChildren(body,
      header,
      settings,
      h("table.table-results", null,
        h("thead", null, h("tr", null, owner
          ? [h("th", null, "Intervalo"), h("th", null, "Peso"), h("th", null, "Resultado (arrasta um documento para ligar)"), h("th", null, "Saiu"), h("th")]
          : [h("th", null, "Intervalo"), h("th", null, "Resultado"), h("th")])),
        h("tbody", null, list.map(row))),
      !list.length ? h("p.muted", null, "Sem resultados ainda.") : null,
      h("div.row.end.wrap", null,
        owner && h("button", { type: "button", onclick: () => addResult([""]) }, h("i.fa-solid.fa-plus"), " Resultado"),
        owner && h("button", {
          type: "button", title: "Uma linha por resultado",
          onclick: async () => {
            const v = await prompt("Colar resultados (um por linha)", [{ name: "lines", label: "Resultados", type: "textarea" }]);
            const names = (v?.lines ?? "").split("\n").map(l => l.trim()).filter(Boolean);
            if (names.length) addResult(names);
          }
        }, h("i.fa-solid.fa-paste"), " Colar lista"),
        owner && h("button", { type: "button", onclick: () => tableAction({ action: "reset", tableId }) }, h("i.fa-solid.fa-rotate-left"), " Repor"),
        h("span.grow"),
        h("input.num", { type: "number", min: 1, max: 50, value: String(count), title: "Quantos resultados", onchange: (e: Event) => (count = Math.max(1, Number((e.target as HTMLInputElement).value) || 1)) }),
        h("select", { onchange: (e: Event) => (mode = (e.target as HTMLSelectElement).value as RollMode) },
          MODE_OPTIONS.map(([v, l]) => h("option", { value: v, selected: v === mode }, l))),
        h("button.primary", { type: "button", onclick: () => drawTable(tableId, count, mode) }, h("i.fa-solid.fa-dice-d20"), " Rolar"))
    );
  };
  offs.push(game.on("RollTable", e => e.ids.includes(tableId) && render()));
  offs.push(game.on("TableResult", e => e.docs.some(d => d._parent === tableId) && render()));
  // Re-render when focus leaves the sheet, in case a change arrived while typing.
  body.addEventListener("focusout", () => setTimeout(() => !body.contains(document.activeElement) && render()));
  render();
}
