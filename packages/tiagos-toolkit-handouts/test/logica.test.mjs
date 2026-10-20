import test from "node:test";
import assert from "node:assert/strict";
import {
  vazia, normalizar, encontrar, novaCategoria, renomearCategoria, apagarCategoria, novaSeccao, renomearSeccao,
  alternarSeccao, apagarSeccao, moverSeccao, adicionarItens, renomearItem, apagarItem, moverItem, nomeDoFicheiro,
  procurar, receber, marcarVisto, novos, tamanhoDeChegada, zoomEm, dentroDoEcra
} from "../scripts/logica.js";

let n = 0;
const id = () => `id${++n}`;

// uma biblioteca como a de uma sessão do AKRASIA
function exemplo() {
  return {
    categorias: [
      { id: "s3", nome: "Sessão 3", seccoes: [
        { id: "hosp", nome: "Hospital", recolhida: false, itens: [
          { id: "a", nome: "Prontuário", img: "h/prontuario.webp" },
          { id: "b", nome: "Foto do corredor", img: "h/corredor.webp" },
          { id: "c", nome: "Bilhete", img: "h/bilhete.webp" }
        ] },
        { id: "rua", nome: "Rua Bento Lisboa", recolhida: false, itens: [] }
      ] },
      { id: "npc", nome: "NPCs", seccoes: [{ id: "npcs", nome: "Rostos", recolhida: false, itens: [] }] }
    ]
  };
}

// ── biblioteca ──────────────────────────────────────────────────────
test("uma biblioteca nova tem uma categoria e uma secção onde largar", () => {
  const b = vazia(id);
  assert.equal(b.categorias.length, 1);
  assert.equal(b.categorias[0].seccoes.length, 1);
});

test("normalizar aguenta lixo e nunca devolve uma biblioteca sem sítio", () => {
  for (const lixo of [null, undefined, 42, "x", {}, { categorias: "não" }, { categorias: [null, { seccoes: 3 }] }]) {
    const b = normalizar(lixo, id);
    assert.ok(b.categorias.length >= 1);
    assert.ok(b.categorias.every(c => c.seccoes.length >= 1));
  }
  const b = normalizar({ categorias: [{ id: "k", nome: "K", seccoes: [{ id: "s", nome: "S", itens: [{ nome: "sem imagem" }, { img: "a/b_c.png" }] }] }] }, id);
  assert.deepEqual(b.categorias[0].seccoes[0].itens.map(i => i.nome), ["b c"], "sem imagem não entra; sem nome ganha o do ficheiro");
});

test("as funções não mexem na biblioteca que recebem", () => {
  const b = exemplo();
  const antes = JSON.stringify(b);
  moverItem(b, "a", "rua", 0); apagarItem(b, "b"); novaSeccao(b, "s3", "X", "x"); alternarSeccao(b, "hosp");
  assert.equal(JSON.stringify(b), antes);
});

test("categorias: criar, renomear, e a última não se apaga", () => {
  let b = novaCategoria(exemplo(), "  Locais ", "loc", id);
  assert.equal(b.categorias.at(-1).nome, "Locais");
  assert.equal(b.categorias.at(-1).seccoes.length, 1, "uma categoria nova já vem com uma secção");
  b = renomearCategoria(b, "loc", "Lugares");
  assert.equal(b.categorias.at(-1).nome, "Lugares");
  b = renomearCategoria(b, "loc", "   ");
  assert.equal(b.categorias.at(-1).nome, "Lugares", "nome vazio não apaga o nome");
  b = apagarCategoria(apagarCategoria(b, "loc"), "npc");
  assert.equal(b.categorias.length, 1);
  assert.equal(apagarCategoria(b, "s3").categorias.length, 1);
});

test("secções: criar, recolher, renomear, e a última de uma categoria não se apaga", () => {
  let b = novaSeccao(exemplo(), "s3", "Delegacia", "dp");
  assert.deepEqual(b.categorias[0].seccoes.map(s => s.id), ["hosp", "rua", "dp"]);
  b = alternarSeccao(b, "dp");
  assert.equal(encontrar(b, "dp").seccao.recolhida, true);
  b = renomearSeccao(b, "dp", "9ª DP");
  assert.equal(encontrar(b, "dp").seccao.nome, "9ª DP");
  b = apagarSeccao(b, "dp");
  assert.equal(encontrar(b, "dp"), null);
  assert.equal(apagarSeccao(b, "npcs").categorias[1].seccoes.length, 1);
});

