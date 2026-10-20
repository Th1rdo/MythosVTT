import type { CardDoc, CardFace, CardsAction, CardsDoc, DrawHow } from "../../../shared/protocol.ts";
import { OWNERSHIP } from "../../../shared/protocol.ts";
import { ownershipLevel } from "../../../shared/permissions.ts";
import { game, toast } from "../game.ts";
import { avatar, h, pickFile, safeHtml, setChildren, upload } from "../dom.ts";
import { directory } from "./directory.ts";
import { ownershipEditor } from "./sheet.ts";
import { closeWindow, confirmDialog, openWindow, setWindowTitle } from "./windows.ts";

const TYPE_LABELS: Record<CardsDoc["type"], string> = { deck: "Baralho", hand: "Mão", pile: "Monte" };
const HOW: [DrawHow, string][] = [["top", "De cima"], ["bottom", "De baixo"], ["random", "Ao calhas"]];
const level = (s: CardsDoc) => ownershipLevel(s.ownership, game.user);
const cardsOf = (stackId: string) => game.children<CardDoc>("Card", stackId).sort((a, b) => a.sort - b.sort || a._id.localeCompare(b._id));

export async function cardsAction(action: CardsAction): Promise<boolean> {
  const res = await game.socket.timeout(10_000).emitWithAck("cards", action);
  if (!res.ok) toast(res.error, "error");
  return res.ok;
}

const RED = new Set(["♥", "♦"]);
/** What a card shows: its face (or back) image, or a drawn card with its text. */
export function cardTile(c: CardDoc, size: "small" | "large" = "small"): HTMLElement {
  const face: CardFace | undefined = c.face === null ? c.back : c.faces[c.face];
  const img = face?.img;
  const label = c.face === null ? (c.back?.name || "") : (face?.name || c.name);
  if (img) return h("div", { className: `card-tile ${size}` }, h("img", { src: img, alt: label, draggable: false }));
  if (c.face === null) return h("div", { className: `card-tile ${size} back` }, h("span", null, c.back?.text || "✦"));
  const text = face?.text || c.name;
  const red = [...RED].some(s => text.includes(s) || c.suit.includes(s));
  return h("div", { className: `card-tile ${size} text${red ? " red" : ""}` }, h("span.corner", null, text), h("span.center", null, text));
}

export function cardsPanel(): HTMLElement {
  const dir = directory<CardsDoc>({
    type: "Cards",
    create: { label: "Criar pilha", icon: "fa-solid fa-clone", run: () => createStack() },
    docs: () => game.all<CardsDoc>("Cards"),
    empty: game.isGM ? "Sem baralhos." : "Sem cartas para ti.",
    sort: (a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"),
    onOpen: s => openCardsSheet(s._id),
    entry: s => [
      avatar(s.img, s.name, 32),
      h("span.grow", null, s.name),
      h("span.tag", null, TYPE_LABELS[s.type]),
      s.displayCount || game.isGM ? h("span.muted.small", { title: "Cartas disponíveis" }, String(s.available ?? 0)) : null
    ]
  });
  return h("div.panel", null, dir.element);
}

async function createStack(): Promise<void> {
  const key = "cards-new";
  const body = openWindow(key, "Nova pilha de cartas", { width: 340 });
  if (!body) return;
  const name = h("input", { placeholder: "Nome" });
  const type = h("select", null, (Object.keys(TYPE_LABELS) as CardsDoc["type"][]).map(t => h("option", { value: t }, TYPE_LABELS[t])));
  const standard = h("input", { type: "checkbox" });
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const [s] = await game.create<CardsDoc>("Cards", { name: name.value.trim() || TYPE_LABELS[type.value as CardsDoc["type"]], type: type.value, sort: Date.now() });
      if (s && standard.checked && type.value === "deck") await game.create("Card", standardDeck(), s._id);
      closeWindow(key);
      if (s) openCardsSheet(s._id);
    }
  },
    h("label.field", null, h("span", null, "Nome"), name), h("label.field", null, h("span", null, "Tipo"), type),
    h("label.row", null, standard, "Baralho padrão de 52 cartas + 2 jókers"),
    h("div.row.end", null, h("button.primary", { type: "submit" }, "Criar"))));
  name.focus();
}

