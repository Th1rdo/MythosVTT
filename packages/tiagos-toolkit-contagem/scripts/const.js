/** Identidade do módulo e constantes partilhadas. */
export const MODULE_ID = "tiagos-toolkit-contagem";

/** A contagem vive numa só definição do mundo; só o mestre a escreve. */
export const DEF_ESTADO = "estado";
export const DEF_SOM = "som";

/** Os atalhos do painel, em segundos. */
export const PRESETS = [30, 60, 300, 600];

/** O passo dos botões −30 s / +30 s. */
export const PASSO = 30;

/**
 * Quanto tempo o «0:00» fica no ecrã depois de acabar, antes de desvanecer.
 * Chega para toda a mesa perceber que acabou sem ficar a ocupar o topo do mapa.
 */
export const FIM_VISIVEL_MS = 3000;

/** A partir de quanto falta o relógio pulsa e muda de cor. */
export const ULTIMOS_MS = 10_000;

/**
 * De quanto em quanto tempo se redesenha. Os dígitos mudam de segundo a segundo;
 * 250 ms apanha a viragem sem atraso visível e não acorda o browser a cada frame.
 */
export const TIQUE_MS = 250;

export const log = (...args) => console.log(`${MODULE_ID} |`, ...args);
