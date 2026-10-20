import test from "node:test";
import assert from "node:assert/strict";
import {
  lerDuracao, normalizar, iniciar, restanteMs, fase, pausar, retomar, ajustar,
  segundosVisiveis, formatar, fracao, nosUltimos, aMostrarFim, podeVer, resolverPara, descrever, criarFila
} from "../scripts/logica.js";

const T0 = 1_800_000_000_000;   // um «agora» qualquer, em ms do servidor

test("o campo livre: segundos, m:ss, h:mm:ss e unidades", () => {
  assert.equal(lerDuracao("90"), 90);
  assert.equal(lerDuracao("1:30"), 90);
  assert.equal(lerDuracao("1:02:05"), 3725);
  assert.equal(lerDuracao("90:00"), 5400, "o primeiro campo pode passar de 59");
  assert.equal(lerDuracao("2m"), 120);
  assert.equal(lerDuracao("10s"), 10);
  assert.equal(lerDuracao(" 1m30s "), 90);
  assert.equal(lerDuracao("1 min 30"), 90, "o último sem unidade é a unidade abaixo");
  assert.equal(lerDuracao("2h 5m"), 7500);
  assert.equal(lerDuracao("1,5m"), 90, "vírgula decimal");
  assert.equal(lerDuracao("5 minutos"), 300);
});

test("o campo livre recusa o que não se percebe", () => {
  for (const mau of ["", "  ", "abc", "1:75", "0", "0:00", "-5", "5x", "30s 1m", "m", "1:2:3:4", "25h", "30 1m"]) {
    assert.equal(lerDuracao(mau), null, `«${mau}»`);
  }
  assert.equal(lerDuracao(null), null);
});

test("iniciar guarda a hora de fim, não o que falta", () => {
  const e = iniciar(60, { rotulo: "  A polícia chega ", id: "x" }, T0);
  assert.equal(e.fim, T0 + 60_000);
  assert.equal(e.resta, null);
  assert.equal(e.total, 60_000);
  assert.equal(e.rotulo, "A polícia chega");
  assert.equal(e.para, "todos");
  assert.equal(fase(e, T0), "a-correr");
});

test("o que falta sai da hora de fim e do relógio de cada um", () => {
  const e = iniciar(60, {}, T0);
  assert.equal(restanteMs(e, T0 + 15_000), 45_000);
  assert.equal(restanteMs(e, T0 + 90_000), 0, "nunca negativo");
  assert.equal(fase(e, T0 + 60_000), "terminado");
  assert.equal(restanteMs(null, T0), 0);
  assert.equal(fase(null, T0), "inativo");
});

test("pausar guarda o que falta; retomar volta a pôr uma hora de fim", () => {
  const e = iniciar(60, {}, T0);
  const p = pausar(e, T0 + 20_000);
  assert.equal(fase(p, T0 + 999_999), "pausado");
  assert.equal(restanteMs(p, T0 + 999_999), 40_000, "em pausa o tempo não anda");
  const r = retomar(p, T0 + 100_000);
  assert.equal(r.fim, T0 + 140_000);
  assert.equal(r.resta, null);
  assert.equal(pausar(p, T0), p, "pausar em pausa não muda nada");
  assert.equal(retomar(e, T0), e, "retomar a correr não muda nada");
  assert.equal(pausar(e, T0 + 70_000), e, "pausar depois do fim não muda nada");
});

test("±30 s a correr: nunca abaixo de zero; acima do total alarga o total", () => {
  const e = iniciar(60, {}, T0);
  const mais = ajustar(e, 30, T0 + 10_000);
  assert.equal(restanteMs(mais, T0 + 10_000), 80_000);
  assert.equal(mais.total, 80_000);
  const menos = ajustar(e, -30, T0 + 10_000);
  assert.equal(restanteMs(menos, T0 + 10_000), 20_000);
  assert.equal(menos.total, 60_000, "tirar não encolhe o total");
  const tudo = ajustar(e, -300, T0 + 10_000);
  assert.equal(restanteMs(tudo, T0 + 10_000), 0);
  assert.equal(fase(tudo, T0 + 10_000), "terminado", "tirar mais do que falta acaba");
});

test("±30 s em pausa: mexe no que falta, nunca abaixo de zero", () => {
  const p = pausar(iniciar(60, {}, T0), T0 + 50_000);   // faltam 10 s
  assert.equal(restanteMs(ajustar(p, 30, T0), T0), 40_000);
  const zero = ajustar(p, -30, T0);
  assert.equal(zero.resta, 0);
  assert.equal(fase(zero, T0), "pausado", "fica em pausa a 0:00");
  assert.equal(fase(retomar(zero, T0 + 5), T0 + 5), "terminado", "e retomar acaba logo");
  assert.equal(ajustar(null, 30, T0), null);
});

