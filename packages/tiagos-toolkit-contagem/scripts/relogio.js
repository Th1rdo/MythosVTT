import { MODULE_ID, FIM_VISIVEL_MS, TIQUE_MS } from "./const.js";
import * as L from "./logica.js";
import { estado, agora, somLigado, eu } from "./dados.js";
import { tocarFim } from "./som.js";

/**
 * O relógio no topo do ecrã, igual para todos (mestre, jogadores, Transmissão).
 *
 * Um elemento nosso pendurado no `body`, fora das janelas: não tem
 * ciclo de vida para gerir e não apanha cliques (`pointer-events: none`) — fica
 * por cima do mapa sem nunca o tapar.
 *
 * Só há tique enquanto a contagem anda. Parada, em pausa ou sem contagem, não há
 * temporizador nenhum: este módulo pode ficar ligado o ano inteiro sem custo.
 */

let el = null;
let intervalo = null;
let saida = null;
/** A contagem que este cliente viu a andar: só essa dá som ao acabar (quem recarrega no fim não ouve). */
let vistoACorrer = null;
/** O fim já mostrado — o `onChange` e o tique podem chegar os dois ao zero. */
let fimMostrado = null;

function criar() {
  if (el) return el;
  el = document.createElement("div");
  el.id = "contagem-relogio";
  el.setAttribute("role", "timer");
  el.innerHTML = `
    <div class="contagem-rotulo"></div>
    <div class="contagem-tempo"><span class="contagem-pausa"></span><span class="contagem-digitos">0:00</span></div>
    <div class="contagem-linha"><div class="contagem-cheia"></div></div>`;
  document.body.appendChild(el);
  return el;
}

const parte = (sel) => el.querySelector(sel);

function desenhar(e, t) {
  const ms = L.restanteMs(e, t);
  const texto = L.formatar(L.segundosVisiveis(ms));
  parte(".contagem-digitos").textContent = texto;
  parte(".contagem-rotulo").textContent = e.rotulo;
  el.classList.toggle("contagem-sem-rotulo", !e.rotulo);
  parte(".contagem-cheia").style.transform = `scaleX(${L.fracao(e, t)})`;
  el.classList.toggle("contagem-ultimos", L.fase(e, t) === "a-correr" && L.nosUltimos(ms));
  // o painel do mestre, se estiver aberto, mostra o mesmo número sem tique próprio
  const noPainel = document.querySelector("#contagem-painel .contagem-painel-tempo");
  if (noPainel) noPainel.textContent = texto;
}

function ligar() {
  if (!intervalo) intervalo = setInterval(tique, TIQUE_MS);
}
function desligar() {
  clearInterval(intervalo);
  intervalo = null;
}

function tique() {
  const e = estado(), t = agora();
  if (L.fase(e, t) !== "a-correr") return atualizar();
  desenhar(e, t);
}

function mostrar() {
  clearTimeout(saida);
  saida = null;
  el.classList.add("contagem-visivel");
}

function esconder() {
  desligar();
  clearTimeout(saida);
  saida = null;
  el?.classList.remove("contagem-visivel", "contagem-ultimos");
}

/** Chegou a zero: flash, som (se a vimos andar), e desvanece uns segundos depois. */
function acabar(e, t) {
  desligar();
  if (!L.aMostrarFim(e, t)) { vistoACorrer = null; return esconder(); }
  const chave = `${e.id}:${e.fim}`;
  if (fimMostrado === chave) return;
  fimMostrado = chave;
  desenhar(e, t);
  el.classList.remove("contagem-pausado");
  el.classList.add("contagem-fim");
  mostrar();
  if (vistoACorrer === e.id && somLigado()) tocarFim();
  vistoACorrer = null;
  saida = setTimeout(esconder, Math.max(0, FIM_VISIVEL_MS - (t - e.fim)));
  // o painel do mestre volta a «começar» sem ninguém ter mexido na definição
  mesa.hooks.callAll(`${MODULE_ID}.acabou`);
}

/** Lê a definição e põe o relógio no estado certo. Chamado no `ready`, no `onChange` e pelo tique. */
export function atualizar() {
  if (!mesa.game.user) return;
  criar();
  const e = estado(), t = agora();
  const f = L.fase(e, t);
  if (f === "inativo" || !L.podeVer(e, eu())) { vistoACorrer = null; return esconder(); }
  if (f === "terminado") return acabar(e, t);
  fimMostrado = null;
  el.classList.remove("contagem-fim");
  el.classList.toggle("contagem-pausado", f === "pausado");
  desenhar(e, t);
  mostrar();
  if (f === "a-correr") { vistoACorrer = e.id; ligar(); }
  else desligar();
}
