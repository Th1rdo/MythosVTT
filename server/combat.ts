import crypto from "node:crypto";
import type { ActiveEffectDoc, ActorDoc, CombatAction, CombatDoc, CombatantDoc, EffectData, TokenDoc, UserDoc } from "../shared/protocol.ts";
import { actorState, isExpired, tokenActor } from "../shared/actors.ts";
import { ownsActor } from "../shared/permissions.ts";
import { roll } from "../shared/dice.ts";
import { initiativeFormula } from "../shared/ordem.ts";
import {
  nextRoundState, nextTurnState, previousRoundState, previousTurnState, startState, turnOrder
} from "../shared/combat.ts";
import type { TurnState } from "../shared/combat.ts";
import type { Change, World } from "./world.ts";

const secureRandomInt = (faces: number) => crypto.randomInt(1, faces + 1);

/**
 * Combat actions run on the server so turn order and initiative can't be forged.
 * GMs may do everything. Players may roll initiative for their own combatants, end the turn when
 * it's one of theirs, and add/remove their own tokens.
 */
export function runCombatAction(world: World, user: UserDoc, a: CombatAction): Change[] {
  const gm = user.role === "gm";
  const deny = () => {
    throw new Error("Sem permissão");
  };

  if (a.action === "toggleTokens") return toggleTokens(world, user, a.sceneId, a.tokenIds);

  const combat = world.get("Combat", a.combatId) as CombatDoc | undefined;
  if (!combat) throw new Error("Combate não existe");
  const combatants = world.all<CombatantDoc>("Combatant").filter(c => c._parent === combat._id);
  const setTurn = (s: TurnState) => [
    ...world.applyAsSystem({ op: "update", type: "Combat", updates: [{ _id: combat._id, ...s }] }),
    ...(s.round !== combat.round ? expireEffects(world, combat._id, s.round) : [])
  ];
  const owns = (c: CombatantDoc | undefined) => !!c && ownsActor(c.actorId, user, world);

  switch (a.action) {
    case "start":
      if (!gm) deny();
      if (!combatants.length) throw new Error("Não há combatentes");
      return setTurn(startState(combat, combatants));
    case "end":
      if (!gm) deny();
      return world.applyAsSystem({ op: "delete", type: "Combat", ids: [combat._id] });
    case "nextTurn": {
      const current = combatants.find(c => c._id === combat.current);
      if (!gm && (combat.round === 0 || !owns(current))) deny();
      return setTurn(nextTurnState(combat, combatants));
    }
    case "previousTurn":
      if (!gm) deny();
      return setTurn(previousTurnState(combat, combatants));
    case "nextRound":
      if (!gm) deny();
      return setTurn(nextRoundState(combat, combatants));
    case "previousRound":
      if (!gm) deny();
      return setTurn(previousRoundState(combat, combatants));
    case "resetInitiative":
      if (!gm) deny();
      return [
        ...world.applyAsSystem({ op: "update", type: "Combatant", parent: combat._id, updates: combatants.map(c => ({ _id: c._id, initiative: null })) }),
        ...setTurn({ round: 0, current: null })
      ];
    case "rollInitiative": {
      const targets = combatants.filter(c => a.combatantIds.includes(c._id));
      if (!gm && !targets.every(owns)) deny();
      return rollInitiative(world, user, combat, targets);
    }
    case "rollAll":
    case "rollNPCs": {
      if (!gm) deny();
      const targets = combatants.filter(c => c.initiative === null && (a.action === "rollAll" || isNPC(world, c)));
      return rollInitiative(world, user, combat, targets);
    }
  }
}

/** Remove effects whose duration (in rounds of this combat) has run out. */
function expireEffects(world: World, combatId: string, round: number): Change[] {
  const changes: Change[] = [];
  const expired = world.all<ActiveEffectDoc>("ActiveEffect").filter(e => isExpired(e as unknown as EffectData, combatId, round));
  const byActor = new Map<string, string[]>();
  for (const e of expired) byActor.set(e._parent!, [...(byActor.get(e._parent!) ?? []), e._id]);
  for (const [actorId, ids] of byActor) changes.push(...world.applyAsSystem({ op: "delete", type: "ActiveEffect", parent: actorId, ids }));
  for (const t of world.all<TokenDoc>("Token")) {
    const effects = t.delta?.effects;
    if (!effects?.some(e => isExpired(e, combatId, round))) continue;
    changes.push(...world.applyAsSystem({
      op: "update", type: "Token", parent: t._parent, updates: [{ _id: t._id, delta: { ...t.delta, effects: effects.filter(e => !isExpired(e, combatId, round)) } }]
    }));
  }
  return changes;
}