/** 52 French-suited cards and two jokers, drawn as text (no images needed). */
export function standardDeck(): Record<string, unknown>[] {
  const suits: [string, string][] = [["Copas", "♥"], ["Ouros", "♦"], ["Espadas", "♠"], ["Paus", "♣"]];
  const ranks = ["Ás", "2", "3", "4", "5", "6", "7", "8", "9", "10", "Valete", "Dama", "Rei"];
  const short = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const back = { name: "Carta", text: "✦", img: null };
  const cards: Record<string, unknown>[] = [];
  let sort = 0;
  for (const [suit, sym] of suits) {
    ranks.forEach((r, i) => {
      const name = `${r} de ${suit}`;
      cards.push({ name, suit: sym, value: i + 1, back, faces: [{ name, text: `${short[i]}${sym}`, img: null }], face: 0, sort: (sort += 1000) });
    });
  }
  for (const k of [1, 2]) cards.push({ name: `Jóker ${k}`, suit: "", value: 0, back, faces: [{ name: `Jóker ${k}`, text: "★", img: null }], face: 0, sort: (sort += 1000) });
  return cards;
}

/**
 * A stack's window: its cards (for those who may see them), the stack's actions and, per card,
 * flipping and moving it on. Players work with their own hands; the GM deals.
 */
