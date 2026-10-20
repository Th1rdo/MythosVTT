/**
 * Lógica pura da contagem: sem Foundry, sem DOM — testada em Node.
 *
 * O estado guarda a HORA DE FIM (em tempo do servidor), não o tempo que falta.
 * Assim cada cliente calcula sozinho a partir do próprio relógio: quem recarrega
 * ou entra a meio vê o tempo certo, e ninguém vai ficando para trás de tique em
 * tique. Em pausa não há hora de fim — guarda-se o que faltava.
 *
 * Todas as funções recebem `agora` (ms, tempo do servidor) em vez de o lerem:
 * é o que as deixa testar sem relógio e garante que o mestre e os jogadores
 * contam com a mesma régua.
 *
 * Estado (ou `null` quando não há contagem):
 *   { id, fim, resta, total, rotulo, para }
 *   fim    — ms do servidor em que chega a zero (null em pausa)
 *   resta  — ms que faltavam quando se pausou (null a correr)
 *   total  — ms da contagem inteira (para a linha que encolhe)
 *   para   — "todos" ou uma lista de ids de utilizadores
 */
import { FIM_VISIVEL_MS, ULTIMOS_MS } from "./const.js";

/** Para não se escrever «3 dias» por engano num campo livre. */
const MAX_SEGUNDOS = 24 * 3600;
const ROTULO_MAX = 80;

const UNIDADES = {
  h: 3600, hr: 3600, hrs: 3600, hora: 3600, horas: 3600,
  m: 60, min: 60, mins: 60, minuto: 60, minutos: 60,
  s: 1, seg: 1, segs: 1, sec: 1, segundo: 1, segundos: 1
};

/**
 * O campo livre do painel → segundos (ou null se não se percebe).
 * «90» → 90 · «1:30» → 90 · «1:02:05» → 3725 · «2m» → 120 · «10s» → 10 ·
 * «1m30s» / «1 min 30» → 90 · «1,5m» → 90.
 * Um número sozinho são segundos: é o que «90» quer dizer, e um mestre que quer
 * minutos escreve «5m» ou carrega no atalho.
 */
export function lerDuracao(texto) {
  const t = String(texto ?? "").trim().toLowerCase().replace(/,/g, ".");
  if (!t) return null;
  let s = null;
  if (/^\d+(\.\d+)?$/.test(t)) s = Number(t);
  else if (/^\d+(:\d{1,2}){1,2}$/.test(t)) {
    const partes = t.split(":").map(Number);
    // só o primeiro campo pode passar de 59: «90:00» são 90 minutos, «1:75» é engano
    if (partes.slice(1).some(p => p > 59)) return null;
    s = partes.reduce((acc, p) => acc * 60 + p, 0);
  } else {
    // «1m30s», «1 min 30», «2h 5m»: pares número+unidade; o último pode vir sem
    // unidade e conta como a unidade abaixo da anterior («1 min 30» = 1:30)
    const re = /(\d+(?:\.\d+)?)\s*([a-z]*)\s*/gy;
    let m, total = 0, anterior = null, lido = 0;
    while ((m = re.exec(t)) && m[0]) {
      const n = Number(m[1]);
      let mult;
      if (m[2]) {
        mult = UNIDADES[m[2]];
        if (!mult) return null;
      } else {
        if (anterior === null || anterior === 1 || re.lastIndex < t.length) return null;
        mult = anterior / 60;
      }
      if (anterior !== null && mult >= anterior) return null;   // «30s 1m» não
      total += n * mult;
      anterior = mult;
      lido = re.lastIndex;
    }
    if (lido !== t.length || anterior === null) return null;
    s = total;
  }
  s = Math.round(s);
  return s > 0 && s <= MAX_SEGUNDOS ? s : null;
}

/** O que vem da definição (ou de uma versão antiga) → estado válido ou null. */
export function normalizar(bruto) {
  if (!bruto || typeof bruto !== "object") return null;
  const fim = Number.isFinite(bruto.fim) ? bruto.fim : null;
  const resta = Number.isFinite(bruto.resta) ? Math.max(0, bruto.resta) : null;
  if (fim === null && resta === null) return null;
  const total = Math.max(1, Number.isFinite(bruto.total) ? bruto.total : (resta ?? 1));
  return {
    id: String(bruto.id ?? ""),
    fim: resta === null ? fim : null,
    resta,
    total,
    rotulo: String(bruto.rotulo ?? "").trim().slice(0, ROTULO_MAX),
    para: Array.isArray(bruto.para) ? bruto.para.filter(x => typeof x === "string") : "todos"
  };
}

/** Uma contagem nova de `segundos`, a começar `agora`. */
export function iniciar(segundos, { rotulo = "", para = "todos", id = "" } = {}, agora) {
  const ms = Math.max(1, Math.round(Number(segundos) * 1000) || 0);
  return normalizar({ id, fim: agora + ms, resta: null, total: ms, rotulo, para });
}

