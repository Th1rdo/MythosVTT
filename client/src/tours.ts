import { game } from "./game.ts";
import { h, setChildren } from "./dom.ts";
import { t } from "./i18n.ts";
import { closeWindow } from "./ui/windows.ts";

/**
 * Guided tours (Foundry's Tours): steps that point at a part of the screen with a short text. Progress
 * is kept per browser, so a tour can be resumed or restarted from Definições.
 */
interface TourStep {
  /** CSS selector of what to point at (none = a centred card). */
  selector?: string;
  title: string;
  content: string;
  gm?: boolean;
  /** Open a sidebar tab before showing the step. */
  tab?: string;
}

interface Tour {
  id: string;
  title: string;
  description: string;
  gm?: boolean;
  steps: TourStep[];
}

const KEY = "mesa.tours";

function readProgress(): Record<string, number | "done"> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}
function saveProgress(p: Record<string, number | "done">): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private mode.
  }
}

export const TOURS: Tour[] = [
  {
    id: "first-steps", title: "Primeiros passos", description: "O ecrã da Mesa: barras, separadores e onde está cada coisa.",
    steps: [
      { title: "Bem-vindo à Mesa", content: "Uma visita rápida pelo ecrã. Podes saltar quando quiseres e voltar a esta visita em Definições → Visitas guiadas." },
      { selector: "#sidebar .sidebar-tabs", title: "Separadores", content: "Chat, combate, atores, itens, diário, tabelas, cartas, macros, playlists, compêndios e definições. Clica no separador aberto para esconder o painel." },
      { selector: ".chat-input", tab: "chat", title: "Chat e dados", content: "Escreve aqui. /r 1d20+5 rola dados, /gr só para ti e o mestre, /w Nome para sussurrar. [[1d6]] no meio do texto também rola." },
      { selector: "#controls", title: "Controlos do mapa", content: "À esquerda escolhes a camada (tokens, medição, desenhos…), à direita a ferramenta dessa camada. Passa o rato para ver o que cada uma faz." },
      { selector: "#navigation", title: "Cenas", content: "A cena que estás a ver e, em cenas com andares, os níveis." },
      { selector: "#hotbar", title: "Barra de macros", content: "Arrasta itens, atores, entradas, tabelas ou macros para aqui e usa-os com 1–0. Clica numa casa vazia para escrever uma macro." },
      { selector: "#players", title: "Jogadores", content: "Quem está ligado. Clica no teu nome para mudar a cor, a imagem ou a personagem." },
      { selector: "#sidebar .sidebar-tabs [data-tab=settings]", title: "Definições", content: "Teclas, som, tamanho da interface, língua e, para o mestre, as regras da mesa. Esc abre o menu principal." }
    ]
  },
  {
    id: "the-map", title: "O mapa", description: "Mover, medir, sinalizar e usar os tokens.",
    steps: [
      { selector: ".board", title: "O mapa", content: "Arrasta com o botão direito (ou Espaço + arrastar) para mover a vista; a roda aproxima e afasta." },
      { selector: "#controls", title: "Tokens", content: "Clica num token para o selecionar (Shift para juntar), arrasta para mover. As setas e WASD também movem. Shift + roda roda o token." },
      { selector: "#controls", title: "Medir e sinalizar", content: "A régua mede distâncias (Espaço junta pontos intermédios). Duplo clique num sítio vazio do mapa faz um sinal que todos veem." },
      { selector: "#controls", title: "Botão direito num token", content: "Abre o painel do token: barras, condições, elevação, esconder, combate. Duplo clique abre a ficha." },
      { selector: "#sidebar .sidebar-tabs [data-tab=combat]", tab: "combat", title: "Combate", content: "C põe ou tira os tokens selecionados do combate. A iniciativa e os turnos estão neste separador." }
    ]
  },
  {
    id: "gm-prep", title: "Preparar uma sessão", description: "Para o mestre: cenas, personagens, compêndios, música e a configuração.", gm: true,
    steps: [
      { selector: "#sidebar .sidebar-tabs [data-tab=scenes]", tab: "scenes", title: "Cenas", content: "Cria cenas e escolhe a imagem de fundo. O alvo ativa a cena para todos; clicar só a mostra a ti." },
      { selector: "#sidebar .sidebar-tabs [data-tab=actors]", tab: "actors", title: "Atores", content: "Personagens e ameaças. Arrasta um ator para o mapa para pôr o token; dá permissões aos jogadores na ficha." },
      { selector: "#sidebar .sidebar-tabs [data-tab=compendia]", tab: "compendia", title: "Compêndios", content: "Bibliotecas de itens, rituais, tabelas… Os do sistema Ordem Paranormal entram com npm run import-packs. Os jogadores arrastam itens para as fichas." },
      { selector: "#sidebar .sidebar-tabs [data-tab=journal]", tab: "journal", title: "Diário", content: "Entradas com páginas, segredos que só tu vês e \"Mostrar aos jogadores\"." },
      { selector: "#sidebar .sidebar-tabs [data-tab=playlists]", tab: "playlists", title: "Música e sons", content: "Playlists tocam para todos ao mesmo tempo. Sons ambiente põem-se no mapa com a ferramenta ♫." },
      { selector: "#controls", title: "Paredes, luzes e regiões", content: "As camadas do mestre: paredes e portas, luzes, regiões com comportamentos (teletransporte, efeitos, pausa…)." },
      { selector: "#sidebar .sidebar-tabs [data-tab=settings]", tab: "settings", title: "Regras da mesa", content: "Em Definições → Permissões dos jogadores decides o que podem fazer. Espaço põe o jogo em pausa." },
      { title: "Configuração", content: "Em /setup (ou no menu principal, Esc) crias mundos, importas do Foundry e fazes cópias de segurança." }
    ]
  }
];