export function openCardsSheet(stackId: string): void {
  const key = `cards-${stackId}`;
  const offs: (() => void)[] = [];
  const body = openWindow(key, game.get<CardsDoc>("Cards", stackId)?.name ?? "Cartas", { width: 660, onClose: () => offs.forEach(f => f()) });
  if (!body) return;
  const selected = new Set<string>();
  let number = 1;
  let how: DrawHow = "top";

  const render = () => {
    const s = game.get<CardsDoc>("Cards", stackId);
    if (!s) return closeWindow(key);
    setWindowTitle(key, `${s.name} · ${TYPE_LABELS[s.type]}`);
    const owner = level(s) >= OWNERSHIP.OWNER;
    const others = game.all<CardsDoc>("Cards").filter(x => x._id !== stackId);
    const decks = others.filter(x => x.type === "deck");
    const targets = others.filter(x => ownershipLevel(x.ownership, game.user) >= OWNERSHIP.LIMITED);
    const cards = cardsOf(stackId);
    for (const id of [...selected]) if (!cards.some(c => c._id === id)) selected.delete(id);

    const numInput = h("input.num", { type: "number", min: 1, max: 54, value: String(number), title: "Quantas", onchange: (e: Event) => (number = Math.max(1, Number((e.target as HTMLInputElement).value) || 1)) });
    const howSelect = h("select", { onchange: (e: Event) => (how = (e.target as HTMLSelectElement).value as DrawHow) }, HOW.map(([v, l]) => h("option", { value: v, selected: v === how }, l)));
    const targetSelect = (list: CardsDoc[]) => h("select", null, list.map(t => h("option", { value: t._id }, `${t.name} (${TYPE_LABELS[t.type]})`)));

    let actions: (HTMLElement | null)[] = [];
    if (s.type === "deck" && owner) {
      const to = h("select", { multiple: true, size: Math.min(4, Math.max(2, targets.length)) }, targets.filter(t => t.type !== "deck").map(t => h("option", { value: t._id }, t.name)));
      const faceDown = h("input", { type: "checkbox" });
      actions = [
        h("div.row.wrap.cards-actions", null,
          h("span.muted.small", null, "Distribuir"), numInput, h("span.muted.small", null, "a cada:"), to, howSelect, h("label.row", null, faceDown, "Viradas para baixo"),
          h("button.primary", {
            onclick: () => {
              const ids = [...to.selectedOptions].map(o => o.value);
              if (!ids.length) return toast("Escolhe as mãos/montes", "error");
              cardsAction({ action: "deal", from: stackId, to: ids, number, how, faceDown: faceDown.checked });
            }
          }, h("i.fa-solid.fa-share-nodes"), " Distribuir"))
      ];
    } else if (owner && decks.length) {
      const from = targetSelect(decks.filter(d => ownershipLevel(d.ownership, game.user) >= OWNERSHIP.LIMITED));
      actions = [h("div.row.wrap.cards-actions", null,
        h("span.muted.small", null, "Tirar"), numInput, h("span.muted.small", null, "de"), from, howSelect,
        h("button.primary", { onclick: () => from.value && cardsAction({ action: "draw", to: stackId, from: from.value, number, how }) }, h("i.fa-solid.fa-hand"), " Tirar"))];
    }
    if (owner && selected.size && targets.length) {
      const to = targetSelect(targets);
      const pass = (kind: "pass" | "play" | "discard") => () => cardsAction({ action: "pass", from: stackId, to: to.value, cardIds: [...selected], kind }).then(ok => ok && selected.clear());
      actions.push(h("div.row.wrap.cards-actions", null,
        h("span.muted.small", null, `${selected.size} selecionada(s) →`), to,
        h("button", { onclick: pass("play") }, h("i.fa-solid.fa-play"), " Jogar"),
        h("button", { onclick: pass("pass") }, h("i.fa-solid.fa-right-left"), " Passar"),
        h("button", { onclick: pass("discard") }, h("i.fa-solid.fa-trash-arrow-up"), " Descartar")));
    }

    const visible = level(s) >= OWNERSHIP.OBSERVER;
    const grid = visible
      ? h("div.cards-grid", null, cards.map(c => {
        const sel = selected.has(c._id);
        return h("div", {
          className: `card-slot${s.type === "deck" && c.drawn ? " drawn" : ""}${sel ? " selected" : ""}`,
          title: c.face === null ? "Virada para baixo" : c.name,
          onclick: () => {
            if (!owner) return openCardView(stackId, c._id);
            sel ? selected.delete(c._id) : selected.add(c._id);
            render();
          },
          ondblclick: () => openCardView(stackId, c._id)
        }, cardTile(c), h("span.card-name", null, c.face === null && !owner ? "?" : c.name));
      }))
      : h("p.muted", null, `${s.available} carta(s). Não podes ver as cartas desta pilha.`);

    setChildren(body,
      h("div.row.wrap.toolbar", null,
        avatar(s.img, s.name, 36),
        h("div.stack.grow", null, h("strong", null, s.name), h("span.muted.small", null, `${TYPE_LABELS[s.type]} · ${s.available} disponível(eis)${visible && owner ? " · clica para escolher, duplo clique para ver" : ""}`)),
        owner && h("button.small", { title: "Baralhar", onclick: () => cardsAction({ action: "shuffle", stack: stackId }) }, h("i.fa-solid.fa-shuffle")),
        owner && h("button.small", {
          title: s.type === "deck" ? "Recolher todas as cartas deste baralho" : "Devolver as cartas aos baralhos",
          onclick: async () => { if (await confirmDialog(s.type === "deck" ? `Recolher todas as cartas de "${s.name}" (de todas as mãos e montes)?` : `Devolver as cartas de "${s.name}" aos baralhos?`, "Recolher")) cardsAction({ action: "recall", stack: stackId }); }
        }, h("i.fa-solid.fa-rotate-left")),
        game.isGM && h("button.small", { title: "Adicionar carta", onclick: () => openCardConfig(stackId) }, h("i.fa-solid.fa-plus")),
        game.isGM && s.type === "deck" && h("button.small", {
          title: "Juntar um baralho padrão de 52 cartas", onclick: async () => { if (await confirmDialog("Juntar 52 cartas + 2 jókers a este baralho?", "Juntar")) game.create("Card", standardDeck(), stackId); }
        }, h("i.fa-solid.fa-layer-group")),
        game.isGM && h("button.small", { title: "Configurar", onclick: () => openStackConfig(stackId) }, h("i.fa-solid.fa-gear"))),
      ...actions,
      grid,
      game.isGM ? ownershipEditor(s, "Cards") : null);
  };
  offs.push(game.on("Cards", e => (e.op === "delete" && e.ids.includes(stackId) ? closeWindow(key) : render())));
  offs.push(game.on("Card", e => e.docs.some(d => d._parent === stackId) && render()));
  render();
}

