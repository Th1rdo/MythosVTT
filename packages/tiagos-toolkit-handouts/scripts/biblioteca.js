import { MODULE_ID } from "./const.js";
import * as L from "./logica.js";
import { biblioteca, mudarBiblioteca, colecaoDe, enviarImagens, imagemDoQueSeLargou, escolherImagem, dadosDoArrasto } from "./dados.js";
import * as papel from "./papel.js";

const CHAVE_ABA = `${MODULE_ID}.aba`;
const JANELA = `${MODULE_ID}-biblioteca`;
const t = (k, d) => (d ? mesa.i18n.format(k, d) : mesa.i18n.localize(k));
const esc = (s) => mesa.utils.escapeHtml(String(s ?? ""));

/**
 * A biblioteca do mestre.
 *
 * Separadores = categorias («Sessão 3», «NPCs»); dentro, secções que se recolhem
 * («Hospital», «Rua Bento Lisboa»); dentro, os documentos em cartões.
 *
 * O gesto principal é um clique: por baixo de cada cartão estão as caras dos
 * jogadores — clicar numa mostra o documento a essa pessoa, «Todos» a toda a
 * gente. Quem já o recebeu tem a cara acesa, para não mostrar duas vezes sem
 * querer. Clicar na imagem abre-a só para o mestre ver.
 *
 * Port para a Mesa: uma janela da Mesa em vez do ApplicationV2 e funções em vez dos
 * templates Handlebars (o HTML e as classes são os mesmos, e o CSS também).
 */
let raiz = null;
let aba = null;
let procura = "";

export const Biblioteca = {
  /** O que fazer quando o mestre clica numa cara (ligado em main.js). */
  aoMostrar: async () => {},
  aoAbrirColecoes: () => {},

  alternar() {
    if (mesa.ui.isOpen(JANELA)) return mesa.ui.closeWindow(JANELA);
    const body = mesa.ui.openWindow(JANELA, t("HANDOUTS.Bib.Titulo"), { width: 860, onClose: () => (raiz = null) });
    if (!body) return;
    raiz = document.createElement("div");
    raiz.className = "ho-janela ho-janela-bib";
    body.append(raiz);
    ligar(raiz);
    desenhar();
  },
  redesenhar() {
    if (raiz?.isConnected) desenhar();
  }
};

function abaGuardada() {
  try { return localStorage.getItem(CHAVE_ABA); } catch { return null; }
}

// ---------------------------------------------------------------- HTML

function contexto() {
  const b = biblioteca();
  const atual = L.categoria(b, aba ?? abaGuardada()) ?? b.categorias[0];
  aba = atual.id;

  // as caras por baixo de cada cartão: todos os jogadores, ligados ou não —
  // quem não está ligado recebe na coleção e vê quando entrar
  const jogadores = mesa.game.all("User").filter(u => u.role !== "gm");
  const temPorUser = new Map(jogadores.map(u => [u._id, new Set(colecaoDe(u).map(x => x.id))]));
  const caras = (itemId) => jogadores.map(u => {
    const tem = temPorUser.get(u._id).has(itemId);
    const ligado = mesa.game.online.includes(u._id);
    const avatar = mesa.game.get("Actor", u.character)?.img ?? u.avatar ?? null;
    const estado = t(tem ? "HANDOUTS.Bib.JaTem" : (ligado ? "HANDOUTS.Bib.Ligado" : "HANDOUTS.Bib.Desligado"));
    return {
      userId: u._id, avatar, inicial: (u.name ?? "?").slice(0, 1).toUpperCase(),
      cor: u.color ?? "#888", ligado, tem, dica: `${t("HANDOUTS.Bib.MostrarA", { nome: u.name })} · ${estado}`
    };
  });
  const comCaras = (i) => ({ ...i, jogadores: caras(i.id) });
  const achados = procura ? L.procurar(b, procura).map(comCaras) : null;
  return {
    achados: achados?.length ? achados : null,
    categorias: b.categorias.map(c => ({
      id: c.id, nome: c.nome, ativa: c.id === atual.id, total: c.seccoes.reduce((n, s) => n + s.itens.length, 0)
    })),
    categoria: { ...atual, seccoes: atual.seccoes.map(s => ({ ...s, itens: s.itens.map(comCaras) })) }
  };
}

