import { PRESETS, PASSO } from "./const.js";
import * as L from "./logica.js";
import { estado, agora, acoes, utilizadores } from "./dados.js";

/**
 * O painel do mestre: pequeno, flutuante, só o necessário. Parado mostra a
 * duração, o rótulo e a quem; a correr mostra o tempo e os quatro botões.
 *
 * Port para a Mesa: uma janela da Mesa (`mesa.ui.openWindow`) em vez de um
 * ApplicationV2; o HTML e o comportamento são os do módulo do Foundry. O que o
 * mestre escreveu fica guardado aqui e volta a cada render — um render a meio
 * (outro mestre, ou a contagem a acabar) não lhe apaga o rótulo.
 */
const CHAVE = "tiagos-toolkit-contagem-painel";
const t = (k) => mesa.i18n.localize(k);
const esc = (s) => mesa.utils.escapeHtml(String(s ?? ""));

let raiz = null;
let duracao = "1:00";
let rotulo = "";
let modo = "todos";
const escolhidos = new Set();

export const Painel = {
  alternar() {
    if (!mesa.game.isGM) return;
    if (mesa.ui.isOpen(CHAVE)) return mesa.ui.closeWindow(CHAVE);
    const body = mesa.ui.openWindow(CHAVE, t("CONTAGEM.Titulo"), { width: 300, onClose: () => (raiz = null) });
    if (!body) return;
    raiz = document.createElement("div");
    raiz.id = "contagem-painel";
    body.append(raiz);
    ligar(raiz);
    desenhar();
  },
  redesenhar() {
    if (raiz?.isConnected) desenhar();
  }
};

function desenhar() {
  const e = estado(), agoraMs = agora(), f = L.fase(e, agoraMs);
  const users = utilizadores();

  if (f === "a-correr" || f === "pausado") {
    const pausado = f === "pausado";
    const quem = e.para === "todos" ? t("CONTAGEM.Todos")
      : (e.para.map(id => users.find(u => u.id === id)?.name).filter(Boolean).join(", ") || t("CONTAGEM.SoTu"));
    raiz.innerHTML = `
      <div class="contagem-painel contagem-painel-ativo">
        ${e.rotulo ? `<div class="contagem-painel-rotulo">${esc(e.rotulo)}</div>` : ""}
        <div class="contagem-painel-tempo">${L.formatar(L.segundosVisiveis(L.restanteMs(e, agoraMs)))}</div>
        <div class="contagem-botoes">
          <button type="button" class="contagem-botao" data-action="menos">−${PASSO} s</button>
          <button type="button" class="contagem-botao contagem-principal" data-action="${pausado ? "retomar" : "pausar"}">
            <i class="fa-solid ${pausado ? "fa-play" : "fa-pause"}"></i> ${t(pausado ? "CONTAGEM.Retomar" : "CONTAGEM.Pausar")}</button>
          <button type="button" class="contagem-botao" data-action="mais">+${PASSO} s</button>
        </div>
        <div class="contagem-quem">${t("CONTAGEM.Para")}: ${esc(quem)}</div>
        <button type="button" class="contagem-botao contagem-cancelar" data-action="cancelar">
          <i class="fa-solid fa-xmark"></i> ${t("CONTAGEM.Cancelar")}</button>
      </div>`;
    return;
  }

  const segundos = L.lerDuracao(duracao);
  const jogadores = users.filter(u => !u.isGM);
  raiz.innerHTML = `
    <div class="contagem-painel">
      <div class="contagem-presets">
        ${PRESETS.map(s => `<button type="button" class="contagem-botao contagem-preset ${s === segundos ? "contagem-sel" : ""}" data-action="preset" data-segundos="${s}">${s < 60 ? `${s} s` : `${s / 60} min`}</button>`).join("")}
      </div>
      <label class="contagem-campo"><span>${t("CONTAGEM.Duracao")}</span>
        <input type="text" name="duracao" value="${esc(duracao)}" placeholder="90 · 1:30 · 2m" autocomplete="off">
        <em class="contagem-previa">${segundos ? `= ${L.formatar(segundos)}` : ""}</em></label>
      <label class="contagem-campo"><span>${t("CONTAGEM.Rotulo")}</span>
        <input type="text" name="rotulo" value="${esc(rotulo)}" placeholder="${esc(t("CONTAGEM.RotuloExemplo"))}" maxlength="80" autocomplete="off"></label>
      <div class="contagem-publico">
        <label class="contagem-opcao"><input type="radio" name="modo" value="todos" ${modo === "todos" ? "checked" : ""}> ${t("CONTAGEM.Todos")}</label>
        <label class="contagem-opcao"><input type="radio" name="modo" value="escolher" ${modo === "escolher" ? "checked" : ""}> ${t("CONTAGEM.Escolher")}</label>
      </div>
      <div class="contagem-jogadores ${modo === "escolher" ? "" : "contagem-escondido"}">
        ${jogadores.map(u => `<label class="contagem-opcao"><input type="checkbox" name="jogador" value="${esc(u.id)}" ${escolhidos.has(u.id) ? "checked" : ""}> ${esc(u.name)}</label>`).join("")
          || `<span class="contagem-quem">${t("CONTAGEM.SemJogadores")}</span>`}
      </div>
      <button type="button" class="contagem-botao contagem-principal contagem-comecar" data-action="comecar">
        <i class="fa-solid fa-play"></i> ${t("CONTAGEM.Comecar")}</button>
    </div>`;
}