test("mover uma secção para outra categoria; a única de uma categoria não sai de lá", () => {
  let b = moverSeccao(exemplo(), "rua", "npc", 0);
  assert.deepEqual(b.categorias[1].seccoes.map(s => s.id), ["rua", "npcs"]);
  assert.deepEqual(b.categorias[0].seccoes.map(s => s.id), ["hosp"]);
  assert.deepEqual(moverSeccao(b, "hosp", "npc", 0).categorias[0].seccoes.map(s => s.id), ["hosp"]);
});

test("adicionar: nome do ficheiro por omissão, e a mesma imagem não entra duas vezes", () => {
  let b = adicionarItens(exemplo(), "rua", [{ id: "r1", img: "fotos/fachada_58-noite.jpg" }, { id: "r2", img: "fotos/fachada_58-noite.jpg" }]);
  assert.deepEqual(encontrar(b, "rua").seccao.itens.map(i => i.nome), ["fachada 58 noite"]);
  b = adicionarItens(b, "rua", [{ id: "r3", nome: "Porta", img: "fotos/porta.jpg" }]);
  assert.equal(encontrar(b, "r3").item.nome, "Porta");
});

test("mover um documento dentro da mesma secção vai para o sítio pedido", () => {
  // arrastar o primeiro para depois do segundo (posição 2 na lista de antes)
  let b = moverItem(exemplo(), "a", "hosp", 2);
  assert.deepEqual(encontrar(b, "hosp").seccao.itens.map(i => i.id), ["b", "a", "c"]);
  b = moverItem(exemplo(), "c", "hosp", 0);
  assert.deepEqual(encontrar(b, "hosp").seccao.itens.map(i => i.id), ["c", "a", "b"]);
  b = moverItem(exemplo(), "a", "hosp");
  assert.deepEqual(encontrar(b, "hosp").seccao.itens.map(i => i.id), ["b", "c", "a"], "sem posição vai para o fim");
});

test("mover um documento para uma secção de outra categoria", () => {
  const b = moverItem(exemplo(), "b", "npcs", 0);
  assert.deepEqual(encontrar(b, "hosp").seccao.itens.map(i => i.id), ["a", "c"]);
  assert.deepEqual(encontrar(b, "npcs").seccao.itens.map(i => i.id), ["b"]);
});

test("renomear e apagar documentos", () => {
  let b = renomearItem(exemplo(), "a", "Prontuário de Márcia");
  assert.equal(encontrar(b, "a").item.nome, "Prontuário de Márcia");
  b = apagarItem(b, "a");
  assert.equal(encontrar(b, "a"), null);
  assert.equal(apagarItem(b, "hosp"), b, "apagarItem não apaga secções");
});

test("nome do ficheiro: sem extensão, sem sublinhados, com acentos descodificados", () => {
  assert.equal(nomeDoFicheiro("MAIN/AKRASIA/Handouts/recorte_jornal-1987.webp"), "recorte jornal 1987");
  assert.equal(nomeDoFicheiro("a/Pris%C3%A3o%20de%20Voss.png?v=3"), "Prisão de Voss");
  assert.equal(nomeDoFicheiro(""), "Documento");
});

test("procurar ignora maiúsculas e acentos, e também encontra pelo nome da secção", () => {
  const b = exemplo();
  assert.deepEqual(procurar(b, "PRONTUARIO").map(i => i.id), ["a"]);
  assert.deepEqual(procurar(b, "hospital").map(i => i.id), ["a", "b", "c"]);
  assert.deepEqual(procurar(b, "  "), []);
});

// ── coleção do jogador ──────────────────────────────────────────────
test("o jogador guarda tudo o que recebe, o mais recente em cima", () => {
  let c = receber([], { id: "a", nome: "Prontuário", img: "a.webp" }, 1);
  c = receber(c, { id: "b", nome: "Foto", img: "b.webp" }, 2);
  assert.deepEqual(c.map(x => x.id), ["b", "a"]);
  assert.equal(novos(c), 2);
});

