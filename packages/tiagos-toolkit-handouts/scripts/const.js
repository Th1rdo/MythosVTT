/** Identidade do módulo e constantes partilhadas. */
export const MODULE_ID = "tiagos-toolkit-handouts";

/** A biblioteca do mestre vive numa definição do mundo; a coleção de cada jogador numa flag do utilizador. */
export const DEF_BIBLIOTECA = "biblioteca";
export const FLAG_COLECAO = "colecao";

/** Para onde vão as imagens largadas do computador do mestre (no Forge: os assets dele). */
export const PASTA_ENVIOS = "tiagos-toolkit-handouts";

/**
 * Zoom de um documento na mesa do jogador, em múltiplos do tamanho com que chega.
 * 6× chega para ler a letra miúda de um recorte de jornal numa imagem grande.
 */
export const ZOOM = { min: 0.4, max: 6, passo: 1.12 };

/** Um documento chega a ocupar, no máximo, esta fração do ecrã. */
export const CHEGADA = { largura: 0.62, altura: 0.78 };

export const log = (...args) => console.log(`${MODULE_ID} |`, ...args);
