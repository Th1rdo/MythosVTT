import type { ActiveEffectDoc, ActorDoc, EffectChange, EffectData, TokenDoc } from "./protocol.ts";
import type { DocLookup } from "./permissions.ts";
import { isPlainObject, mergeDeep } from "./objects.ts";

/** Changes are applied in this order (same order of operations as Foundry). */
const ORDER: Record<EffectChange["type"], number> = { multiply: 10, add: 20, downgrade: 30, upgrade: 40, override: 50 };

function getPath(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj: any, path: string, value: unknown): void {
  const parts = path.split(".");
  let o = obj;
  for (const k of parts.slice(0, -1)) {
    if (!isPlainObject(o[k])) o[k] = {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = value;
}

function applyChange(current: unknown, change: EffectChange): unknown {
  const n = Number(change.value);
  const numeric = typeof current === "number" || (current === undefined && Number.isFinite(n));
  if (change.type === "override") return numeric && Number.isFinite(n) ? n : change.value;
  if (!numeric) return change.type === "add" ? `${current ?? ""}${change.value}` : current;
  const base = Number(current) || 0;
  if (!Number.isFinite(n)) return current;
  switch (change.type) {
    case "add": return base + n;
    case "multiply": return base * n;
    case "upgrade": return Math.max(base, n);
    case "downgrade": return Math.min(base, n);
  }
}

/** Actor data with all enabled effects applied (source data is not modified). */
export function applyEffects(actor: ActorDoc, effects: EffectData[]): ActorDoc {
  const changes = effects.filter(e => !e.disabled).flatMap(e => e.changes ?? []).filter(c => c?.key);
  if (!changes.length) return actor;
  const derived = structuredClone(actor);
  for (const c of [...changes].sort((a, b) => ORDER[a.type] - ORDER[b.type])) {
    setPath(derived, c.key, applyChange(getPath(derived, c.key), c));
  }
  return derived;
}

export function actorEffects(actorId: string, docs: DocLookup): EffectData[] {
  return (docs.all("ActiveEffect") as ActiveEffectDoc[]).filter(e => e._parent === actorId) as unknown as EffectData[];
}

export interface TokenActor {
  /** Source data (base actor, plus the token's delta when unlinked). */
  source: ActorDoc;
  /** Source with effects applied: use for display and rolls. */
  derived: ActorDoc;
  effects: EffectData[];
  /** Condition ids from enabled effects. */
  statuses: Set<string>;
}

/**
 * The actor a token represents. Linked tokens are their actor; unlinked tokens are the base actor
 * overlaid with the token's `delta` (name, image, system data, extra effects), like Foundry's synthetic actors.
 */
export function tokenActor(token: TokenDoc, docs: DocLookup): TokenActor | null {
  const base = token.actorId ? (docs.get("Actor", token.actorId) as ActorDoc | undefined) : undefined;
  if (!base) return null;
  const baseEffects = actorEffects(base._id, docs);
  let source = base;
  let effects = baseEffects;
  if (!token.actorLink) {
    const d = token.delta ?? {};
    source = mergeDeep(base, { ...(d.system ? { system: d.system } : {}), ...(d.name ? { name: d.name } : {}), ...(d.img ? { img: d.img } : {}) });
    effects = baseEffects.concat(d.effects ?? []);
  }
  return withEffects(source, effects);
}

export function actorState(actor: ActorDoc, docs: DocLookup): TokenActor {
  return withEffects(actor, actorEffects(actor._id, docs));
}

function withEffects(source: ActorDoc, effects: EffectData[]): TokenActor {
  const statuses = new Set(effects.filter(e => !e.disabled).flatMap(e => e.statuses ?? []));
  return { source, derived: applyEffects(source, effects), effects, statuses };
}

/** Read a resource bar ({value, max}) from actor system data, e.g. attribute "PV". */
export function barValue(actor: ActorDoc, attribute: string | null): { value: number; max: number } | null {
  if (!attribute) return null;
  const v = getPath(actor.system, attribute) as any;
  if (isPlainObject(v) && typeof v.value === "number") return { value: v.value, max: typeof v.max === "number" ? v.max : v.value };
  if (typeof v === "number") return { value: v, max: v };
  return null;
}

/** Effects whose duration ran out in `combatId` by `round`. */
export function isExpired(e: EffectData, combatId: string, round: number): boolean {
  const d = e.duration;
  return !!d?.rounds && d.combat === combatId && d.startRound !== null && round >= d.startRound + d.rounds;
}
