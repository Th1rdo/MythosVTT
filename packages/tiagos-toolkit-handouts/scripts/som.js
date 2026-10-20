/**
 * O som de um papel a ser pousado na mesa, sintetizado — sem ficheiro para
 * carregar no Forge. Segue o volume de «Interface» de cada um.
 */
let ctx = null;
const audio = () => (ctx ??= new (globalThis.AudioContext ?? globalThis.webkitAudioContext)());

/** O volume de Interface deste browser (Mesa: Definições → Som). */
function volume() {
  try { return mesa.audio.volume("interface"); } catch { return 0.5; }
}

/** Ruído filtrado com um envelope: o roçar do papel. */
function rocar({ dur = 0.22, freq = 2600, q = 0.7, ganho = 0.22, em = 0 }) {
  const a = audio(), t = a.currentTime + em;
  const n = Math.floor(a.sampleRate * dur);
  const b = a.createBuffer(1, n, a.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const env = Math.sin(Math.PI * i / n) ** 1.5;
    d[i] = (Math.random() * 2 - 1) * env * (0.6 + 0.4 * Math.random());
  }
  const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  f.type = "bandpass"; f.frequency.value = freq; f.Q.value = q;
  g.gain.value = ganho * volume();
  s.buffer = b; s.connect(f).connect(g).connect(a.destination); s.start(t);
}

export const tocar = {
  /** Um documento chega: desliza e pousa. */
  chegar: () => { try { rocar({ dur: 0.28, freq: 1800 }); rocar({ dur: 0.08, freq: 900, q: 1.2, ganho: 0.28, em: 0.24 }); } catch { /* sem áudio */ } },
  /** Pegar/largar um papel: um roçar curto. */
  pegar: () => { try { rocar({ dur: 0.1, freq: 3200, ganho: 0.08 }); } catch { /* sem áudio */ } }
};