const icone = (accao, id, dica, classe) =>
  `<button type="button" class="ho-icone" data-accao="${accao}" data-id="${esc(id)}" title="${esc(t(dica))}"><i class="fa-solid ${classe}"></i></button>`;

function cartao(i) {
  return `
  <article class="ho-cartao" draggable="true" data-item="${esc(i.id)}">
    <div class="ho-miniatura" data-accao="ver" data-id="${esc(i.id)}" title="${esc(t("HANDOUTS.Bib.Ver"))}">
      <img src="${esc(i.img)}" alt="" loading="lazy" draggable="false">
      <div class="ho-cartao-accoes">
        ${icone("renomear-item", i.id, "HANDOUTS.Bib.Renomear", "fa-pen")}
        ${icone("apagar-item", i.id, "HANDOUTS.Bib.ApagarDocumento", "fa-trash")}
      </div>
    </div>
    <div class="ho-cartao-nome" title="${esc(i.nome)}">${esc(i.nome)}${i.seccao ? `<small>${esc(i.categoria)} · ${esc(i.seccao)}</small>` : ""}</div>
    <div class="ho-mostrar">
      ${i.jogadores.map(j => `
      <button type="button" class="ho-pessoa ${j.ligado ? "ho-ligado" : ""} ${j.tem ? "ho-tem" : ""}"
        data-accao="mostrar" data-id="${esc(i.id)}" data-para="${esc(j.userId)}" style="--ho-cor: ${esc(j.cor)}" title="${esc(j.dica)}">
        ${j.avatar ? `<img src="${esc(j.avatar)}" alt="" draggable="false">` : `<span>${esc(j.inicial)}</span>`}
      </button>`).join("")}
      <button type="button" class="ho-todos" data-accao="mostrar" data-id="${esc(i.id)}" data-para="todos">${esc(t("HANDOUTS.Bib.Todos"))}</button>
    </div>
  </article>`;
}

