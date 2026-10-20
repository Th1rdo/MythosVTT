import type { ActorDoc, AudioChannel, MacroDoc, RollMode, RollTableDoc, RunMacroEvent, TokenDoc, UserDoc } from "../../shared/protocol.ts";
import { drawTable } from "./ui/tables.ts";
import { canRunMacro } from "../../shared/permissions.ts";
import { game, toast } from "./game.ts";
import type { Board } from "./canvas/board.ts";
import { audio } from "./audio/engine.ts";
import { send, speaker as defaultSpeaker } from "./ui/chat.ts";
import { openSheet } from "./ui/sheet.ts";
import { confirmDialog } from "./ui/windows.ts";

type Speaker = { actor: string | null; alias: string };

/** What script macros get besides speaker/actor/token/character/scope: Mesa's API. */
export interface MacroApi {
  game: typeof game;
  board: Board | null;
  audio: typeof audio;
  /** Tokens the user has selected on the map. */
  selected: () => TokenDoc[];
  notify: (message: string, kind?: "info" | "error") => void;
  /** Post a message (or a /r roll) to the chat, as the macro's speaker. */
  chat: (text: string) => Promise<void>;
  roll: (formula: string, flavor?: string) => Promise<void>;
  /** Play a sound here, and for everyone else too if you're the GM and `everyone` is on. */
  playAudio: (src: string, opts?: { volume?: number; channel?: AudioChannel; loop?: boolean }, everyone?: boolean) => void;
  openSheet: (actorId: string) => void;
  /** Draw from a roll table by name or id (posts the result to the chat). */
  drawTable: (nameOrId: string, opts?: { count?: number; mode?: RollMode }) => Promise<boolean>;
}

let board: Board | null = null;
/** Script macros by other people that the GM already agreed to run this session. */
const trusted = new Set<string>();

export function setMacroBoard(b: Board): void {
  board = b;
}

/** Speaker for a macro: the given/selected token, else the user's character, else the user. */
function speakerFor(token: TokenDoc | null): Speaker {
  if (token) return { actor: token.actorId, alias: token.name };
  return defaultSpeaker();
}

export interface MacroScope {
  token?: TokenDoc | null;
  actor?: ActorDoc | null;
  speaker?: Speaker;
  [key: string]: unknown;
}

/**
 * Run a macro as the current user. Chat macros go through the chat input (several "/" lines run one
 * after the other). Script macros are an async function body with `speaker, actor, token, character,
 * scope, mesa` and any extra scope entries in reach.
 */
export async function executeMacro(macro: MacroDoc, scope: MacroScope = {}): Promise<unknown> {
  if (!canRunMacro(macro, game.user)) {
    toast(`Não podes executar a macro "${macro.name}".`, "error");
    return;
  }
  const { token: givenToken, actor: givenActor, speaker: givenSpeaker, ...extra } = scope;
  const token = givenToken ?? board?.selectedToken?.doc ?? null;
  const speaker = givenSpeaker ?? speakerFor(token);
  const actor = givenActor ?? game.get<ActorDoc>("Actor", token?.actorId ?? speaker.actor) ?? null;

  if (macro.type === "chat") {
    const lines = macro.command.split("\n").map(l => l.trim()).filter(Boolean);
    const commands = lines.length > 1 && lines.every(l => l.startsWith("/")) ? lines : [macro.command.trim()];
    for (const c of commands) if (c) await send(c, speaker);
    return;
  }

  // A GM running someone else's script gives it GM powers: ask once per macro per session.
  const author = game.get<UserDoc>("User", macro.author);
  if (game.isGM && macro.author !== game.userId && author?.role !== "gm" && !trusted.has(macro._id)) {
    const ok = await confirmDialog(`A macro "${macro.name}" é um script escrito por ${author?.name ?? "outra pessoa"}. Correr com permissões de mestre?`, "Executar");
    if (!ok) return;
    trusted.add(macro._id);
  }
  const names = Object.keys(extra);
  if (names.some(n => !/^[A-Za-z_$][\w$]*$/.test(n))) throw new Error("Nome de parâmetro de macro inválido");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
  try {
    const fn = new AsyncFunction("speaker", "actor", "token", "character", "scope", "mesa", ...names, `${macro.command}\n`);
    const character = game.get<ActorDoc>("Actor", game.user.character) ?? null;
    return await fn.call(macro, speaker, actor, token, character, scope, api(speaker), ...Object.values(extra));
  } catch (err) {
    console.error(`Macro "${macro.name}"`, err);
    toast(`Erro na macro "${macro.name}": ${(err as Error).message}`, "error");
  }
}

function api(speaker: Speaker): MacroApi {
  return {
    game,
    board,
    audio,
    selected: () => board?.selected.map(v => v.doc) ?? [],
    notify: (message, kind = "info") => toast(String(message), kind),
    chat: text => send(String(text), speaker),
    roll: (formula, flavor) => game.roll({ formula, flavor, speaker }),
    playAudio: (src, opts = {}, everyone = true) => {
      audio.playOnce(src, opts);
      if (everyone && game.isGM) game.socket.emit("playAudio", { src, ...opts });
    },
    openSheet: id => openSheet(id),
    drawTable: async (nameOrId, opts = {}) => {
      const t = game.get<RollTableDoc>("RollTable", nameOrId) ?? game.all<RollTableDoc>("RollTable").find(x => x.name === nameOrId);
      if (!t) {
        toast(`Não há tabela "${nameOrId}"`, "error");
        return false;
      }
      return drawTable(t._id, opts.count, opts.mode);
    }
  };
}

/** A region behaviour asked this client to run a macro. */
export function onRunMacro(e: RunMacroEvent): void {
  const macro = game.get<MacroDoc>("Macro", e.macroId);
  if (!macro) return;
  const token = game.get<TokenDoc>("Token", e.tokenId) ?? null;
  executeMacro(macro, { token, region: game.get("Region", e.regionId) ?? null, scene: game.get("Scene", e.sceneId) ?? null, event: e.event });
}