/** One card, big, with flip and (GM) edit. */
function openCardView(stackId: string, cardId: string): void {
  const key = `card-${cardId}`;
  const offs: (() => void)[] = [];
  const body = openWindow(key, "Carta", { width: 340, onClose: () => offs.forEach(f => f()) });
  if (!body) return;
  const render = () => {
    const c = game.get<CardDoc>("Card", cardId);
    const s = game.get<CardsDoc>("Cards", stackId);
    if (!c || !s || c._parent !== stackId) return closeWindow(key);
    const owner = level(s) >= OWNERSHIP.OWNER;
    setWindowTitle(key, c.face === null && !owner ? "Carta virada" : c.name);
    const face = c.face === null ? null : c.faces[c.face];
    const next = c.face === null ? 0 : c.face + 1 < c.faces.length ? c.face + 1 : null;
    setChildren(body,
      h("div.card-view", null, cardTile(c, "large")),
      face?.text && face.img ? h("p", null, face.text) : null,
      c.description && c.face !== null ? h("div.prose.small", null, safeHtml(c.description)) : null,
      h("div.row.end", null,
        owner && h("button", { onclick: () => cardsAction({ action: "flip", stack: stackId, cardId, face: next }) },
          h("i.fa-solid.fa-rotate"), next === null ? " Virar para baixo" : c.face === null ? " Virar para cima" : " Outra face"),
        game.isGM && h("button", { onclick: () => openCardConfig(stackId, cardId) }, h("i.fa-solid.fa-pen"), " Editar")));
  };
  offs.push(game.on("Card", e => e.ids.includes(cardId) && render()));
  render();
}

function openStackConfig(stackId: string): void {
  const key = `cards-config-${stackId}`;
  const s = game.get<CardsDoc>("Cards", stackId);
  if (!s) return;
  const body = openWindow(key, `Configurar: ${s.name}`, { width: 380 });
  if (!body) return;
  const name = h("input", { value: s.name });
  const type = h("select", null, (Object.keys(TYPE_LABELS) as CardsDoc["type"][]).map(t => h("option", { value: t, selected: s.type === t }, TYPE_LABELS[t])));
  const description = h("textarea", { rows: 3, value: s.description });
  const img = h("input", { value: s.img ?? "" });
  const displayCount = h("input", { type: "checkbox", checked: s.displayCount });
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      await game.update("Cards", { _id: stackId, name: name.value.trim() || s.name, type: type.value, description: description.value, img: img.value.trim() || null, displayCount: displayCount.checked });
      closeWindow(key);
    }
  },
    h("label.field", null, h("span", null, "Nome"), name), h("label.field", null, h("span", null, "Tipo"), type),
    h("label.field", null, h("span", null, "Imagem"), h("div.row", null, img, h("button", { type: "button", onclick: async () => { const f = await pickFile("image/*"); if (f) img.value = await upload(f); } }, h("i.fa-solid.fa-upload")))),
    h("label.field", null, h("span", null, "Descrição"), description),
    h("label.row", null, displayCount, "Mostrar a contagem a todos"),
    h("div.row.end", null,
      h("button.danger", { type: "button", onclick: async () => { if (await confirmDialog(`Apagar "${s.name}" e as suas cartas?`)) { await game.delete("Cards", stackId); closeWindow(key); } } }, "Apagar"),
      h("button.primary", { type: "submit" }, "Guardar"))));
}

