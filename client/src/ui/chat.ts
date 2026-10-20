import type { BaseDoc, ActorDoc, ChatMessageDoc, DieResult, RollMode, RollResult, RollTerm, TableDraw, UserDoc } from "../../../shared/protocol.ts";
import { linkChip } from "./links.ts";
import { enrich } from "../enrich.ts";
import { replaceFormulaData } from "../../../shared/dice.ts";
import { game, toast } from "../game.ts";
import { avatar, h, safeHtml, timeLabel } from "../dom.ts";

const HELP = "Escreve uma mensagem, ou rola dados:\n" +
  "/r 2d20kh+5 # Luta — rola, com descrição após #\n" +
  "/gr 1d20 — só tu e o mestre veem · /br — às cegas (só o mestre) · /sr — só tu\n" +
  "[[1d6]] dentro do texto rola ali mesmo · @campo usa dados do teu personagem (ex.: 1d20+@forca)\n" +
  "Dados: 4d6dl, 1d10x, 1d20r1, 6d10cs>=7, 4dF, {1d20,1d12}kh, floor(1d10/2), 1d8[fogo]";

/** Chat input: Enter sends, Shift+Enter breaks the line. Used in the chat tab and the floating dock. */
export function chatInputBox(): HTMLTextAreaElement {
  const input = h("textarea.chat-input", { rows: 2, placeholder: "Escreve uma mensagem… (/r 1d20 para rolar)", title: HELP });
  input.addEventListener("keydown", async e => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    await send(text);
  });
  return input;
}

export function chatPanel(): HTMLElement {
  const log = h("div.chat-log");
  const input = chatInputBox();

  let first = true;
  const render = () => {
    const stick = first || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    first = false;
    const msgs = game.all<ChatMessageDoc>("ChatMessage").sort((a, b) => a.timestamp - b.timestamp).slice(-300);
    log.replaceChildren(...msgs.map(messageView));
    if (stick) requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
  };
  game.on("ChatMessage", render);
  game.on("ready", render);
  render();

  return h("div.chat", null, log, input);
}

export function speaker(): { actor: string | null; alias: string } {
  const user = game.user;
  const actor = game.get<ActorDoc>("Actor", user.character);
  return actor ? { actor: actor._id, alias: actor.name } : { actor: null, alias: user.name };
}

/** Send what was typed in the chat: a roll command or a message. Chat macros come through here too. */
const ROLL_COMMANDS: Record<string, RollMode> = {
  r: "public", roll: "public", pr: "public", publicroll: "public",
  gr: "gm", gmroll: "gm", br: "blind", broll: "blind", blindroll: "blind", sr: "self", selfroll: "self"
};

/** "@forca" etc. come from the speaking actor's data (missing ones count as 0, with a warning). */
export function withActorData(formula: string, actorId: string | null): string {
  if (!formula.includes("@")) return formula;
  const actor = game.get<ActorDoc>("Actor", actorId);
  const { formula: out, missing } = replaceFormulaData(formula, actor?.system ?? {});
  if (missing.length) toast(`Sem valor para ${missing.map(m => "@" + m).join(", ")} — contou como 0`, "error");
  return out;
}

export async function send(text: string, as = speaker()): Promise<void> {
  const cmd = /^\/([a-z]+)\s+(.+)$/is.exec(text);
  if (cmd && ROLL_COMMANDS[cmd[1].toLowerCase()]) {
    const [formula, ...flavor] = cmd[2].split("#");
    await game.roll({
      formula: withActorData(formula.trim(), as.actor), flavor: flavor.join("#").trim() || undefined, speaker: as,
      mode: ROLL_COMMANDS[cmd[1].toLowerCase()]
    });
    return;
  }
  if (text.startsWith("/")) {
    toast(HELP);
    return;
  }
  const content = text.replace(/\[\[([^\]]+)\]\]/g, (_, f: string) => `[[${withActorData(f, as.actor)}]]`);
  await game.create("ChatMessage", { content, speaker: as }).catch(() => {});
}

export function messageView(m: ChatMessageDoc): HTMLElement {
  const author = game.get<UserDoc>("User", m.author);
  const actor = game.get<ActorDoc>("Actor", m.speaker.actor);
  const name = m.speaker.alias || actor?.name || author?.name || "?";
  // Imported Foundry roll messages repeat the total as their content; the roll card already shows it.
  const redundant = !!m.roll && m.content.trim() === String(m.roll.total);
  const hidden = m.blind && !game.isGM;
  const body = hidden
    ? h("div.text.muted", null, "🎲 Rolagem às cegas — só o mestre vê o resultado.")
    : redundant || !m.content ? null : m.html ? h("div.prose", null, enrich(m.content)) : h("div.text", null, withInlineRolls(m.content, m.inline ?? []));
  return h("article.msg", { className: m.whisper ? "msg whisper" : "msg", style: { borderLeftColor: author?.color ?? "#555" } },
    h("header.row", null,
      avatar(actor?.img, name, 24),
      h("strong.grow", null, name),
      m.whisper && h("span.tag", null, m.blind ? "às cegas" : m.whisper.length === 1 && m.whisper[0] === m.author ? "só para mim" : "privado"),
      h("time.muted.small", null, timeLabel(m.timestamp)),
      game.isGM && h("button.icon.small", { title: "Apagar", onclick: () => game.delete("ChatMessage", m._id) }, "✕")
    ),
    m.flavor && h("div.flavor", null, m.flavor),
    body,
    m.roll && rollView(m.roll),
    m.table && tableCard(m.table)
  );
}

