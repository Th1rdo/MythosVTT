/**
 * Lógica pura dos documentos: sem Foundry, sem DOM — testada em Node.
 *
 * A biblioteca do mestre é uma árvore curta: categorias (os separadores) →
 * secções (os grupos que se recolhem) → documentos. Tudo aqui devolve uma cópia
 * nova; quem chama grava. Os ids vêm de fora (`foundry.utils.randomID`) para que
 * isto corra em Node.
 */

import { ZOOM, CHEGADA } from "./const.js";

const copia = (b) => JSON.parse(JSON.stringify(b));

// ------------------------------------------------------------------ biblioteca

export function vazia(novoId) {
  return { categorias: [{ id: novoId(), nome: "Geral", seccoes: [{ id: novoId(), nome: "Documentos", recolhida: false, itens: [] }] }] };
}

/**
 * Aceita o que estiver guardado e devolve sempre uma biblioteca utilizável.
 * Uma definição corrompida à mão (ou de uma versão futura) não pode deixar o
 * mestre sem biblioteca a meio da sessão.
 */
export function normalizar(b, novoId) {
  const cats = Array.isArray(b?.categorias) ? b.categorias : [];
  const limpa = cats.filter(c => c && typeof c === "object").map(c => ({
    id: String(c.id || novoId()),
    nome: String(c.nome ?? "").trim() || "Sem nome",
    seccoes: (Array.isArray(c.seccoes) ? c.seccoes : []).filter(s => s && typeof s === "object").map(s => ({
      id: String(s.id || novoId()),
      nome: String(s.nome ?? "").trim() || "Sem nome",
      recolhida: !!s.recolhida,
      itens: (Array.isArray(s.itens) ? s.itens : []).filter(i => i?.img).map(i => ({
        id: String(i.id || novoId()), nome: String(i.nome ?? "").trim() || nomeDoFicheiro(i.img), img: String(i.img)
      }))
    }))
  }));
  if (!limpa.length) return vazia(novoId);
  for (const c of limpa) if (!c.seccoes.length) c.seccoes.push({ id: novoId(), nome: "Documentos", recolhida: false, itens: [] });
  return { categorias: limpa };
}

/** Onde está um documento (ou uma secção): devolve as referências dentro de `b`. */
export function encontrar(b, id) {
  for (const categoria of b.categorias) {
    for (const seccao of categoria.seccoes) {
      if (seccao.id === id) return { categoria, seccao, item: null };
      const item = seccao.itens.find(i => i.id === id);
      if (item) return { categoria, seccao, item };
    }
  }
  return null;
}

export const categoria = (b, id) => b.categorias.find(c => c.id === id) ?? null;

export function novaCategoria(b, nome, id, novoId) {
  const n = copia(b);
  n.categorias.push({ id, nome: nome.trim() || "Nova categoria", seccoes: [{ id: novoId(), nome: "Documentos", recolhida: false, itens: [] }] });
  return n;
}

export function renomearCategoria(b, id, nome) {
  const n = copia(b);
  const c = categoria(n, id);
  if (c && nome.trim()) c.nome = nome.trim();
  return n;
}

/** A última categoria não se apaga: a biblioteca nunca fica sem sítio onde largar. */
export function apagarCategoria(b, id) {
  if (b.categorias.length <= 1) return b;
  const n = copia(b);
  n.categorias = n.categorias.filter(c => c.id !== id);
  return n;
}

export function novaSeccao(b, categoriaId, nome, id) {
  const n = copia(b);
  const c = categoria(n, categoriaId);
  if (c) c.seccoes.push({ id, nome: nome.trim() || "Nova seção", recolhida: false, itens: [] });
  return n;
}

export function renomearSeccao(b, id, nome) {
  const n = copia(b);
  const s = encontrar(n, id)?.seccao;
  if (s && nome.trim()) s.nome = nome.trim();
  return n;
}

export function alternarSeccao(b, id) {
  const n = copia(b);
  const s = encontrar(n, id)?.seccao;
  if (s) s.recolhida = !s.recolhida;
  return n;
}

/** A última secção de uma categoria também não se apaga. */
export function apagarSeccao(b, id) {
  const n = copia(b);
  const onde = encontrar(n, id);
  if (!onde || onde.item || onde.categoria.seccoes.length <= 1) return b;
  onde.categoria.seccoes = onde.categoria.seccoes.filter(s => s.id !== id);
  return n;
}

/** Mudar uma secção de sítio (arrastar), dentro da categoria ou para outra. */
export function moverSeccao(b, id, categoriaDestino, indice) {
  const n = copia(b);
  const onde = encontrar(n, id);
  const destino = categoria(n, categoriaDestino);
  if (!onde || onde.item || !destino) return b;
  if (onde.categoria.id !== destino.id && onde.categoria.seccoes.length <= 1) return b;
  onde.categoria.seccoes = onde.categoria.seccoes.filter(s => s.id !== id);
  const i = Math.max(0, Math.min(indice ?? destino.seccoes.length, destino.seccoes.length));
  destino.seccoes.splice(i, 0, onde.seccao);
  return n;
}