/** Create (no id) or edit a card: faces (picture and/or text), back, suit and value. */
function openCardConfig(stackId: string, cardId?: string): void {
  const key = `card-config-${cardId ?? `new-${stackId}`}`;
  const c = cardId ? game.get<CardDoc>("Card", cardId) : undefined;
  const body = openWindow(key, c ? `Carta: ${c.name}` : "Nova carta", { width: 440 });
  if (!body) return;
  const name = h("input", { value: c?.name ?? "" });
  const suit = h("input", { value: c?.suit ?? "", placeholder: "♥ ♦ ♠ ♣ ou outro" });
  const value = h("input.num", { type: "number", value: c?.value ?? "" });
  const description = h("textarea", { rows: 2, value: c?.description ?? "" });
  const faces: CardFace[] = structuredClone(c?.faces?.length ? c.faces : [{ name: "", text: "", img: null }]);
  const back: CardFace = structuredClone(c?.back ?? { name: "", text: "", img: null });
  const facesBox = h("div.stack");
  const faceRow = (f: CardFace, i: number | "back") => {
    const imgIn = h("input", { value: f.img ?? "", placeholder: "Imagem", oninput: (e: Event) => (f.img = (e.target as HTMLInputElement).value.trim() || null) });
    return h("fieldset.card-face", null, h("legend", null, i === "back" ? "Verso" : `Face ${i + 1}`),
      h("div.row", null,
        h("input", { value: f.name, placeholder: "Nome da face", oninput: (e: Event) => (f.name = (e.target as HTMLInputElement).value) }),
        h("input", { value: f.text, placeholder: "Texto (ex.: A♥)", oninput: (e: Event) => (f.text = (e.target as HTMLInputElement).value) })),
      h("div.row", null, imgIn,
        h("button", { type: "button", title: "Carregar imagem", onclick: async () => { const file = await pickFile("image/*"); if (file) { f.img = await upload(file); imgIn.value = f.img; } } }, h("i.fa-solid.fa-upload")),
        i !== "back" && faces.length > 1 ? h("button.icon.small", { type: "button", title: "Tirar esta face", onclick: () => { faces.splice(i, 1); renderFaces(); } }, "✕") : null));
  };
  const renderFaces = () => setChildren(facesBox, faces.map((f, i) => faceRow(f, i)),
    h("button.small", { type: "button", onclick: () => { faces.push({ name: "", text: "", img: null }); renderFaces(); } }, h("i.fa-solid.fa-plus"), " Face"),
    faceRow(back, "back"));
  renderFaces();
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const data = {
        name: name.value.trim() || faces[0]?.name || "Carta", suit: suit.value.trim(), value: value.value === "" ? null : Number(value.value),
        description: description.value, faces, back, face: c ? Math.min(c.face ?? 0, faces.length - 1) : 0
      };
      if (c) await game.update("Card", { _id: c._id, ...data }, stackId);
      else await game.create("Card", { ...data, sort: Date.now() }, stackId);
      closeWindow(key);
    }
  },
    h("div.row", null, h("label.field.grow", null, h("span", null, "Nome"), name), h("label.field", null, h("span", null, "Naipe"), suit), h("label.field", null, h("span", null, "Valor"), value)),
    h("label.field", null, h("span", null, "Descrição"), description),
    facesBox,
    h("div.row.end", null,
      c && h("button.danger", { type: "button", onclick: async () => { await game.delete("Card", c._id, stackId); closeWindow(key); } }, "Apagar"),
      h("button.primary", { type: "submit" }, c ? "Guardar" : "Adicionar"))));
}
