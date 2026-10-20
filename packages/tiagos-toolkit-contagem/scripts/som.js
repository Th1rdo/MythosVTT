/**
 * O som do fim, sintetizado — sem ficheiro para carregar no Forge (como o papel
 * dos Handouts). Um sino baixo e curto, duas batidas: avisa sem assustar, numa
 * mesa de terror onde um alarme estridente tiraria toda a gente da cena.
 * Segue o volume de «Interface» de cada um.
 */
let ctx = null;
const audio = () => (ctx ??= new (globalThis.AudioContext ?? globalThis.webkitAudioContext)());

/** O volume de Interface deste browser (Mesa: Definições → Som). */
function volume() {
  try { return mesa.audio.volume("interface"); } catch { return 0.5; }
}

/** Um parcial do sino: ataque rápido, cauda exponencial. */
function parcial(a, destino, { freq, ganho, dur, em }) {
  const t = a.currentTime + 0.02 + em;
  const o = a.createOscillator(), g = a.createGain();
  o.type = "sine"; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(ganho, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(destino);
  o.start(t); o.stop(t + dur + 0.05);
}

export function tocarFim() {
  try {
    const v = volume();
    if (!(v > 0)) return;
    const a = audio();
    // o browser suspende o contexto até haver um gesto; quem está na mesa já clicou
    if (a.state === "suspended") a.resume();
    const saida = a.createGain();
    saida.gain.value = 0.16 * v;
    saida.connect(a.destination);
    // primeira batida (dó, com a quinta e a oitava por cima), segunda mais grave
    for (const p of [
      { freq: 523.25, ganho: 1, dur: 2.0, em: 0 },
      { freq: 784.0, ganho: 0.35, dur: 1.4, em: 0 },
      { freq: 1046.5, ganho: 0.15, dur: 0.9, em: 0 },
      { freq: 392.0, ganho: 0.8, dur: 2.4, em: 0.22 },
      { freq: 587.33, ganho: 0.2, dur: 1.2, em: 0.22 }
    ]) parcial(a, saida, p);
  } catch { /* sem áudio: o relógio já avisa à vista */ }
}