function html(c) {
  const cat = c.categoria;
  return `
<section class="ho-bib">
  <nav class="ho-abas">
    ${c.categorias.map(k => `
    <button type="button" class="ho-aba ${k.ativa ? "ho-ativa" : ""}" data-accao="aba" data-id="${esc(k.id)}" data-alvo-categoria="${esc(k.id)}">
      <span>${esc(k.nome)}</span>${k.total ? `<span class="ho-conta">${k.total}</span>` : ""}
    </button>`).join("")}
    <button type="button" class="ho-aba ho-aba-mais" data-accao="nova-categoria" title="${esc(t("HANDOUTS.Bib.NovaCategoria"))}"><i class="fa-solid fa-plus"></i></button>
    <span class="ho-espaco"></span>
    <input type="search" class="ho-procura" data-campo="procura" value="${esc(procura)}" placeholder="${esc(t("HANDOUTS.Bib.Procurar"))}">
  </nav>

  <div class="ho-corpo">
    ${c.achados ? `
    <div class="ho-seccao">
      <header class="ho-seccao-topo"><span class="ho-seccao-nome">${esc(t("HANDOUTS.Bib.Resultados"))}</span><span class="ho-conta">${c.achados.length}</span></header>
      <div class="ho-grelha">${c.achados.map(cartao).join("")}</div>
    </div>` : (procura ? `<p class="ho-vazio">${esc(t("HANDOUTS.Bib.NadaEncontrado"))}</p>` : "")}

    ${procura ? "" : `
    <header class="ho-categoria-topo">
      <span class="ho-categoria-nome">${esc(cat.nome)}</span>
      ${icone("renomear-categoria", cat.id, "HANDOUTS.Bib.Renomear", "fa-pen")}
      ${icone("apagar-categoria", cat.id, "HANDOUTS.Bib.ApagarCategoria", "fa-trash")}
      <span class="ho-espaco"></span>
      <button type="button" class="ho-botao-texto" data-accao="nova-seccao" data-id="${esc(cat.id)}"><i class="fa-solid fa-folder-plus"></i> ${esc(t("HANDOUTS.Bib.NovaSeccao"))}</button>
    </header>
    ${cat.seccoes.map(s => `
    <div class="ho-seccao ${s.recolhida ? "ho-recolhida" : ""}" data-seccao="${esc(s.id)}">
      <header class="ho-seccao-topo" draggable="true" data-arrastar-seccao="${esc(s.id)}">
        <button type="button" class="ho-icone ho-seta" data-accao="alternar" data-id="${esc(s.id)}"><i class="fa-solid fa-chevron-down"></i></button>
        <span class="ho-seccao-nome" data-accao="alternar" data-id="${esc(s.id)}">${esc(s.nome)}</span>
        <span class="ho-conta">${s.itens.length}</span>
        <span class="ho-espaco"></span>
        ${icone("adicionar", s.id, "HANDOUTS.Bib.Adicionar", "fa-image")}
        ${icone("renomear-seccao", s.id, "HANDOUTS.Bib.Renomear", "fa-pen")}
        ${icone("apagar-seccao", s.id, "HANDOUTS.Bib.ApagarSeccao", "fa-trash")}
      </header>
      ${s.recolhida ? "" : `
      <div class="ho-grelha" data-largar-em="${esc(s.id)}">
        ${s.itens.map(cartao).join("")}
        <button type="button" class="ho-largar-aqui" data-accao="adicionar" data-id="${esc(s.id)}">
          <i class="fa-solid fa-plus"></i><span>${esc(t("HANDOUTS.Bib.LargarAqui"))}</span>
        </button>
      </div>`}
    </div>`).join("")}`}
  </div>

  <footer class="ho-rodape">
    <span class="ho-dica">${esc(t("HANDOUTS.Bib.Dica"))}</span>
    <span class="ho-espaco"></span>
    <button type="button" class="ho-botao-texto" data-accao="colecoes"><i class="fa-solid fa-users"></i> ${esc(t("HANDOUTS.Bib.Colecoes"))}</button>
  </footer>
</section>`;
}

function desenhar() {
  const corpo = raiz.querySelector(".ho-corpo");
  const rolagem = corpo?.scrollTop ?? 0;
  raiz.innerHTML = html(contexto());
  const novo = raiz.querySelector(".ho-corpo");
  if (novo) novo.scrollTop = rolagem;
}

// ---------------------------------------------------------------- eventos (ligados uma vez: a raiz sobrevive aos redesenhos)

function ligar(el) {
  el.addEventListener("click", (ev) => clique(ev));
  el.addEventListener("input", mesa.utils.debounce((ev) => {
    if (ev.target?.dataset?.campo !== "procura") return;
    procura = ev.target.value;
    desenhar();
    const p = raiz?.querySelector("[data-campo=procura]");
    p?.focus();
    p?.setSelectionRange(p.value.length, p.value.length);
  }, 180));
  ligarArrastos(el);
}

async function pedirNome(titulo, atual) {
  const r = await mesa.dialogs.prompt(titulo, [{ name: "nome", label: t("HANDOUTS.Bib.Renomear"), value: atual }]);
  return r?.nome?.trim() || null;
}
const confirmar = (texto) => mesa.dialogs.confirm(texto, t("HANDOUTS.Ok"));

