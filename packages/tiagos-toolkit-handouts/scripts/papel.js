import { tamanhoDeChegada, zoomEm, dentroDoEcra } from "./logica.js";
import { ZOOM } from "./const.js";
import { tocar } from "./som.js";

/**
 * A mesa do jogador: os documentos chegam como papéis soltos por cima do jogo.
 *
 * O «Mostrar aos jogadores» do Foundry abre uma janela com moldura, título e
 * barra de rolagem — parece um programa, não um papel. Aqui o documento pousa
 * na mesa: arrasta-se, aproxima-se com a roda (à volta do rato), duplo clique
 * repõe, Esc ou o × tira-o da frente. Vários podem estar abertos ao mesmo tempo,
 * como papéis espalhados; clicar num põe-no por cima.
 *
 * É tudo local: mexer num papel não mexe no dos outros.
 */

let raiz = null;
let topo = 10;
const abertos = new Map();            // id → { el, p, largura, altura }

function montar() {
  if (raiz) return raiz;
  raiz = document.createElement("div");
  raiz.id = "ho-mesa";
  document.body.appendChild(raiz);
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !abertos.size) return;
    if (ev.target.closest?.("input, textarea, [contenteditable]")) return;
    const cima = [...abertos.values()].sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0];
    if (!cima) return;
    ev.stopPropagation();
    ev.preventDefault();
    fechar(cima.id);
  }, true);
  return raiz;
}

const aplicar = (d) => {
  d.el.style.transform = `translate(${d.p.x}px, ${d.p.y}px) scale(${d.p.escala})`;
  d.el.style.setProperty("--ho-inverso", String(1 / d.p.escala));
};

function paraCima(d) {
  d.el.style.zIndex = String(++topo);
}

/** Onde e com que tamanho o papel pousa: ao centro, a caber. */
function posicaoInicial(d) {
  const vw = globalThis.innerWidth, vh = globalThis.innerHeight;
  const g = tamanhoDeChegada(d.natural.w, d.natural.h, vw, vh);
  d.largura = g.largura; d.altura = g.altura;
  d.el.style.width = `${g.largura}px`;
  d.el.style.height = `${g.altura}px`;
  // cada papel novo pousa um pouco ao lado do anterior, para não esconder o que já lá estava
  const desvio = (abertos.size - 1) * 28;
  d.p = { x: (vw - g.largura) / 2 + desvio, y: (vh - g.altura) / 2 + desvio * 0.6, escala: 1 };
  aplicar(d);
}

/**
 * Pôr um documento na mesa. `chegou` = veio do mestre agora (som e entrada);
 * sem isso é o jogador a abrir da coleção dele.
 */
export function abrir(item, { chegou = false, aoVer = null } = {}) {
  montar();
  const ja = abertos.get(item.id);
  if (ja && ja.img === item.img) {
    paraCima(ja);
    ja.el.classList.remove("ho-pulsar"); void ja.el.offsetWidth; ja.el.classList.add("ho-pulsar");
    if (chegou) tocar.chegar();
    aoVer?.(item.id);
    return;
  }
  if (ja) fechar(item.id, { depressa: true });

  const el = document.createElement("div");
  el.className = "ho-papel" + (chegou ? " ho-chegou" : " ho-abriu");
  el.dataset.id = item.id;
  // um papel pousado nunca fica perfeitamente direito
  const inclinacao = (Math.random() * 2.4 - 1.2).toFixed(2);
  el.innerHTML = `
    <div class="ho-folha" style="--ho-inclinacao:${inclinacao}deg">
      <img draggable="false" alt="">
    </div>
    <div class="ho-cantos">
      <button type="button" class="ho-botao" data-ho="repor" data-tooltip="HANDOUTS.Mesa.Repor"><i class="fa-solid fa-compress"></i></button>
      <button type="button" class="ho-botao" data-ho="fechar" data-tooltip="HANDOUTS.Mesa.Fechar"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  const img = el.querySelector("img");
  img.alt = item.nome ?? "";
  const d = { id: item.id, img: item.img, el, p: { x: 0, y: 0, escala: 1 }, largura: 0, altura: 0, natural: { w: 0, h: 0 } };
  abertos.set(item.id, d);
  paraCima(d);
  el.style.visibility = "hidden";
  raiz.appendChild(el);

  const pousar = () => {
    d.natural = { w: img.naturalWidth, h: img.naturalHeight };
    posicaoInicial(d);
    el.style.visibility = "";
    if (chegou) tocar.chegar();
    aoVer?.(item.id);
  };
  img.addEventListener("load", pousar, { once: true });
  img.addEventListener("error", pousar, { once: true });
  img.src = item.img;

  ligar(d);
}

function ligar(d) {
  const el = d.el;

  el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    paraCima(d);
    if (ev.target.closest(".ho-botao")) return;
    ev.preventDefault();
    const ini = { x: ev.clientX, y: ev.clientY, px: d.p.x, py: d.p.y };
    el.setPointerCapture(ev.pointerId);
    el.classList.add("ho-a-arrastar");
    tocar.pegar();
    const mover = (e) => {
      d.p = dentroDoEcra({ ...d.p, x: ini.px + e.clientX - ini.x, y: ini.py + e.clientY - ini.y },
        d.largura, d.altura, globalThis.innerWidth, globalThis.innerHeight);
      aplicar(d);
    };
    const largar = () => {
      el.classList.remove("ho-a-arrastar");
      el.removeEventListener("pointermove", mover);
      el.removeEventListener("pointerup", largar);
      el.removeEventListener("pointercancel", largar);
    };
    el.addEventListener("pointermove", mover);
    el.addEventListener("pointerup", largar);
    el.addEventListener("pointercancel", largar);
  });

  // a roda aproxima à volta do rato; o trackpad (pinça = ctrl+roda) faz o mesmo com mais finura
  el.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const passo = ev.ctrlKey ? Math.exp(-ev.deltaY / 120) : (ev.deltaY < 0 ? ZOOM.passo : 1 / ZOOM.passo);
    d.p = zoomEm(d.p, passo, ev.clientX, ev.clientY);
    d.p = dentroDoEcra(d.p, d.largura, d.altura, globalThis.innerWidth, globalThis.innerHeight);
    aplicar(d);
  }, { passive: false });

  el.addEventListener("dblclick", (ev) => {
    if (ev.target.closest(".ho-botao")) return;
    repor(d);
  });

  el.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-ho]");
    if (!b) return;
    if (b.dataset.ho === "fechar") fechar(d.id);
    if (b.dataset.ho === "repor") repor(d);
  });
}

function repor(d) {
  d.el.classList.add("ho-a-repor");
  const vw = globalThis.innerWidth, vh = globalThis.innerHeight;
  d.p = { x: (vw - d.largura) / 2, y: (vh - d.altura) / 2, escala: 1 };
  aplicar(d);
  setTimeout(() => d.el.classList.remove("ho-a-repor"), 260);
}

export function fechar(id, { depressa = false } = {}) {
  const d = abertos.get(id);
  if (!d) return;
  abertos.delete(id);
  if (depressa) return d.el.remove();
  d.el.classList.add("ho-sair");
  setTimeout(() => d.el.remove(), 220);
}

export const estaAberto = (id) => abertos.has(id);

/** A janela mudou de tamanho: os papéis que ficaram fora voltam para dentro. */
globalThis.addEventListener?.("resize", () => {
  for (const d of abertos.values()) {
    d.p = dentroDoEcra(d.p, d.largura, d.altura, globalThis.innerWidth, globalThis.innerHeight);
    aplicar(d);
  }
});
