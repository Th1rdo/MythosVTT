/**
 * Trilha — trocar de música sem sobrepor.
 *
 * Numa playlist sequencial ou aleatória, escolher outra música à mão fazia a nova
 * começar enquanto a anterior ainda saía (a Mesa, como o Foundry, faz as duas coisas
 * ao mesmo tempo). O Tiago quer a anterior a sair por inteiro e só depois a nova a entrar.
 *
 * Por isso: parar as que estão a tocar (desvanecem em todos os clientes, com o `fade`
 * da playlist) e tocar a pedida quando a saída já vai no fim — 75% por defeito. Esperar
 * a saída inteira deixava um buraco de silêncio (0.1.0 no Foundry): as caudas tocam-se.
 *
 * Port para a Mesa: em vez do libWrapper em `Playlist.prototype.playSound`, o hook
 * `prePlaylistAction` (cancela o pedido e manda os seus com `noHook`). Só o mestre decide;
 * os jogadores recebem as duas mudanças pelo servidor, em sincronia.
 */
const MODULE_ID = "tiagos-toolkit-trilha";
const SEQUENTIAL = 0, SHUFFLE = 1;
const esperas = new Map();   // playlist → som pedido enquanto a anterior sai
const { hooks, i18n } = mesa;

hooks.once("init", () => {
  mesa.settings.register(MODULE_ID, "sairAntes", {
    name: i18n.localize("TRILHA.Config.SairAntes"), hint: i18n.localize("TRILHA.Config.SairAntesHint"),
    scope: "world", type: "boolean", default: true
  });
  mesa.settings.register(MODULE_ID, "entrada", {
    name: i18n.localize("TRILHA.Config.Entrada"), hint: i18n.localize("TRILHA.Config.EntradaHint"),
    scope: "world", type: "number", default: 75, range: { min: 0, max: 100, step: 5 }
  });
});

hooks.on("prePlaylistAction", (acao) => {
  if (acao.action !== "play" || !mesa.game.isGM || !mesa.settings.get(`${MODULE_ID}.sairAntes`)) return;
  const playlist = mesa.game.get("Playlist", acao.playlistId);
  const sons = mesa.game.children("PlaylistSound", acao.playlistId);
  const pedido = sons.find(s => s._id === acao.soundId);
  const fade = pedido?.fade ?? playlist?.fade ?? 0;
  const outras = sons.filter(s => s.playing && s._id !== acao.soundId);
  if (!playlist || !(fade > 0) || !outras.length || ![SEQUENTIAL, SHUFFLE].includes(playlist.mode)) return;
  trocar(acao, outras, fade);
  return false;
});

async function trocar(acao, outras, fade) {
  esperas.set(acao.playlistId, acao.soundId);
  await Promise.all(outras.map(s => mesa.playlists.action({ action: "stop", playlistId: acao.playlistId, soundId: s._id }, { noHook: true })));
  const entrada = Math.min(100, Math.max(0, Number(mesa.settings.get(`${MODULE_ID}.entrada`)) || 0)) / 100;
  await new Promise((r) => setTimeout(r, fade * entrada));
  // o mestre pode ter escolhido outra música enquanto esta esperava: vale a última
  if (esperas.get(acao.playlistId) !== acao.soundId) return;
  esperas.delete(acao.playlistId);
  await mesa.playlists.action(acao, { noHook: true });
}
