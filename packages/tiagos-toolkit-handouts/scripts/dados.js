import { MODULE_ID, DEF_BIBLIOTECA, FLAG_COLECAO, PASTA_ENVIOS } from "./const.js";
import { normalizar, receber, marcarVisto, nomeDoFicheiro, criarFila } from "./logica.js";

/**
 * Onde as coisas vivem:
 *   - a biblioteca do mestre numa definição do mundo (só o mestre a escreve);
 *   - a coleção de cada jogador numa flag do próprio utilizador — é dele, fica
 *     com ele de sessão para sessão.
 *
 * Port para a Mesa: `mesa.settings`, `mesa.flags`, `mesa.files.upload` (a pasta
 * dos envios fica nos ficheiros do mundo, como no Forge ficava nos assets do mestre).
 */

const novoId = () => mesa.utils.randomId();
const CHAVE = `${MODULE_ID}.${DEF_BIBLIOTECA}`;

export function registarDefinicoes() {
  mesa.settings.register(MODULE_ID, DEF_BIBLIOTECA, {
    name: DEF_BIBLIOTECA, scope: "world", type: "object", default: {},
    onChange: () => mesa.hooks.callAll(`${MODULE_ID}.biblioteca`)
  });
}

export const biblioteca = () => normalizar(mesa.settings.get(CHAVE), novoId);

const naFila = criarFila();

/**
 * Todas as mudanças à biblioteca passam por aqui: `fn` recebe a atual e devolve
 * a nova. Em fila — ver `criarFila`.
 */
export function mudarBiblioteca(fn) {
  return naFila(async () => {
    const nova = fn(biblioteca(), novoId);
    await mesa.settings.set(CHAVE, nova);
    return nova;
  });
}

export { novoId };

/** Um utilizador da Mesa (ou o seu id) → a coleção dele. */
export const colecaoDe = (user) => {
  const u = typeof user === "string" ? mesa.game.get("User", user) : user;
  return mesa.flags.get(u, MODULE_ID, FLAG_COLECAO) ?? [];
};

// a coleção tem a mesma corrida que a biblioteca: dois documentos mostrados
// seguidos à mesma pessoa leriam a mesma coleção e o segundo apagaria o primeiro
const colecaoNaFila = criarFila();
const gravarColecao = (userId, fn) => colecaoNaFila(() => {
  const u = mesa.game.get("User", userId);
  return mesa.flags.set("User", u, MODULE_ID, FLAG_COLECAO, fn(colecaoDe(u)));
});

/** Só o mestre escreve na coleção dos outros. */
export function entregar(userId, item) {
  return gravarColecao(userId, (c) => receber(c, item, Date.now()));
}

/** O jogador abriu um documento: deixa de estar marcado como novo. */
export async function vi(id) {
  if (!colecaoDe(mesa.game.user).some(x => x.id === id && !x.visto)) return;
  await gravarColecao(mesa.game.userId, (c) => marcarVisto(c, id));
}

/** Tirar um documento da coleção de alguém (o mestre enganou-se no destinatário). */
export function retirar(userId, id) {
  return gravarColecao(userId, (c) => c.filter(x => x.id !== id));
}

// ---------------------------------------------------------------- imagens

let pastaFeita = false;

/**
 * Enviar imagens largadas do computador do mestre para o servidor. O Tiago tem
 * as fotos e recortes no Mac; ir primeiro ao navegador de ficheiros para as
 * carregar era o passo que tornava os handouts do Foundry lentos.
 */
export async function enviarImagens(ficheiros) {
  const imagens = [...ficheiros].filter(f => f.type?.startsWith("image/"));
  if (!imagens.length) return [];
  if (!pastaFeita) pastaFeita = await mesa.files.mkdir("", PASTA_ENVIOS).catch(() => false);
  const feitos = [];
  for (const f of imagens) {
    // nomes únicos: duas fotos «IMG_0001.jpg» de dias diferentes não se pisam
    const limpo = f.name.replace(/[^\w.\-]+/g, "_");
    const ficheiro = new File([f], `${Date.now().toString(36)}-${limpo}`, { type: f.type });
    const caminho = await mesa.files.upload(ficheiro, pastaFeita ? PASTA_ENVIOS : undefined).catch(() => null);
    if (caminho) feitos.push({ img: caminho, nome: nomeDoFicheiro(f.name) });
  }
  return feitos;
}

/**
 * O que se pode largar na biblioteca além de ficheiros do Mac: um ator ou item
 * da barra lateral (a arte dele), uma entrada do diário com imagem, ou um caminho.
 */
export function imagemDoQueSeLargou(dados) {
  const doc = (tipo, id) => (id ? mesa.game.get(tipo, id) : null);
  const geral = dados["application/x-mesa-doc"];
  if (geral?.type === "Actor" || geral?.type === "Item") {
    const d = doc(geral.type, geral.id);
    if (d?.img) return { img: d.img, nome: d.name };
  }
  const ator = doc("Actor", dados["application/x-mesa-actor"]);
  if (ator?.img) return { img: ator.img, nome: ator.name };
  const item = doc("Item", dados["application/x-mesa-item"]?.id ?? dados["application/x-mesa-item"]);
  if (item?.img) return { img: item.img, nome: item.name };
  const texto = dados["text/plain"] ?? dados["text/uri-list"];
  if (typeof texto === "string" && /\.(png|jpe?g|webp|gif|avif|svg)(\?.*)?$/i.test(texto.trim())) {
    return { img: texto.trim(), nome: nomeDoFicheiro(texto.trim()) };
  }
  return null;
}

export async function escolherImagem(aoEscolher) {
  const caminho = await mesa.files.browse("image");
  if (caminho) aoEscolher(caminho);
}

/** Tudo o que um arrasto traz, por tipo (JSON lido quando dá). */
export function dadosDoArrasto(dt) {
  const out = {};
  for (const tipo of dt?.types ?? []) {
    if (tipo === "Files") continue;
    const bruto = dt.getData(tipo);
    try { out[tipo] = JSON.parse(bruto); } catch { out[tipo] = bruto; }
  }
  return out;
}