/** What a table draw produced: each result with its picture, text and linked document. */
function tableCard(t: TableDraw): HTMLElement {
  return h("ul.table-draw", null, t.results.map(r => h("li", null,
    r.img ? avatar(r.img, r.name, 36) : null,
    h("div.grow", null,
      h("div.row.wrap", null,
        r.document ? linkChip(r.document.type, r.document.id, r.name) : h("strong", null, r.name || "—"),
        r.document && r.name && game.get<BaseDoc & { name: string }>(r.document.type, r.document.id)?.name !== r.name ? h("span", null, r.name) : null,
        r.roll !== null && t.results.length > 1 ? h("span.muted.small", null, `(${r.roll})`) : null,
        r.from ? h("span.muted.small", null, `de ${r.from}`) : null),
      r.description ? h("div.small", null, r.description.includes("<") ? safeHtml(r.description) : r.description) : null))));
}

/** Text with [[formula]] markers turned into result chips (hover for the dice). */
function withInlineRolls(content: string, rolls: RollResult[]): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  let last = 0, i = 0;
  for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    out.push(content.slice(last, m.index));
    const r = rolls[i++];
    out.push(r
      ? h("span.inline-roll", { title: `${r.formula}${termsSummary(r.terms)}` }, h("i.fa-solid.fa-dice-d20"), " ", formatTotal(r.total))
      : m[0]);
    last = m.index! + m[0].length;
  }
  out.push(content.slice(last));
  return out;
}

function termsSummary(terms: RollTerm[]): string {
  const groups = terms.filter(t => t.kind !== "number").map(t => {
    const results = (t.results as (DieResult | { value: number; kept: boolean })[]).map(r => (isActive(r) ? String(r.value) : `(${r.value})`));
    return `${t.formula ?? `${(t as { count: number }).count}d${(t as { faces: number }).faces}`}: ${results.join(", ")}`;
  });
  return groups.length ? `\n${groups.join("\n")}` : "";
}

const formatTotal = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString("pt-PT", { maximumFractionDigits: 2 }));
const isActive = (r: DieResult | { value: number; kept: boolean }) => ("active" in r ? r.active : r.kept);

function dieClass(r: DieResult | { value: number; kept: boolean }, faces: number | "f" | "c" | undefined): string {
  const cls = ["die"];
  if (typeof faces === "number") cls.push(`d${faces}`);
  else if (faces === "f") cls.push("fate");
  else if (faces === "c") cls.push("coin");
  if (!isActive(r)) cls.push("dropped");
  const d = r as DieResult;
  if (d.rerolled) cls.push("rerolled");
  if (d.exploded) cls.push("exploded");
  if (d.success) cls.push("success");
  if (d.failure) cls.push("failure");
  // Natural max/min highlights only make sense for plain dice without success counting.
  if (typeof faces === "number" && d.success === undefined && d.failure === undefined) {
    if (r.value === faces) cls.push("max");
    else if (r.value === 1) cls.push("min");
  }
  return cls.join(" ");
}

function dieLabel(value: number, faces: number | "f" | "c" | undefined): string {
  if (faces === "f") return value > 0 ? "+" : value < 0 ? "−" : "0";
  if (faces === "c") return value ? "cara" : "coroa";
  return String(value);
}

function rollView(r: RollResult): HTMLElement {
  const groups = r.terms.map(t => {
    if (t.kind === "number") return h("span.mod", null, `${t.sign < 0 ? "−" : "+"}${t.value}`);
    const faces = t.kind === "dice" ? t.faces : undefined;
    const results = (t.results as (DieResult | { value: number; kept: boolean })[]).map(res =>
      h("span", { className: dieClass(res, faces), title: dieTitle(res) }, dieLabel(res.value, faces)));
    // New-style terms label each group; old messages just list their dice.
    if (!t.formula) return results;
    // A lone group that is the whole formula needs no label of its own.
    const label = r.terms.length > 1 || t.formula !== r.formula || t.flavor;
    return h("div.dice-group", null,
      label ? h("span.group-formula", null, t.formula, t.flavor ? h("em", null, ` ${t.flavor}`) : null) : null,
      h("span.group-dice", null, results),
      r.terms.length > 1 ? h("span.group-total", null, formatTotal(t.total)) : null);
  });
  return h("div.roll", null,
    h("div.formula", null, r.formula),
    groups.length > 0 && h("div.dice", null, groups.flat()),
    h("div.total", null, formatTotal(r.total))
  );
}

function dieTitle(r: DieResult | { value: number; kept: boolean }): string {
  const d = r as DieResult;
  const notes = [d.discarded || ("kept" in r && !r.kept) ? "descartado" : "", d.rerolled ? "re-rolado" : "", d.exploded ? "explodiu" : "",
    d.success ? "sucesso" : "", d.failure ? "falha" : "", d.count !== undefined && !d.success && !d.failure && !d.rerolled ? `conta ${d.count}` : "",
    d.count !== undefined && d.rerolled ? `conta como ${d.count}` : ""].filter(Boolean);
  return notes.join(", ");
}
