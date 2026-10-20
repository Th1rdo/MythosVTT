import { MODULE_ID, log } from "./const.js";
import { registarDefinicoes, acoes } from "./dados.js";
import { atualizar } from "./relogio.js";
import { Painel } from "./painel.js";

/**
 * Uma contagem decrescente que toda a mesa vê. O mestre abre o painel (botão nas
 * ferramentas dos tokens, ou atalho), escolhe a duração e carrega em Começar; um
 * relógio pequeno aparece no topo do ecrã de todos.
 *
 * Port para a Mesa do módulo do Foundry (mesma lógica, mesmo aspeto); usa só a API `mesa`.
 */
const { hooks } = mesa;

hooks.once("init", () => {
  registarDefinicoes();
  mesa.keybindings.register(MODULE_ID, "painel", {
    name: mesa.i18n.localize("CONTAGEM.Atalho"), bindings: [], gm: true,
    onDown: () => { Painel.alternar(); return true; }
  });
});

hooks.once("ready", () => {
  mesa.contagem = { ...acoes, abrir: () => Painel.alternar() };
  // quem entra ou recarrega a meio de uma contagem vê-a logo, no tempo certo
  atualizar();
  log("pronto");
});

// o mestre mudou a contagem (este ou outro mestre): todos redesenham a partir da definição
hooks.on(`${MODULE_ID}.estado`, () => {
  atualizar();
  Painel.redesenhar();
});
// chegou a zero sozinha: o painel volta a «Começar»
hooks.on(`${MODULE_ID}.acabou`, () => Painel.redesenhar());

// o botão nas ferramentas dos tokens (só o mestre)
hooks.on("getSceneControlButtons", (grupos) => {
  if (!mesa.game.isGM) return;
  const tokens = grupos.find(g => g.name === "tokens");
  tokens?.tools.push({
    name: "contagem", icon: "fa-solid fa-hourglass-half", title: mesa.i18n.localize("CONTAGEM.Titulo"),
    button: true, run: () => Painel.alternar()
  });
});
