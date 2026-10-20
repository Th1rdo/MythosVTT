import { MODULE_ID, DEF_ESTADO, DEF_SOM } from "./const.js";
import * as L from "./logica.js";

/**
 * Onde a contagem vive: UMA definição do mundo, escrita só pelo mestre. Guarda a
 * hora de fim em tempo do servidor; cada cliente desenha a partir dela e do seu
 * relógio. Não há mensagens por socket: quem entra a meio lê a definição e já sabe
 * tudo, e o `onChange` chega a todos os clientes ligados.
 *
 * Port para a Mesa: `mesa.settings` em vez de `game.settings`, `mesa.time.serverNow`
 * em vez de `game.time.serverTime`; a lógica (logica.js) é a mesma do módulo do Foundry.
 */
export const agora = () => mesa.time.serverNow();

const chave = (nome) => `${MODULE_ID}.${nome}`;

export function registarDefinicoes() {
  mesa.settings.register(MODULE_ID, DEF_ESTADO, {
    name: DEF_ESTADO, scope: "world", type: "object", default: {},
    onChange: () => mesa.hooks.callAll(`${MODULE_ID}.estado`)
  });
  mesa.settings.register(MODULE_ID, DEF_SOM, {
    name: mesa.i18n.localize("CONTAGEM.Som"), hint: mesa.i18n.localize("CONTAGEM.SomDica"),
    scope: "world", type: "boolean", default: true
  });
}

export const estado = () => L.normalizar(mesa.settings.get(chave(DEF_ESTADO)));
export const somLigado = () => mesa.settings.get(chave(DEF_SOM)) !== false;

/** Os utilizadores no formato que a lógica espera ({id, name, isGM}). */
export const utilizadores = () => mesa.game.all("User").map(u => ({ id: u._id, name: u.name, isGM: u.role === "gm" }));
export const eu = () => ({ id: mesa.game.userId, name: mesa.game.user.name, isGM: mesa.game.isGM });

const naFila = L.criarFila();

/**
 * Todas as mudanças passam por aqui: `fn(estado, agora)` devolve o novo (ou null
 * para acabar). Em fila — ver `criarFila`. Lê o estado e o relógio só quando chega
 * a vez, para o «+30 s» seguinte partir do resultado do anterior.
 */
function mudar(fn) {
  if (!mesa.game.isGM) {
    mesa.toast(mesa.i18n.localize("CONTAGEM.SoMestre"), "warning");
    return Promise.resolve(null);
  }
  return naFila(async () => {
    const antes = estado();
    const novo = fn(antes, agora());
    if (novo !== antes) await mesa.settings.set(chave(DEF_ESTADO), novo ?? {});
    return L.descrever(novo, agora());
  });
}

/** A API (`mesa.contagem`) e o que o painel chama. */
export const acoes = {
  /**
   * `segundos` também aceita texto como o do painel («1:30», «2m»).
   * `para`: "todos" (por omissão) ou lista de ids ou nomes.
   */
  iniciar(segundos, { rotulo = "", para } = {}) {
    const s = typeof segundos === "string" ? L.lerDuracao(segundos) : Number(segundos);
    if (!(s > 0)) {
      mesa.toast(mesa.i18n.localize("CONTAGEM.DuracaoInvalida"), "warning");
      return Promise.resolve(null);
    }
    const lista = Array.isArray(para) ? para.map(x => x?._id ?? x?.id ?? x) : (para?._id ?? para?.id ?? para);
    const quem = L.resolverPara(lista, utilizadores());
    return mudar((_, t) => L.iniciar(s, { rotulo, para: quem, id: mesa.utils.randomId() }, t));
  },
  pausar: () => mudar(L.pausar),
  retomar: () => mudar(L.retomar),
  ajustar: (deltaSegundos) => mudar((e, t) => L.ajustar(e, deltaSegundos, t)),
  cancelar: () => mudar((e) => (e ? null : e)),
  estado: () => L.descrever(estado(), agora())
};