test("formatar: m:ss, e h:mm:ss acima de uma hora", () => {
  assert.equal(formatar(59), "0:59");
  assert.equal(formatar(600), "10:00");
  assert.equal(formatar(3725), "1:02:05");
  assert.equal(formatar(0), "0:00");
  assert.equal(formatar(3600), "1:00:00");
  assert.equal(formatar(-4), "0:00");
});

test("os segundos visíveis arredondam para cima: o 0:00 só quando acabou", () => {
  assert.equal(segundosVisiveis(59_001), 60);
  assert.equal(segundosVisiveis(1), 1);
  assert.equal(segundosVisiveis(0), 0);
});

test("a linha: 1 no início, 0 no fim", () => {
  const e = iniciar(100, {}, T0);
  assert.equal(fracao(e, T0), 1);
  assert.equal(fracao(e, T0 + 25_000), 0.75);
  assert.equal(fracao(e, T0 + 200_000), 0);
  assert.equal(fracao(null, T0), 0);
});

test("os últimos 10 s", () => {
  assert.equal(nosUltimos(10_000), true);
  assert.equal(nosUltimos(500), true);
  assert.equal(nosUltimos(10_001), false);
  assert.equal(nosUltimos(0), false, "o zero é o fim, não os últimos segundos");
});

test("o fim fica à vista uns segundos e depois desaparece (quem entra tarde não vê)", () => {
  const e = iniciar(10, {}, T0);
  assert.equal(aMostrarFim(e, T0 + 5_000), false, "ainda a correr");
  assert.equal(aMostrarFim(e, T0 + 11_000), true);
  assert.equal(aMostrarFim(e, T0 + 60_000), false);
  assert.equal(aMostrarFim(null, T0), false);
});

test("quem vê: o mestre sempre, «todos», ou a lista", () => {
  const todos = iniciar(30, {}, T0);
  const so = iniciar(30, { para: ["ana"] }, T0);
  const ana = { id: "ana", isGM: false }, rui = { id: "rui", isGM: false }, gm = { id: "gm", isGM: true };
  assert.equal(podeVer(todos, rui), true);
  assert.equal(podeVer(so, ana), true);
  assert.equal(podeVer(so, rui), false);
  assert.equal(podeVer(so, gm), true);
  assert.equal(podeVer(iniciar(30, { para: [] }, T0), gm), true, "lista vazia: só o mestre");
  assert.equal(podeVer(null, gm), false);
});

test("o «para» da API aceita ids ou nomes, e deixa os mestres de fora", () => {
  const users = [{ id: "a1", name: "Ana", isGM: false }, { id: "r1", name: "Rui", isGM: false }, { id: "g1", name: "Mestre", isGM: true }];
  assert.equal(resolverPara(undefined, users), "todos");
  assert.equal(resolverPara("todos", users), "todos");
  assert.deepEqual(resolverPara(["Ana", "r1", "Mestre", "Zé", "a1"], users), ["a1", "r1"]);
  assert.deepEqual(resolverPara("Rui", users), ["r1"]);
});

test("normalizar: o que vem da definição", () => {
  assert.equal(normalizar(null), null);
  assert.equal(normalizar({}), null, "o vazio por omissão é «sem contagem»");
  const p = normalizar({ fim: 5, resta: 1000, total: 2000, para: ["a", 3] });
  assert.equal(p.fim, null, "em pausa a hora de fim não conta");
  assert.deepEqual(p.para, ["a"]);
  assert.equal(normalizar({ fim: T0, rotulo: "x".repeat(200) }).rotulo.length, 80);
});

test("descrever: o estado em segundos para a API", () => {
  const e = iniciar(90, { rotulo: "Fuga" }, T0);
  assert.deepEqual(descrever(e, T0 + 30_500), { fase: "a-correr", restante: 60, total: 90, rotulo: "Fuga", para: "todos" });
  assert.equal(descrever(null, T0).fase, "inativo");
});

test("a fila grava pela ordem, e um erro não a encrava", async () => {
  const fila = criarFila(), ordem = [];
  const lento = () => new Promise(r => setTimeout(() => { ordem.push(1); r(); }, 20));
  await Promise.allSettled([fila(lento), fila(() => { throw new Error("x"); }), fila(() => ordem.push(3))]);
  assert.deepEqual(ordem, [1, 3]);
});