test("receber outra vez o mesmo não duplica: sobe e volta a ser novo, com a imagem atual", () => {
  let c = receber([], { id: "a", nome: "Prontuário", img: "a.webp" }, 1);
  c = receber(c, { id: "b", nome: "Foto", img: "b.webp" }, 2);
  c = marcarVisto(c, "a");
  c = receber(c, { id: "a", nome: "Prontuário (2ª via)", img: "a2.webp" }, 3);
  assert.deepEqual(c.map(x => x.id), ["a", "b"]);
  assert.equal(c[0].visto, false);
  assert.equal(c[0].img, "a2.webp");
  assert.equal(c.length, 2);
});

test("marcar visto só mexe naquele", () => {
  const c = marcarVisto(receber(receber([], { id: "a", img: "a" }, 1), { id: "b", img: "b" }, 2), "a");
  assert.deepEqual(c.map(x => x.visto), [false, true]);
  assert.equal(novos(c), 1);
  assert.equal(novos(undefined), 0);
});

// ── o papel na mesa ─────────────────────────────────────────────────
test("um documento chega a caber no ecrã, e uma imagem pequena não cresce mais do que 2×", () => {
  const g = tamanhoDeChegada(4000, 3000, 1920, 1080);
  assert.ok(g.largura <= 1920 * 0.62 + 1 && g.altura <= 1080 * 0.78 + 1);
  assert.ok(Math.abs(g.largura / g.altura - 4 / 3) < 0.01, "mantém a proporção");
  assert.deepEqual(tamanhoDeChegada(100, 50, 1920, 1080), { largura: 200, altura: 100 });
  assert.ok(tamanhoDeChegada(0, 0, 1000, 800).largura > 0, "imagem ainda sem medidas não dá zero");
});

test("o zoom mantém debaixo do rato o que estava debaixo do rato", () => {
  const p = { x: 100, y: 50, escala: 1 };
  const z = zoomEm(p, 2, 300, 250);
  // o ponto (300,250) do ecrã era o ponto (200,200) do papel; continua a ser
  assert.equal((300 - z.x) / z.escala, 200);
  assert.equal((250 - z.y) / z.escala, 200);
});

test("o zoom tem limites e, no limite, o papel não foge", () => {
  let p = { x: 0, y: 0, escala: 1 };
  for (let i = 0; i < 100; i++) p = zoomEm(p, 1.5, 500, 400);
  assert.equal(p.escala, 6);
  const parado = zoomEm(p, 1.5, 500, 400);
  assert.deepEqual(parado, p);
  for (let i = 0; i < 100; i++) p = zoomEm(p, 0.5, 500, 400);
  assert.equal(p.escala, 0.4);
});

test("um papel atirado para fora do ecrã fica sempre com um bocado à vista", () => {
  const fora = dentroDoEcra({ x: 5000, y: -5000, escala: 1 }, 400, 300, 1920, 1080);
  assert.equal(fora.x, 1920 - 80);
  assert.equal(fora.y, 80 - 300);
  const dentro = dentroDoEcra({ x: 200, y: 100, escala: 1 }, 400, 300, 1920, 1080);
  assert.deepEqual([dentro.x, dentro.y], [200, 100]);
});

// ── a fila das gravações ────────────────────────────────────────────
import { criarFila } from "../scripts/logica.js";

test("duas mudanças à biblioteca ao mesmo tempo não se pisam (a fila grava uma de cada vez)", async () => {
  // um «servidor» lento: ler devolve o que está gravado, gravar demora
  let gravado = { itens: [] };
  const ler = () => JSON.parse(JSON.stringify(gravado));
  const gravar = (b) => new Promise(r => setTimeout(() => { gravado = b; r(); }, 15));
  const fila = criarFila();
  const mudar = (fn) => fila(async () => { const n = fn(ler()); await gravar(n); return n; });

  await Promise.all([
    mudar(b => ({ itens: [...b.itens, "bilhete"] })),     // o envio do Mac
    mudar(b => ({ itens: [...b.itens, "auto"] }))         // o largar do Foundry, logo a seguir
  ]);
  assert.deepEqual(gravado.itens, ["bilhete", "auto"]);
});

test("um erro numa mudança não encrava a fila", async () => {
  const fila = criarFila();
  await assert.rejects(fila(async () => { throw new Error("rede"); }));
  assert.equal(await fila(async () => 7), 7);
});