let overlay: HTMLElement | null = null;

export function tourStatus(id: string): "new" | "started" | "done" {
  const p = readProgress()[id];
  return p === "done" ? "done" : p === undefined ? "new" : "started";
}

export function endTour(): void {
  overlay?.remove();
  overlay = null;
}

/** Start (or resume) a tour; `restart` begins again from the first step. */
export function startTour(id: string, restart = false): void {
  const tour = TOURS.find(x => x.id === id);
  if (!tour) return;
  const steps = tour.steps.filter(s => !s.gm || game.isGM);
  const progress = readProgress();
  let i = !restart && typeof progress[id] === "number" ? Math.min(progress[id] as number, steps.length - 1) : 0;
  endTour();
  const hole = h("div.tour-hole");
  const card = h("div.tour-card");
  overlay = h("div#tour", null, hole, card);
  document.body.append(overlay);

  const show = () => {
    const step = steps[i];
    progress[id] = i;
    saveProgress(progress);
    if (step.tab) {
      const btn = document.querySelector<HTMLButtonElement>(`#sidebar .sidebar-tabs [data-tab=${step.tab}]`);
      if (btn && !btn.classList.contains("active")) btn.click();
    }
    // Let the tab render before measuring.
    requestAnimationFrame(() => {
      const target = step.selector ? [...document.querySelectorAll<HTMLElement>(step.selector)].find(el => el.offsetParent !== null) : null;
      const r = target?.getBoundingClientRect();
      hole.hidden = !r;
      if (r) Object.assign(hole.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
      setChildren(card,
        h("header.row", null, h("strong.grow", null, t(step.title)), h("span.muted.small", null, `${i + 1}/${steps.length}`)),
        h("p", null, t(step.content)),
        h("div.row.end", null,
          h("button.small", { onclick: () => { endTour(); } }, t("Sair da visita")),
          i > 0 ? h("button.small", { onclick: () => { i--; show(); } }, t("Anterior")) : null,
          h("button.small.primary", {
            onclick: () => {
              if (i < steps.length - 1) {
                i++;
                show();
              } else {
                progress[id] = "done";
                saveProgress(progress);
                endTour();
              }
            }
          }, i < steps.length - 1 ? t("Seguinte") : t("Terminar"))));
      // Place the card beside the target (or centred).
      const cw = 320, ch = card.offsetHeight || 160;
      let left = window.innerWidth / 2 - cw / 2, top = window.innerHeight / 2 - ch / 2;
      if (r) {
        left = r.right + 16 + cw < window.innerWidth ? r.right + 16 : r.left - 16 - cw > 0 ? r.left - 16 - cw : Math.min(window.innerWidth - cw - 8, Math.max(8, r.left));
        top = Math.min(window.innerHeight - ch - 8, Math.max(8, r.top));
        if (left === Math.min(window.innerWidth - cw - 8, Math.max(8, r.left))) top = r.bottom + 16 + ch < window.innerHeight ? r.bottom + 16 : Math.max(8, r.top - 16 - ch);
      }
      Object.assign(card.style, { left: `${left}px`, top: `${top}px`, width: `${cw}px` });
    });
  };
  show();
}

/** Offer the first tour once, to someone who has never seen one. */
export function offerFirstTour(): void {
  const progress = readProgress();
  if (Object.keys(progress).length) return;
  progress["first-steps"] = 0;
  saveProgress(progress);
  const card = h("div.tour-offer", null,
    h("strong", null, t("Primeira vez na Mesa?")),
    h("p", null, t("Uma visita guiada de um minuto mostra onde está cada coisa.")),
    h("div.row.end", null,
      h("button.small", { onclick: () => card.remove() }, t("Agora não")),
      h("button.small.primary", { onclick: () => { card.remove(); startTour("first-steps", true); } }, t("Começar"))));
  document.body.append(card);
}

/** Definições → Visitas guiadas. */
export function toursPanel(): HTMLElement {
  return h("div.stack", null, TOURS.filter(x => !x.gm || game.isGM).map(tour => {
    const status = tourStatus(tour.id);
    return h("div.tour-row", null,
      h("div.stack.grow", null, h("strong", null, t(tour.title)), h("span.muted.small", null, t(tour.description))),
      h("span.tag", null, status === "done" ? t("vista") : status === "started" ? t("a meio") : t("nova")),
      h("button.small", { onclick: () => { closeWindow("settings-config"); startTour(tour.id, status === "done"); } }, status === "started" ? t("Continuar") : t("Começar")));
  }));
}