export function restanteMs(estado, agora) {
  if (!estado) return 0;
  if (estado.resta !== null) return estado.resta;
  return Math.max(0, estado.fim - agora);
}

/** "inativo" · "a-correr" · "pausado" · "terminado" (chegou a zero; o relógio ainda pode estar a desvanecer). */
export function fase(estado, agora) {
  if (!estado) return "inativo";
  if (estado.resta !== null) return "pausado";
  return estado.fim > agora ? "a-correr" : "terminado";
}

export function pausar(estado, agora) {
  if (fase(estado, agora) !== "a-correr") return estado;
  return { ...estado, fim: null, resta: estado.fim - agora };
}

/** Retomar a zero acaba logo — é o que o mestre pediu ao tirar o tempo todo em pausa. */
export function retomar(estado, agora) {
  if (fase(estado, agora) !== "pausado") return estado;
  return { ...estado, fim: agora + estado.resta, resta: null };
}

/**
 * ±segundos, a correr ou em pausa. Nunca abaixo de zero: tirar mais do que falta
 * acaba a contagem (a correr) ou deixa-a a 0:00 (em pausa). Somar acima do total
 * alarga o total, para a linha não sair da escala.
 */
export function ajustar(estado, deltaSegundos, agora) {
  const f = fase(estado, agora);
  if (f !== "a-correr" && f !== "pausado") return estado;
  const novo = Math.max(0, restanteMs(estado, agora) + Math.round(Number(deltaSegundos) * 1000 || 0));
  const total = Math.max(estado.total, novo);
  return f === "pausado" ? { ...estado, resta: novo, total } : { ...estado, fim: agora + novo, total };
}

/**
 * Segundos a mostrar: arredonda para cima. «0:01» fica no ecrã até ao último
 * instante e o «0:00» só aparece quando acabou mesmo.
 */
export const segundosVisiveis = (ms) => Math.ceil(Math.max(0, ms) / 1000);

/** 59 → «0:59» · 600 → «10:00» · 3725 → «1:02:05». */
export function formatar(segundos) {
  const s = Math.max(0, Math.floor(Number(segundos) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const dois = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${dois(m)}:${dois(r)}` : `${m}:${dois(r)}`;
}

/** Quanto da linha ainda está cheio: 1 no início, 0 no fim. */
export function fracao(estado, agora) {
  if (!estado) return 0;
  return Math.min(1, Math.max(0, restanteMs(estado, agora) / estado.total));
}

/** Os últimos 10 s (e não o zero: aí já é o fim). */
export const nosUltimos = (ms) => ms > 0 && ms <= ULTIMOS_MS;

/** Acabou há pouco: o «0:00» ainda se vê, antes de desvanecer. Quem entra depois não vê nada. */
export function aMostrarFim(estado, agora) {
  return fase(estado, agora) === "terminado" && agora - estado.fim < FIM_VISIVEL_MS;
}

/** O mestre vê sempre; os outros se forem «todos» ou estiverem na lista. */
export function podeVer(estado, user) {
  if (!estado || !user) return false;
  if (user.isGM) return true;
  return estado.para === "todos" || (Array.isArray(estado.para) && estado.para.includes(user.id));
}

/**
 * O `para` da API → o que se guarda. Aceita "todos" (ou nada), ou uma lista de
 * ids OU nomes — numa macro é mais fácil escrever «Ana» do que um id.
 * Mestres e desconhecidos caem fora (o mestre vê sempre de qualquer forma).
 */
export function resolverPara(para, users) {
  if (para === undefined || para === null || para === "todos") return "todos";
  const lista = Array.isArray(para) ? para : [para];
  const jogadores = users.filter(u => !u.isGM);
  const ids = lista.map(x => jogadores.find(u => u.id === x || u.name === x)?.id).filter(Boolean);
  return [...new Set(ids)];
}

/** O estado como a API o devolve: em segundos, legível numa consola. */
export function descrever(estado, agora) {
  return {
    fase: fase(estado, agora),
    restante: segundosVisiveis(restanteMs(estado, agora)),
    total: estado ? Math.round(estado.total / 1000) : 0,
    rotulo: estado?.rotulo ?? "",
    para: estado?.para ?? "todos"
  };
}

/**
 * Gravações em fila. Dois cliques rápidos em «+30 s» liam o mesmo estado antes de
 * o primeiro voltar do servidor, e o segundo apagava o primeiro (a mesma corrida
 * dos Handouts).
 */
export function criarFila() {
  let ultima = Promise.resolve();
  return (tarefa) => {
    const esta = ultima.then(() => tarefa());
    ultima = esta.catch(() => {});        // um erro não encrava as seguintes
    return esta;
  };
}