/** NPC = no player owns its actor. */
function isNPC(world: World, c: CombatantDoc): boolean {
  const actor = world.get("Actor", c.actorId ?? "") as ActorDoc | undefined;
  if (!actor) return true;
  return !world.all<UserDoc>("User").some(u => u.role !== "gm" && (actor.ownership[u._id] ?? actor.ownership.default) >= 3);
}

function rollInitiative(world: World, user: UserDoc, combat: CombatDoc, targets: CombatantDoc[]): Change[] {
  if (!targets.length) return [];
  const changes: Change[] = [];
  const updates: { _id: string; initiative: number }[] = [];
  const gms = world.all<UserDoc>("User").filter(u => u.role === "gm").map(u => u._id);
  for (const c of targets) {
    // Roll from the actor the token represents (unlinked copies, effects applied).
    const token = c.tokenId ? (world.get("Token", c.tokenId) as TokenDoc | undefined) : undefined;
    const base = world.get("Actor", c.actorId ?? "") as ActorDoc | undefined;
    const actor = token ? tokenActor(token, world)?.derived : base ? actorState(base, world).derived : undefined;
    const result = roll(initiativeFormula(actor), secureRandomInt);
    updates.push({ _id: c._id, initiative: result.total });
    const [msg] = world.createAsSystem("ChatMessage", [{
      author: user._id,
      speaker: { actor: c.actorId, alias: c.name },
      content: "",
      flavor: "Iniciativa",
      roll: result,
      // Hidden combatants roll privately.
      whisper: c.hidden ? gms : null,
      timestamp: Date.now()
    }]);
    changes.push({ type: "ChatMessage", after: msg });
  }
  changes.push(...world.applyAsSystem({ op: "update", type: "Combatant", parent: combat._id, updates }));
  // A combat that's already running keeps whoever's turn it was; a new one points at the top of the order.
  if (combat.round > 0 && !combat.current) {
    const all = world.all<CombatantDoc>("Combatant").filter(x => x._parent === combat._id);
    changes.push(...world.applyAsSystem({ op: "update", type: "Combat", updates: [{ _id: combat._id, current: turnOrder(all)[0]?._id ?? null }] }));
  }
  return changes;
}

/** Add tokens to the scene's encounter (creating one if needed), or remove them if they're already in it. */
function toggleTokens(world: World, user: UserDoc, sceneId: string, tokenIds: string[]): Change[] {
  const tokens = tokenIds
    .map(id => world.get("Token", id) as TokenDoc | undefined)
    .filter((t): t is TokenDoc => !!t && t._parent === sceneId);
  if (!tokens.length) return [];
  if (user.role !== "gm" && !tokens.every(t => ownsActor(t.actorId, user, world))) throw new Error("Sem permissão");

  const changes: Change[] = [];
  let combat = world.all<CombatDoc>("Combat").filter(c => c.sceneId === sceneId).sort((a, b) => a.sort - b.sort)[0];
  if (!combat) {
    if (user.role !== "gm") throw new Error("O mestre ainda não criou um combate nesta cena");
    const [created] = world.applyAsSystem({ op: "create", type: "Combat", data: [{ sceneId }] });
    changes.push(created);
    combat = created.after as CombatDoc;
  }
  const existing = world.all<CombatantDoc>("Combatant").filter(c => c._parent === combat._id);
  const toRemove = existing.filter(c => tokens.some(t => t._id === c.tokenId)).map(c => c._id);
  const toAdd = tokens.filter(t => !existing.some(c => c.tokenId === t._id)).map(t => {
    const actor = world.get("Actor", t.actorId ?? "") as ActorDoc | undefined;
    return { tokenId: t._id, actorId: t.actorId, name: t.name || actor?.name || "?", img: t.img ?? actor?.img ?? null, hidden: t.hidden };
  });
  if (toRemove.length) changes.push(...world.applyAsSystem({ op: "delete", type: "Combatant", parent: combat._id, ids: toRemove }));
  if (toAdd.length) changes.push(...world.applyAsSystem({ op: "create", type: "Combatant", parent: combat._id, data: toAdd }));
  return changes;
}
