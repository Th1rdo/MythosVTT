import { MODULE_ID, FLAG_COLECAO, log } from "./const.js";
import { encontrar } from "./logica.js";
import { registarDefinicoes, biblioteca, mudarBiblioteca, entregar, colecaoDe, vi, retirar } from "./dados.js";
import { Biblioteca } from "./biblioteca.js";
import { Colecao } from "./colecao.js";
import * as papel from "./papel.js";

/**
 * Documentos à mesa.
 *
 * O mestre clica na cara de um jogador por baixo de um documento: primeiro o
 * documento entra na coleção dessa pessoa (fica com ela para sempre), depois
 * pousa-lhe na mesa. Só a ela — os outros não recebem nada.
 *
 * Port para a Mesa do módulo do Foundry: a mesma lógica, o mesmo papel, o mesmo
 * CSS; a cola é a API `mesa` (definições, flags, socket do pacote, janelas).
 */
const { hooks, game } = mesa;
const emitir = (msg, users) => mesa.socket.emit(MODULE_ID, msg, users);
const caminhoFlag = `${MODULE_ID}.${FLAG_COLECAO}`;

/**
 * O documento chega pelo socket e a coleção pela atualização do utilizador, e
 * não há garantia de qual chega primeiro. Se o jogador já o viu na mesa antes de
 * a coleção chegar, fica aqui à espera para ser marcado como visto.
 */
const vistosAntes = new Set();
function marcarVisto(id) {
  if (colecaoDe(game.user).some(x => x.id === id)) return vi(id);
  vistosAntes.add(id);
}

/** Mostrar um documento da biblioteca: `para` é um id de utilizador ou "todos". */
async function mostrar(itemId, para) {
  if (!game.isGM) return;
  const item = encontrar(biblioteca(), itemId)?.item;
  if (!item) return;
  // «Todos» são todos os jogadores, também os que não estão ligados: quem faltou
  // à sessão encontra o documento na coleção quando voltar
  const users = para === "todos" ? game.all("User").filter(u => u.role !== "gm") : [game.get("User", para)].filter(Boolean);
  if (!users.length) return;
  const dados = { id: item.id, nome: item.nome, img: item.img };
  await Promise.all(users.map(u => entregar(u._id, dados)));
  emitir({ tipo: "mostrar", para: users.map(u => u._id), item: dados }, users.map(u => u._id));

  const ligados = users.filter(u => game.online.includes(u._id)).map(u => u.name);
  const fora = users.filter(u => !game.online.includes(u._id)).map(u => u.name);
  const partes = [];
  if (ligados.length) partes.push(mesa.i18n.format("HANDOUTS.Aviso.Mostrado", { nome: item.nome, quem: ligados.join(", ") }));
  if (fora.length) partes.push(mesa.i18n.format("HANDOUTS.Aviso.Guardado", { quem: fora.join(", ") }));
  mesa.toast(partes.join(" "));
}

Biblioteca.aoMostrar = mostrar;
Biblioteca.aoAbrirColecoes = () => Colecao.alternar(game.all("User").find(u => u.role !== "gm")?._id);

hooks.once("init", () => {
  registarDefinicoes();
  mesa.socket.on(MODULE_ID, (msg) => {
    if (!msg?.tipo) return;
    if (msg.tipo === "mostrar" && msg.para?.includes(game.userId)) papel.abrir(msg.item, { chegou: true, aoVer: marcarVisto });
    if (msg.tipo === "retirar" && msg.para === game.userId) papel.fechar(msg.id);
  });
});

hooks.once("ready", () => {
  // Uma biblioteca ainda vazia é criada de novo a cada leitura (ids novos); gravá-la uma vez
  // dá ids fixos às secções que a janela mostra, para um documento largado lá encontrar a secção.
  if (game.isGM && !Object.keys(mesa.settings.get(`${MODULE_ID}.biblioteca`) ?? {}).length) mudarBiblioteca(b => b);
  mesa.handouts = {
    biblioteca: () => (game.isGM ? Biblioteca.alternar() : null),
    colecao: (userId) => Colecao.alternar(userId),
    mostrar,
    retirar: async (userId, id) => {
      if (!game.isGM || !game.get("User", userId)) return;
      await retirar(userId, id);
    }
  };
  log("pronto");
});

// a biblioteca muda (o mestre arrumou noutro separador, ou há dois mestres)
hooks.on(`${MODULE_ID}.biblioteca`, () => Biblioteca.redesenhar());

// uma coleção mudou: as caras acesas da biblioteca e a janela da coleção acompanham
hooks.on("updateUser", (user, mudancas) => {
  if (!("flags" in mudancas)) return;
  if (user._id === game.userId && vistosAntes.size) {
    for (const id of [...vistosAntes]) if (colecaoDe(user).some(x => x.id === id)) { vistosAntes.delete(id); vi(id); }
  }
  Biblioteca.redesenhar();
  Colecao.redesenhar();
});
hooks.on("userConnected", () => Biblioteca.redesenhar());

/**
 * Um botão nas ferramentas dos tokens: o mestre abre a biblioteca, o jogador a
 * coleção dele. O mesmo sítio para os dois — ninguém tem de aprender onde está.
 */
hooks.on("getSceneControlButtons", (grupos) => {
  grupos.find(g => g.name === "tokens")?.tools.push({
    name: "tttHandouts", icon: "fa-solid fa-folder-open", button: true,
    title: mesa.i18n.localize(game.isGM ? "HANDOUTS.Bib.Titulo" : "HANDOUTS.Col.Titulo"),
    run: () => (game.isGM ? Biblioteca.alternar() : Colecao.alternar())
  });
});

// retirar um documento da coleção de alguém (pela janela ou pela API) fecha-o
// também na mesa dessa pessoa, se o tiver aberto
hooks.on("preUpdateUser", (user, mudancas) => {
  if (!game.isGM || !user) return;
  const nova = mudancas[`flags.${caminhoFlag}`] ?? mesa.utils.getProperty(mudancas, `flags.${caminhoFlag}`);
  if (!Array.isArray(nova)) return;
  for (const x of colecaoDe(user)) if (!nova.some(y => y.id === x.id)) emitir({ tipo: "retirar", para: user._id, id: x.id }, [user._id]);
});