/** Acrescentar documentos a uma secção. Uma imagem que já lá está não entra duas vezes. */
export function adicionarItens(b, seccaoId, itens) {
  const n = copia(b);
  const s = encontrar(n, seccaoId)?.seccao;
  if (!s) return b;
  for (const i of itens) {
    if (!i?.img || s.itens.some(x => x.img === i.img)) continue;
    s.itens.push({ id: i.id, nome: (i.nome ?? "").trim() || nomeDoFicheiro(i.img), img: i.img });
  }
  return n;
}

export function renomearItem(b, id, nome) {
  const n = copia(b);
  const i = encontrar(n, id)?.item;
  if (i && nome.trim()) i.nome = nome.trim();
  return n;
}

export function apagarItem(b, id) {
  const n = copia(b);
  const onde = encontrar(n, id);
  if (!onde?.item) return b;
  onde.seccao.itens = onde.seccao.itens.filter(i => i.id !== id);
  return n;
}

/** Arrastar um documento para outra posição ou outra secção (de qualquer categoria). */
export function moverItem(b, id, seccaoDestino, indice) {
  const n = copia(b);
  const onde = encontrar(n, id);
  const destino = encontrar(n, seccaoDestino)?.seccao;
  if (!onde?.item || !destino) return b;
  const origem = onde.seccao;
  let i = indice ?? destino.itens.length;
  const antes = origem.itens.indexOf(onde.item);
  origem.itens.splice(antes, 1);
  if (origem === destino && antes < i) i -= 1;        // tirou-se de trás do sítio onde vai entrar
  destino.itens.splice(Math.max(0, Math.min(i, destino.itens.length)), 0, onde.item);
  return n;
}

/** «recorte_jornal-1987.webp» → «recorte jornal 1987». */
export function nomeDoFicheiro(caminho) {
  const base = decodeURIComponent(String(caminho ?? "").split(/[?#]/)[0].split("/").pop() || "");
  return base.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Documento";
}

/** Procurar na biblioteca inteira, sem ligar a maiúsculas nem acentos. */
const simples = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export function procurar(b, texto) {
  const t = simples(texto).trim();
  if (!t) return [];
  const achados = [];
  for (const c of b.categorias) for (const s of c.seccoes) for (const i of s.itens) {
    if (simples(i.nome).includes(t) || simples(s.nome).includes(t)) achados.push({ ...i, seccao: s.nome, categoria: c.nome });
  }
  return achados;
}

// ------------------------------------------------------------------ coleção do jogador

/**
 * O jogador recebe um documento. Guarda-se tudo o que chega, o mais recente em
 * cima. Receber outra vez o mesmo (o mestre mostrou de novo, ou mudou a imagem)
 * não duplica: sobe para o topo e volta a contar como novo.
 */
export function receber(colecao, item, quando) {
  const lista = (Array.isArray(colecao) ? colecao : []).filter(x => x.id !== item.id);
  return [{ id: item.id, nome: item.nome, img: item.img, quando, visto: false }, ...lista];
}

export function marcarVisto(colecao, id) {
  return (colecao ?? []).map(x => (x.id === id ? { ...x, visto: true } : x));
}

export const novos = (colecao) => (colecao ?? []).filter(x => !x.visto).length;

// ------------------------------------------------------------------ o papel na mesa

/**
 * O tamanho com que um documento chega: cabe no ecrã com folga, e uma imagem
 * pequena não cresce para lá do dobro (fica desfocada e parece erro).
 */
export function tamanhoDeChegada(w, h, vw, vh) {
  if (!(w > 0 && h > 0)) return { largura: Math.round(vw * 0.4), altura: Math.round(vh * 0.4) };
  const k = Math.min((vw * CHEGADA.largura) / w, (vh * CHEGADA.altura) / h, 2);
  return { largura: Math.round(w * k), altura: Math.round(h * k) };
}

/**
 * Zoom à volta de um ponto: o que está debaixo do rato fica debaixo do rato.
 * `p` = { x, y, escala } (canto superior esquerdo do papel, em pixéis do ecrã).
 */
export function zoomEm(p, fator, px, py) {
  const escala = Math.min(ZOOM.max, Math.max(ZOOM.min, p.escala * fator));
  const k = escala / p.escala;
  return { x: px - (px - p.x) * k, y: py - (py - p.y) * k, escala };
}

/**
 * Um papel nunca sai do ecrã por inteiro: fica sempre um bocado (80 px) para
 * se lhe pegar. Sem isto, um arrasto com força perdia o documento.
 */
export function dentroDoEcra(p, largura, altura, vw, vh, margem = 80) {
  const w = largura * p.escala, h = altura * p.escala;
  return {
    ...p,
    x: Math.min(vw - margem, Math.max(margem - w, p.x)),
    y: Math.min(vh - margem, Math.max(margem - h, p.y))
  };
}

// ------------------------------------------------------------------ fila

/**
 * Uma tarefa de cada vez. Cada mudança à biblioteca lê a atual, muda e grava; se
 * duas correrem ao mesmo tempo (uma imagem ainda a subir do Mac e outra largada
 * do Foundry logo a seguir), as duas leem a mesma e a segunda apaga a primeira.
 * Aconteceu no teste local: o documento enviado do Mac desapareceu.
 */
export function criarFila() {
  let ultima = Promise.resolve();
  return (tarefa) => {
    const esta = ultima.then(() => tarefa());
    ultima = esta.catch(() => {});        // um erro não encrava as seguintes
    return esta;
  };
}