async function clique(ev) {
  const alvo = ev.target.closest("[data-accao]");
  if (!alvo) return;
  ev.preventDefault();
  ev.stopPropagation();
  const id = alvo.dataset.id;
  switch (alvo.dataset.accao) {
    case "aba":
      aba = id;
      try { localStorage.setItem(CHAVE_ABA, id); } catch { /* sem armazenamento */ }
      procura = "";
      return desenhar();
    case "mostrar": return Biblioteca.aoMostrar(id, alvo.dataset.para);
    case "ver": {
      const item = L.encontrar(biblioteca(), id)?.item;
      if (item) papel.abrir(item);
      return;
    }
    case "alternar": return mudarBiblioteca(b => L.alternarSeccao(b, id));
    case "adicionar": return escolherImagem((caminho) =>
      mudarBiblioteca((b, novoId) => L.adicionarItens(b, id, [{ id: novoId(), img: caminho }])));
    case "nova-categoria": {
      const nome = await pedirNome(t("HANDOUTS.Bib.NovaCategoria"), "");
      if (!nome) return;
      const novo = mesa.utils.randomId();
      aba = novo;
      return mudarBiblioteca((b, novoId) => L.novaCategoria(b, nome, novo, novoId));
    }
    case "nova-seccao": {
      const nome = await pedirNome(t("HANDOUTS.Bib.NovaSeccao"), "");
      if (nome) return mudarBiblioteca((b, novoId) => L.novaSeccao(b, id, nome, novoId()));
      return;
    }
    case "renomear-categoria": {
      const nome = await pedirNome(t("HANDOUTS.Bib.Renomear"), L.categoria(biblioteca(), id)?.nome ?? "");
      if (nome) return mudarBiblioteca(b => L.renomearCategoria(b, id, nome));
      return;
    }
    case "renomear-seccao": {
      const nome = await pedirNome(t("HANDOUTS.Bib.Renomear"), L.encontrar(biblioteca(), id)?.seccao?.nome ?? "");
      if (nome) return mudarBiblioteca(b => L.renomearSeccao(b, id, nome));
      return;
    }
    case "renomear-item": {
      const nome = await pedirNome(t("HANDOUTS.Bib.Renomear"), L.encontrar(biblioteca(), id)?.item?.nome ?? "");
      if (nome) return mudarBiblioteca(b => L.renomearItem(b, id, nome));
      return;
    }
    case "apagar-item": {
      const item = L.encontrar(biblioteca(), id)?.item;
      // os jogadores que já o receberam ficam com ele: apagar da biblioteca não lhes tira nada
      if (item && await confirmar(t("HANDOUTS.Bib.ApagarDocumentoPergunta", { nome: item.nome })))
        return mudarBiblioteca(b => L.apagarItem(b, id));
      return;
    }
    case "apagar-seccao": {
      const onde = L.encontrar(biblioteca(), id);
      if (!onde) return;
      if (onde.categoria.seccoes.length <= 1) return mesa.toast(t("HANDOUTS.Bib.UltimaSeccao"), "warning");
      if (!onde.seccao.itens.length || await confirmar(t("HANDOUTS.Bib.ApagarSeccaoPergunta", { nome: onde.seccao.nome, n: onde.seccao.itens.length })))
        return mudarBiblioteca(b => L.apagarSeccao(b, id));
      return;
    }
    case "apagar-categoria": {
      const b0 = biblioteca();
      const c = L.categoria(b0, id);
      if (!c) return;
      if (b0.categorias.length <= 1) return mesa.toast(t("HANDOUTS.Bib.UltimaCategoria"), "warning");
      const n = c.seccoes.reduce((s, x) => s + x.itens.length, 0);
      if (!n || await confirmar(t("HANDOUTS.Bib.ApagarCategoriaPergunta", { nome: c.nome, n }))) {
        aba = null;
        return mudarBiblioteca(b => L.apagarCategoria(b, id));
      }
      return;
    }
    case "colecoes": return Biblioteca.aoAbrirColecoes();
  }
}

// ---------------------------------------------------------------- arrastar

