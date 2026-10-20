import type { CardDoc, CardsAction, CardsDoc, DrawHow, UserDoc } from "../shared/protocol.ts";
import { OWNERSHIP } from "../shared/protocol.ts";
import { ownershipLevel } from "../shared/permissions.ts";
import type { RandomInt } from "../shared/dice.ts";
import type { Change, World } from "./world.ts";

const MAX_MOVE = 200;

/** Cards of a stack in order (top first). */
export function stackCards(world: World, stackId: string): CardDoc[] {
  return world.all<CardDoc>("Card").filter(c => c._parent === stackId).sort((a, b) => a.sort - b.sort || a._id.localeCompare(b._id));
}

/**
 * Card stacks, run on the server. A deck owns its cards: dealing or drawing marks the deck's card drawn
 * and puts a copy (remembering `origin` deck and `source` card) in the hand or pile; giving a copy back
 * to its deck clears the mark. Moving between hands and piles moves the copy.
 */
export function runCardsAction(world: World, user: UserDoc, a: CardsAction, random: RandomInt): Change[] {
  const get = (id: string) => {
    const s = world.get("Cards", id) as CardsDoc | undefined;
    if (!s) throw new Error("Esse baralho/mão/monte não existe");
    return s;
  };
  const level = (s: CardsDoc) => ownershipLevel(s.ownership, user);
  const need = (s: CardsDoc, min: number) => {
    if (level(s) < min) throw new Error("Sem permissão");
  };
  const available = (s: CardsDoc) => stackCards(world, s._id).filter(c => s.type !== "deck" || !c.drawn);
  const pick = (s: CardsDoc, n: number, how: DrawHow = "top"): CardDoc[] => {
    const pool = available(s);
    if (n > pool.length) throw new Error(`"${s.name}" só tem ${pool.length} carta(s)`);
    if (how === "bottom") return pool.slice(pool.length - n).reverse();
    if (how === "random") {
      const left = [...pool];
      return Array.from({ length: n }, () => left.splice(random(left.length) - 1, 1)[0]);
    }
    return pool.slice(0, n);
  };
  const changes: Change[] = [];
  const say = (text: string) => {
    changes.push(...world.createAsSystem("ChatMessage", [{ author: user._id, speaker: { actor: null, alias: user.name }, content: text, timestamp: Date.now() }])
      .map(after => ({ type: "ChatMessage" as const, after })));
  };
  const plural = (n: number) => (n === 1 ? "1 carta" : `${n} cartas`);

  /** Move cards from one stack to another (Foundry's "pass" rules, with Mesa's own ids). */
  const move = (from: CardsDoc, to: CardsDoc, cards: CardDoc[], faceDown?: boolean) => {
    if (from._id === to._id) throw new Error("Escolhe outro destino");
    const creates: Record<string, unknown>[] = [];
    const fromUpdates: ({ _id: string } & Record<string, unknown>)[] = [];
    const fromDeletes: string[] = [];
    const originUpdates = new Map<string, ({ _id: string } & Record<string, unknown>)[]>();
    let sort = stackCards(world, to._id).reduce((m, c) => Math.max(m, c.sort), 0);
    for (const c of cards) {
      const home = from.type === "deck" && !c.origin;
      if (home && c.drawn) throw new Error(`"${c.name}" já saiu do baralho`);
      // Back to the deck it came from: the deck's card becomes available again.
      if (!home && c.origin === to._id && c.source && world.get("Card", c.source)) {
        originUpdates.set(to._id, [...(originUpdates.get(to._id) ?? []), { _id: c.source, drawn: false }]);
        fromDeletes.push(c._id);
        continue;
      }
      const { _id, _parent, ...data } = c;
      void _parent;
      const copy: Record<string, unknown> = { ...structuredClone(data), drawn: false, sort: (sort += 1000) };
      if (home && to.type === "deck") Object.assign(copy, { origin: null, source: null }); // a new home deck
      else Object.assign(copy, { origin: c.origin ?? (home ? from._id : null), source: c.source ?? (home ? _id : null) });
      if (faceDown) copy.face = null;
      else if (copy.face === null && to.type !== "deck") copy.face = 0;
      creates.push(copy);
      if (home && to.type !== "deck") fromUpdates.push({ _id, drawn: true });
      else if (!home) fromDeletes.push(_id);
    }
    if (creates.length) changes.push(...world.applyAsSystem({ op: "create", type: "Card", parent: to._id, data: creates }));
    for (const [deck, updates] of originUpdates) changes.push(...world.applyAsSystem({ op: "update", type: "Card", parent: deck, updates }));
    if (fromUpdates.length) changes.push(...world.applyAsSystem({ op: "update", type: "Card", parent: from._id, updates: fromUpdates }));
    if (fromDeletes.length) changes.push(...world.applyAsSystem({ op: "delete", type: "Card", parent: from._id, ids: fromDeletes }));
  };
  const count = (n: unknown) => Math.min(MAX_MOVE, Math.max(1, Math.round(Number(n) || 1)));

  switch (a.action) {
    case "deal": {
      const from = get(a.from);
      need(from, OWNERSHIP.OWNER);
      const targets = [...new Set(a.to)].map(get);
      if (!targets.length) throw new Error("Escolhe a quem dar");
      for (const t of targets) need(t, OWNERSHIP.LIMITED);
      const n = count(a.number);
      const drawn = pick(from, n * targets.length, a.how);
      targets.forEach((t, i) => move(from, t, drawn.filter((_, k) => k % targets.length === i), a.faceDown));
      say(`${user.name} deu ${plural(n)} de ${from.name} a ${targets.map(t => t.name).join(", ")}.`);
      break;
    }
    case "draw": {
      const to = get(a.to), from = get(a.from);
      need(to, OWNERSHIP.OWNER);
      need(from, from.type === "deck" ? OWNERSHIP.LIMITED : OWNERSHIP.OBSERVER);
      const n = count(a.number);
      move(from, to, pick(from, n, a.how));
      say(`${user.name} tirou ${plural(n)} de ${from.name}.`);
      break;
    }
    case "pass": {
      const from = get(a.from), to = get(a.to);
      need(from, OWNERSHIP.OWNER);
      need(to, OWNERSHIP.LIMITED);
      const ids = new Set(a.cardIds.slice(0, MAX_MOVE));
      const cards = stackCards(world, from._id).filter(c => ids.has(c._id));
      if (!cards.length) throw new Error("Escolhe as cartas");
      move(from, to, cards);
      const shown = cards.filter(c => c.face !== null).map(c => c.name);
      const what = shown.length === cards.length && cards.length <= 3 ? shown.join(", ") : plural(cards.length);
      say(a.kind === "play" ? `${user.name} jogou ${what} para ${to.name}.` : a.kind === "discard" ? `${user.name} descartou ${what} para ${to.name}.` : `${user.name} passou ${what} para ${to.name}.`);
      break;
    }
    case "shuffle": {
      const s = get(a.stack);
      need(s, OWNERSHIP.OWNER);
      const cards = stackCards(world, s._id);
      const keys = new Map(cards.map(c => [c._id, random(1_000_000_000)]));
      const order = [...cards].sort((x, y) => keys.get(x._id)! - keys.get(y._id)!);
      if (order.length) changes.push(...world.applyAsSystem({ op: "update", type: "Card", parent: s._id, updates: order.map((c, i) => ({ _id: c._id, sort: (i + 1) * 1000 })) }));
      say(`${user.name} baralhou ${s.name}.`);
      break;
    }
    case "recall": {
      const s = get(a.stack);
      need(s, OWNERSHIP.OWNER);
      if (s.type === "deck") {
        // Every copy that came from this deck comes home.
        const copies = world.all<CardDoc>("Card").filter(c => c.origin === s._id);
        const byStack = new Map<string, string[]>();
        for (const c of copies) byStack.set(c._parent!, [...(byStack.get(c._parent!) ?? []), c._id]);
        for (const [stack, ids] of byStack) changes.push(...world.applyAsSystem({ op: "delete", type: "Card", parent: stack, ids }));
        const drawn = stackCards(world, s._id).filter(c => c.drawn);
        if (drawn.length) changes.push(...world.applyAsSystem({ op: "update", type: "Card", parent: s._id, updates: drawn.map(c => ({ _id: c._id, drawn: false })) }));
      } else {
        // A hand or pile gives each card back to its deck.
        const cards = stackCards(world, s._id);
        const byDeck = new Map<string, string[]>();
        for (const c of cards) if (c.origin && c.source && world.get("Card", c.source)) byDeck.set(c.origin, [...(byDeck.get(c.origin) ?? []), c.source]);
        for (const [deck, ids] of byDeck) changes.push(...world.applyAsSystem({ op: "update", type: "Card", parent: deck, updates: ids.map(id => ({ _id: id, drawn: false })) }));
        if (cards.length) changes.push(...world.applyAsSystem({ op: "delete", type: "Card", parent: s._id, ids: cards.map(c => c._id) }));
      }
      say(`${user.name} recolheu as cartas de ${s.name}.`);
      break;
    }
    case "flip": {
      const s = get(a.stack);
      need(s, OWNERSHIP.OWNER);
      const card = world.get("Card", a.cardId) as CardDoc | undefined;
      if (!card || card._parent !== s._id) throw new Error("Carta não existe");
      changes.push(...world.applyAsSystem({ op: "update", type: "Card", parent: s._id, updates: [{ _id: card._id, face: a.face }] }));
      break;
    }
    default:
      throw new Error("Ação desconhecida");
  }
  return changes;
}

