import type { ActorDoc, ChatMessageDoc, RollResult, UserDoc } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { avatar, h, safeHtml, timeLabel } from "../dom.ts";

const HELP = "Escreve uma mensagem, ou rola dados:\n/r 2d20kh+5 # Luta  — rola, com descrição após #\n/gr 1d20  — rolagem só para o mestre";

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

function speaker(): { actor: string | null; alias: string } {
  const user = game.user;
  const actor = game.get<ActorDoc>("Actor", user.character);
  return actor ? { actor: actor._id, alias: actor.name } : { actor: null, alias: user.name };
}

async function send(text: string): Promise<void> {
  const cmd = /^\/(r|roll|gr|gmroll)\s+(.+)$/i.exec(text);
  if (cmd) {
    const [formula, ...flavor] = cmd[2].split("#");
    await game.roll({ formula: formula.trim(), flavor: flavor.join("#").trim() || undefined, speaker: speaker(), whisperGM: /^g/i.test(cmd[1]) });
    return;
  }
  if (text.startsWith("/")) {
    toast(HELP);
    return;
  }
  await game.create("ChatMessage", { content: text, speaker: speaker() }).catch(() => {});
}

export function messageView(m: ChatMessageDoc): HTMLElement {
  const author = game.get<UserDoc>("User", m.author);
  const actor = game.get<ActorDoc>("Actor", m.speaker.actor);
  const name = m.speaker.alias || actor?.name || author?.name || "?";
  // Imported Foundry roll messages repeat the total as their content; the roll card already shows it.
  const redundant = !!m.roll && m.content.trim() === String(m.roll.total);
  const body = redundant || !m.content ? null : m.html ? h("div.prose", null, safeHtml(m.content)) : h("div.text", null, m.content);
  return h("article.msg", { className: m.whisper ? "msg whisper" : "msg", style: { borderLeftColor: author?.color ?? "#555" } },
    h("header.row", null,
      avatar(actor?.img, name, 24),
      h("strong.grow", null, name),
      m.whisper && h("span.tag", null, "privado"),
      h("time.muted.small", null, timeLabel(m.timestamp)),
      game.isGM && h("button.icon.small", { title: "Apagar", onclick: () => game.delete("ChatMessage", m._id) }, "✕")
    ),
    m.flavor && h("div.flavor", null, m.flavor),
    body,
    m.roll && rollView(m.roll)
  );
}

function rollView(r: RollResult): HTMLElement {
  return h("div.roll", null,
    h("div.formula", null, r.formula),
    r.terms.length > 0 && h("div.dice", null, r.terms.flatMap(t => t.kind === "dice"
      ? t.results.map(res => h("span", {
          className: `die d${t.faces}${res.kept ? "" : " dropped"}${res.value === t.faces ? " max" : res.value === 1 ? " min" : ""}`,
          title: `d${t.faces}`
        }, String(res.value)))
      : [h("span.mod", null, `${t.sign < 0 ? "−" : "+"}${t.value}`)])),
    h("div.total", null, String(r.total))
  );
}