function ligarArrastos(el) {
  let arrastado = null;            // { tipo: "item"|"seccao", id }

  el.addEventListener("dragstart", (ev) => {
    const cartao = ev.target.closest?.("[data-item]");
    const seccao = ev.target.closest?.("[data-arrastar-seccao]");
    if (cartao) {
      arrastado = { tipo: "item", id: cartao.dataset.item };
      ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "ho-item", id: arrastado.id }));
      cartao.classList.add("ho-a-arrastar");
    } else if (seccao) {
      arrastado = { tipo: "seccao", id: seccao.dataset.arrastarSeccao };
      ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "ho-seccao", id: arrastado.id }));
    } else return;
    ev.dataTransfer.effectAllowed = "move";
    ev.stopPropagation();
  });
  el.addEventListener("dragend", () => {
    arrastado = null;
    el.querySelectorAll(".ho-a-arrastar, .ho-alvo, .ho-alvo-antes").forEach(x => x.classList.remove("ho-a-arrastar", "ho-alvo", "ho-alvo-antes"));
  });

  const marcar = (x, classe) => {
    el.querySelectorAll(".ho-alvo, .ho-alvo-antes").forEach(y => y !== x && y.classList.remove("ho-alvo", "ho-alvo-antes"));
    x?.classList.add(classe);
  };

  el.addEventListener("dragover", (ev) => {
    const abaEl = ev.target.closest("[data-alvo-categoria]");
    const cartao = ev.target.closest("[data-item]");
    const seccao = ev.target.closest("[data-seccao]");
    if (!abaEl && !seccao) return;
    ev.preventDefault();
    if (abaEl) return marcar(abaEl, "ho-alvo");
    if (arrastado?.tipo === "seccao") return marcar(seccao, "ho-alvo-antes");
    if (cartao && cartao.dataset.item !== arrastado?.id) return marcar(cartao, "ho-alvo-antes");
    marcar(seccao, "ho-alvo");
  });

  el.addEventListener("drop", async (ev) => {
    const abaEl = ev.target.closest("[data-alvo-categoria]");
    const seccaoEl = ev.target.closest("[data-seccao]");
    if (!abaEl && !seccaoEl) return;
    ev.preventDefault();
    ev.stopPropagation();
    el.querySelectorAll(".ho-alvo, .ho-alvo-antes").forEach(x => x.classList.remove("ho-alvo", "ho-alvo-antes"));
    const b = biblioteca();

    // largar num separador: vai para a primeira secção dessa categoria
    const seccaoId = abaEl ? L.categoria(b, abaEl.dataset.alvoCategoria)?.seccoes[0]?.id : seccaoEl.dataset.seccao;
    if (!seccaoId) return;

    // 1. imagens do Mac
    if (ev.dataTransfer.files?.length) {
      const aviso = mesa.notify(t("HANDOUTS.Bib.AEnviar"), "info", { permanent: true });
      const feitos = await enviarImagens(ev.dataTransfer.files);
      aviso?.remove?.();
      if (!feitos.length) return mesa.toast(t("HANDOUTS.Bib.SemImagens"), "warning");
      return mudarBiblioteca((bb, novoId) => L.adicionarItens(bb, seccaoId, feitos.map(f => ({ ...f, id: novoId() }))));
    }

    const tudo = dadosDoArrasto(ev.dataTransfer);
    const dados = tudo["text/plain"];

    // 2. arrumar dentro da biblioteca
    if (dados?.type === "ho-item") {
      const antesDe = ev.target.closest("[data-item]")?.dataset.item;
      const destino = L.encontrar(b, seccaoId)?.seccao;
      const indice = antesDe ? destino?.itens.findIndex(i => i.id === antesDe) : undefined;
      return mudarBiblioteca(bb => L.moverItem(bb, dados.id, seccaoId, indice < 0 ? undefined : indice));
    }
    if (dados?.type === "ho-seccao") {
      if (abaEl) return mudarBiblioteca(bb => L.moverSeccao(bb, dados.id, abaEl.dataset.alvoCategoria));
      const onde = L.encontrar(b, seccaoId);
      const indice = onde.categoria.seccoes.findIndex(s => s.id === seccaoId);
      const antes = onde.categoria.seccoes.findIndex(s => s.id === dados.id);
      // mesma categoria e vinha de cima: tirá-la encolhe a lista uma posição
      const i = antes >= 0 && antes < indice ? indice - 1 : indice;
      return mudarBiblioteca(bb => L.moverSeccao(bb, dados.id, onde.categoria.id, i));
    }

    // 3. da Mesa: um ator ou item da barra lateral, ou um caminho de imagem
    const img = imagemDoQueSeLargou(tudo);
    if (!img) return mesa.toast(t("HANDOUTS.Bib.SemImagens"), "warning");
    return mudarBiblioteca((bb, novoId) => L.adicionarItens(bb, seccaoId, [{ ...img, id: novoId() }]));
  });
}