/** Os campos guardam-se a cada tecla; Enter num campo começa. Ligado uma vez: a raiz sobrevive aos renders. */
function ligar(el) {
  el.addEventListener("input", (ev) => guardar(ev.target));
  el.addEventListener("change", (ev) => guardar(ev.target));
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || !ev.target.matches?.("input[type=text]")) return;
    ev.preventDefault();
    comecar();
  });
  el.addEventListener("click", (ev) => {
    const botao = ev.target.closest?.("[data-action]");
    if (!botao) return;
    const acao = botao.dataset.action;
    if (acao === "preset") return preset(botao);
    if (acao === "comecar") return comecar();
    if (acao === "pausar") return acoes.pausar();
    if (acao === "retomar") return acoes.retomar();
    if (acao === "mais") return acoes.ajustar(PASSO);
    if (acao === "menos") return acoes.ajustar(-PASSO);
    if (acao === "cancelar") return acoes.cancelar();
  });
}

function guardar(alvo) {
  const nome = alvo?.name;
  if (nome === "duracao") {
    duracao = alvo.value;
    const s = L.lerDuracao(alvo.value);
    alvo.classList.toggle("contagem-invalido", !!alvo.value.trim() && !s);
    const previa = raiz.querySelector(".contagem-previa");
    if (previa) previa.textContent = s ? `= ${L.formatar(s)}` : "";
    for (const b of raiz.querySelectorAll(".contagem-preset")) b.classList.toggle("contagem-sel", Number(b.dataset.segundos) === s);
  } else if (nome === "rotulo") {
    rotulo = alvo.value;
  } else if (nome === "modo") {
    modo = alvo.value;
    raiz.querySelector(".contagem-jogadores")?.classList.toggle("contagem-escondido", modo !== "escolher");
  } else if (nome === "jogador") {
    if (alvo.checked) escolhidos.add(alvo.value);
    else escolhidos.delete(alvo.value);
  }
}

/** Um atalho preenche a duração (o rótulo e a quem continuam por escolher); «Começar» arranca. */
function preset(botao) {
  const campo = raiz.querySelector("input[name=duracao]");
  if (!campo) return;
  campo.value = L.formatar(Number(botao.dataset.segundos));
  guardar(campo);
}

function comecar() {
  const s = L.lerDuracao(duracao);
  if (!s) return mesa.toast(t("CONTAGEM.DuracaoInvalida"), "warning");
  let para = "todos";
  if (modo === "escolher") {
    // só os que ainda existem — um jogador apagado entretanto não conta
    para = [...escolhidos].filter(id => mesa.game.get("User", id));
    if (!para.length) return mesa.toast(t("CONTAGEM.NinguemEscolhido"), "warning");
  }
  return acoes.iniciar(s, { rotulo, para });
}
