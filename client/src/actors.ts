import type { ActiveEffectDoc, ActorDoc, EffectData, TokenDoc } from "../../shared/protocol.ts";
import { actorState, tokenActor } from "../../shared/actors.ts";
import type { TokenActor } from "../../shared/actors.ts";
import { CONDITION_BY_ID, DEAD } from "../../shared/conditions.ts";
import { randomId } from "../../shared/objects.ts";
import { game } from "./game.ts";
import { combatAction, combatantsOf, sceneCombats } from "./ui/combat.ts";

/**
 * Which actor a sheet/HUD is editing: an actor, or an unlinked token's synthetic actor.
 * Edits to a synthetic actor go into the token's `delta` instead of the base actor.
 */
export interface ActorRef {
  actorId: string;
  token?: { tokenId: string; sceneId: string };
}

export function refForToken(t: TokenDoc): ActorRef | null {
  if (!t.actorId) return null;
  return t.actorLink ? { actorId: t.actorId } : { actorId: t.actorId, token: { tokenId: t._id, sceneId: t._parent! } };
}

export function tokenOf(ref: ActorRef): TokenDoc | undefined {
  return ref.token ? game.get<TokenDoc>("Token", ref.token.tokenId) : undefined;
}

export function stateOf(ref: ActorRef): TokenActor | null {
  const token = tokenOf(ref);
  if (token) return tokenActor(token, game);
  const actor = game.get<ActorDoc>("Actor", ref.actorId);
  return actor ? actorState(actor, game) : null;
}

/** Apply dot-path changes ("system.PV.value", "name", "img") to the right document. */
export function updateActor(ref: ActorRef, changes: Record<string, unknown>): Promise<unknown> {
  const token = tokenOf(ref);
  if (token) {
    const delta: Record<string, unknown> = { _id: token._id };
    for (const [k, v] of Object.entries(changes)) delta[`delta.${k}`] = v;
    return game.update("Token", delta as { _id: string }, ref.token!.sceneId);
  }
  return game.update("Actor", { _id: ref.actorId, ...changes });
}

// ---------------------------------------------------------------------------
// Effects

/** Effects that can be edited from this ref (actor documents, or the token's own delta effects). */
export function ownEffects(ref: ActorRef): EffectData[] {
  const token = tokenOf(ref);
  if (token) return token.delta?.effects ?? [];
  return game.children<ActiveEffectDoc>("ActiveEffect", ref.actorId) as unknown as EffectData[];
}

export async function saveEffect(ref: ActorRef, effect: Omit<EffectData, "_id"> & { _id?: string }): Promise<void> {
  const token = tokenOf(ref);
  if (token) {
    const list = [...(token.delta?.effects ?? [])];
    const id = effect._id ?? randomId();
    const i = list.findIndex(e => e._id === id);
    const full = { ...effect, _id: id } as EffectData;
    if (i >= 0) list[i] = full;
    else list.push(full);
    await game.update("Token", { _id: token._id, delta: { ...token.delta, effects: list } }, ref.token!.sceneId);
    return;
  }
  const { _id, ...data } = effect;
  if (_id && game.get("ActiveEffect", _id)) await game.update("ActiveEffect", { _id, ...data }, ref.actorId);
  else await game.create("ActiveEffect", data, ref.actorId);
}

export async function deleteEffect(ref: ActorRef, id: string): Promise<void> {
  const token = tokenOf(ref);
  if (token) {
    const list = (token.delta?.effects ?? []).filter(e => e._id !== id);
    await game.update("Token", { _id: token._id, delta: { ...token.delta, effects: list } }, ref.token!.sceneId);
    return;
  }
  await game.delete("ActiveEffect", id, ref.actorId);
}

/** Current combat round info, so new effects can start counting their duration. */
function combatStart(): { combat: string | null; startRound: number | null } {
  const combat = sceneCombats().find(c => c.round > 0);
  return combat ? { combat: combat._id, startRound: combat.round } : { combat: null, startRound: null };
}

export function newEffect(partial: Partial<EffectData> = {}): Omit<EffectData, "_id"> {
  return {
    name: "Efeito", icon: "✨", disabled: false, statuses: [], changes: [], description: "",
    ...partial,
    duration: { rounds: null, ...combatStart(), ...(partial.duration ?? {}) }
  };
}

/** Turn a condition on or off. Marking someone dead also marks their combatant defeated. */
export async function toggleCondition(ref: ActorRef, conditionId: string, active?: boolean): Promise<void> {
  const existing = ownEffects(ref).find(e => e.statuses?.includes(conditionId));
  const on = active ?? !existing;
  if (on && !existing) {
    const c = CONDITION_BY_ID.get(conditionId);
    await saveEffect(ref, newEffect({ name: c?.name ?? conditionId, icon: c?.icon ?? "✨", statuses: [conditionId] }));
  } else if (!on && existing) {
    await deleteEffect(ref, existing._id);
  }
  if (conditionId === DEAD) {
    const tokenId = ref.token?.tokenId;
    for (const combat of sceneCombats()) {
      for (const c of combatantsOf(combat._id)) {
        if ((tokenId && c.tokenId === tokenId) || (!tokenId && c.actorId === ref.actorId)) {
          await game.update("Combatant", { _id: c._id, defeated: on }, combat._id).catch(() => {});
        }
      }
    }
  }
}

export { combatAction };
