import { MODULE_ID } from "./const.js";
import { colecaoDe, vi, retirar } from "./dados.js";
import * as papel from "./papel.js";

const JANELA = `${MODULE_ID}-colecao`;
const t = (k, d) => (d ? mesa.i18n.format(k, d) : mesa.i18n.localize(k));
const esc = (s) => mesa.utils.escapeHtml(String(s ?? ""));

/**
 * Os documentos de um jogador: tudo o que o mestre lhe mostrou, o mais recente
 * primeiro, com um ponto nos que ainda não abriu. Clicar pousa-o na mesa dele.
 *
 * O mestre abre a mesma janela com um separador por jogador — para ver o que
 * cada um tem, e retirar o que mostrou à pessoa errada.
 *
 * Port para a Mesa: janela da Mesa + HTML gerado aqui (o do template original).
 */
let raiz = null;
let dono = null;

const jogadores = () => mesa.game.all("User").filter(u => u.role !== "gm");
const userAtual = () => (mesa.game.isGM ? (mesa.game.get("User", dono) ?? jogadores()[0] ?? null) : mesa.game.user);

export const Colecao = {
  alternar(donoId = null) {
    if (donoId) dono = donoId;
    if (mesa.ui.isOpen(JANELA)) {
      if (!donoId) return mesa.ui.closeWindow(JANELA);
      return desenhar();
    }
    const titulo = t(mesa.game.isGM ? "HANDOUTS.Col.TituloMestre" : "HANDOUTS.Col.Titulo");
    const body = mesa.ui.openWindow(JANELA, titulo, { width: 640, onClose: () => (raiz = null) });
    if (!body) return;
    raiz = document.createElement("div");
    raiz.className = "ho-janela ho-janela-col";
    body.append(raiz);
    raiz.addEventListener("click", clique);
    desenhar();
  },
  redesenhar() {
    if (raiz?.isConnected) desenhar();
  }
};

function desenhar() {
  const u = userAtual();
  const isGM = mesa.game.isGM;
  const data = new Intl.DateTimeFormat(mesa.i18n.lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const itens = colecaoDe(u);
  raiz.innerHTML = `
<section class="ho-col">
  ${isGM ? `<nav class="ho-abas">
    ${jogadores().map(j => {
      const total = colecaoDe(j).length;
      return `<button type="button" class="ho-aba ${j._id === u?._id ? "ho-ativa" : ""}" data-accao="dono" data-id="${esc(j._id)}">
        <span>${esc(j.name)}</span>${total ? `<span class="ho-conta">${total}</span>` : ""}</button>`;
    }).join("")}
  </nav>` : ""}
  <div class="ho-corpo">
    ${itens.length ? `<div class="ho-grelha">
      ${itens.map(x => `
      <article class="ho-cartao ${x.visto ? "" : "ho-novo"}">
        <div class="ho-miniatura" data-accao="ver" data-id="${esc(x.id)}">
          <img src="${esc(x.img)}" alt="" loading="lazy" draggable="false">
          ${isGM ? `<div class="ho-cartao-accoes">
            <button type="button" class="ho-icone" data-accao="retirar" data-id="${esc(x.id)}" title="${esc(t("HANDOUTS.Col.Retirar"))}"><i class="fa-solid fa-trash"></i></button>
          </div>` : ""}
        </div>
        <div class="ho-cartao-nome" title="${esc(x.nome)}">${esc(x.nome)}<small>${x.quando ? esc(data.format(new Date(x.quando))) : ""}</small></div>
      </article>`).join("")}
    </div>` : `<p class="ho-vazio">${esc(t(isGM ? "HANDOUTS.Col.VazioMestre" : "HANDOUTS.Col.Vazio"))}</p>`}
  </div>
</section>`;
}

async function clique(ev) {
  const alvo = ev.target.closest("[data-accao]");
  if (!alvo) return;
  ev.preventDefault();
  ev.stopPropagation();
  const id = alvo.dataset.id;
  switch (alvo.dataset.accao) {
    case "dono": dono = id; return desenhar();
    case "ver": {
      const item = colecaoDe(userAtual()).find(x => x.id === id);
      if (item) papel.abrir(item, { aoVer: mesa.game.isGM ? null : vi });
      return;
    }
    case "retirar": {
      const u = userAtual();
      const item = colecaoDe(u).find(x => x.id === id);
      if (await mesa.dialogs.confirm(t("HANDOUTS.Col.RetirarPergunta", { nome: item?.nome ?? "", jogador: u.name }), t("HANDOUTS.Col.Retirar"))) {
        await retirar(u._id, id);
      }
      return;
    }
  }
}
