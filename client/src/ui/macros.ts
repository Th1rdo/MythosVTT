import type { MacroDoc, UserDoc } from "../../../shared/protocol.ts";
import { OWNERSHIP } from "../../../shared/protocol.ts";
import { macroLevel } from "../../../shared/permissions.ts";
import { game, toast } from "../game.ts";
import { avatar, h, pickFile, upload } from "../dom.ts";
import { directory } from "./directory.ts";
import { closeWindow, confirmDialog, openWindow, setWindowTitle } from "./windows.ts";
import { executeMacro } from "../macros.ts";

const SCRIPT_HELP = "Script em JavaScript (corre no teu browser, pode usar await). Disponível: speaker, actor, token, character, scope e mesa " +
  "(mesa.game, mesa.board, mesa.selected(), mesa.chat(texto), mesa.roll(fórmula, descrição), mesa.notify(texto), " +
  "mesa.playAudio(ficheiro, {volume, channel}), mesa.drawTable(nome, {count, mode}), mesa.openSheet(idAtor), mesa.audio).";
const CHAT_HELP = "Texto enviado para o chat como se o escrevesses. Várias linhas começadas por \"/\" correm uma a uma (ex.: /r 1d20).";

/** An image path shows as a picture; anything else (an emoji) as text; nothing as the type's icon. */
export function macroIcon(m: MacroDoc, size: number): HTMLElement {
  if (m.img && /^(\/|https?:|data:)/.test(m.img)) return avatar(m.img, m.name, size);
  if (m.img) return h("span.avatar.macro-icon", { style: { width: `${size}px`, height: `${size}px`, fontSize: `${size * 0.55}px` } }, m.img);
  return h("span.avatar.macro-icon", { style: { width: `${size}px`, height: `${size}px`, fontSize: `${size * 0.42}px` } },
    h("i", { className: m.type === "script" ? "fa-solid fa-code" : "fa-solid fa-comment-dots" }));
}

const owns = (m: MacroDoc) => macroLevel(m, game.user) >= OWNERSHIP.OWNER;

export function macrosPanel(): HTMLElement {
  const dir = directory<MacroDoc>({
    type: "Macro",
    create: { label: "Criar macro", icon: "fa-solid fa-code", run: () => openMacroConfig(), everyone: true },
    docs: () => game.all<MacroDoc>("Macro"),
    empty: "Sem macros. Cria uma, ou clica numa casa vazia da barra de macros.",
    sort: (a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"),
    onOpen: m => (owns(m) ? openMacroConfig(m._id) : executeMacro(m)),
    entry: m => [
      macroIcon(m, 32),
      h("span.grow", null, m.name),
      h("span.muted.small", null, m.type === "script" ? "script" : "chat"),
      h("button.icon.small", { title: "Executar", onclick: (e: Event) => { e.stopPropagation(); executeMacro(m); } }, h("i.fa-solid.fa-play")),
      owns(m) && h("button.icon.small", {
        title: "Apagar",
        onclick: async (e: Event) => {
          e.stopPropagation();
          if (await confirmDialog(`Apagar a macro "${m.name}"?`)) game.delete("Macro", m._id);
        }
      }, "✕")
    ]
  });
  return h("div.panel", null, dir.element);
}

const SHARE_OPTIONS: [number, string][] = [
  [OWNERSHIP.NONE, "Só eu (e o mestre)"],
  [OWNERSHIP.LIMITED, "Todos podem ver e executar"],
  [OWNERSHIP.OWNER, "Todos podem editar"]
];

/**
 * Create (no id) or edit a macro. With `hotbarSlot`, a new macro goes straight into that slot.
 * "Executar" saves first, then runs it.
 */
export function openMacroConfig(macroId?: string, hotbarSlot?: number): void {
  const key = `macro-${macroId ?? `new-${hotbarSlot ?? ""}`}`;
  const existing = macroId ? game.get<MacroDoc>("Macro", macroId) : undefined;
  if (macroId && !existing) return;
  const body = openWindow(key, existing ? `Macro: ${existing.name}` : "Nova macro", { width: 520 });
  if (!body) return;
  let current = existing;

  const name = h("input", { value: existing?.name ?? "", placeholder: "Nome" });
  const type = h("select", null, [["chat", "Chat"], ["script", "Script"]].map(([v, l]) => h("option", { value: v, selected: (existing?.type ?? "chat") === v }, l)));
  const img = h("input", { value: existing?.img ?? "", placeholder: "Emoji ou imagem (vazio = ícone)" });
  const pickImg = h("button", {
    type: "button", title: "Carregar imagem",
    onclick: async () => {
      const file = await pickFile("image/*");
      if (!file) return;
      try {
        img.value = await upload(file);
      } catch (err) {
        toast((err as Error).message, "error");
      }
    }
  }, h("i.fa-solid.fa-image"));
  const command = h("textarea.macro-command", { rows: 12, spellcheck: false, value: existing?.command ?? "" });
  const help = h("p.muted.small");
  const updateHelp = () => {
    help.textContent = type.value === "script" ? SCRIPT_HELP : CHAT_HELP;
    command.classList.toggle("code", type.value === "script");
  };
  type.addEventListener("change", updateHelp);
  updateHelp();
  const share = h("select", null, SHARE_OPTIONS.map(([v, l]) => h("option", { value: String(v), selected: (existing?.ownership?.default ?? 0) === v }, l)));
  const author = existing && game.get<UserDoc>("User", existing.author);
  // Tab inserts spaces in the editor instead of leaving it.
  command.addEventListener("keydown", e => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    command.setRangeText("  ", command.selectionStart, command.selectionEnd, "end");
  });

  const save = async (): Promise<MacroDoc | undefined> => {
    const data = {
      name: name.value.trim() || "Nova macro", type: type.value, img: img.value.trim() || null, command: command.value,
      ownership: { ...(current?.ownership ?? {}), default: Number(share.value) }
    };
    if (current) {
      [current] = await game.update<MacroDoc>("Macro", { _id: current._id, ...data });
    } else {
      [current] = await game.create<MacroDoc>("Macro", { ...data, sort: Date.now() });
      if (current && hotbarSlot) await game.update("User", { _id: game.userId, [`hotbar.${hotbarSlot}`]: { type: "Macro", id: current._id } });
    }
    if (current) setWindowTitle(key, `Macro: ${current.name}`);
    return current;
  };

  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      if (await save()) closeWindow(key);
    }
  },
    h("div.row", null, h("label.field.grow", null, h("span", null, "Nome"), name), h("label.field", null, h("span", null, "Tipo"), type)),
    h("label.field", null, h("span", null, "Ícone"), h("div.row", null, img, pickImg)),
    h("label.field", null, h("span", null, "Comando"), command),
    help,
    h("label.field", null, h("span", null, "Partilha"), share),
    author && h("p.muted.small", null, `Autor: ${author.name}`),
    h("div.row.end", null,
      current && h("button.danger", {
        type: "button",
        onclick: async () => {
          if (!(await confirmDialog(`Apagar a macro "${current!.name}"?`))) return;
          await game.delete("Macro", current!._id);
          closeWindow(key);
        }
      }, "Apagar"),
      h("button", { type: "button", onclick: async () => { const m = await save(); if (m) executeMacro(m); } }, h("i.fa-solid.fa-play"), " Executar"),
      h("button.primary", { type: "submit" }, "Guardar"))
  ));
  name.focus();
}
