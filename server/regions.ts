import type { ActorDoc, LevelPromptEvent, RegionBehavior, RegionDoc, RegionEvent, SceneDoc, ScrollingTextEvent, TokenDoc, UserDoc } from "../shared/protocol.ts";
import { randomId } from "../shared/objects.ts";
import { randomPointIn, tokenInRegion } from "../shared/regions.ts";
import { defaultLevel } from "../shared/levels.ts";
import type { Change, World } from "./world.ts";

/** A message to send to some users (null = everyone). */
export interface Emit {
  to: string[] | null;
  event: "scrollingText" | "levelPrompt" | "pull";
  data: ScrollingTextEvent | LevelPromptEvent | string;
}

/**
 * Region behaviours, run on the server after token changes. For every token that moved, changed level
 * or appeared, work out which regions it entered or left and apply their behaviours. Follow-up changes
 * (teleports etc.) don't trigger further region events, so regions can't loop into each other.
 */
export function processRegionEvents(world: World, changes: Change[], actingUserId: string): { changes: Change[]; emits: Emit[] } {
  const out: Change[] = [];
  const emits: Emit[] = [];
  for (const c of changes) {
    if (c.type !== "Token" || !c.after) continue;
    const before = c.before as TokenDoc | undefined;
    const after = c.after as TokenDoc;
    if (before && before.x === after.x && before.y === after.y && before.level === after.level && before.elevation === after.elevation) continue;
    const scene = world.get("Scene", after._parent!) as SceneDoc | undefined;
    if (!scene) continue;
    const fallback = defaultLevel(scene, world)?._id ?? null;
    const regions = world.all<RegionDoc>("Region").filter(r => r._parent === scene._id && r.behaviors?.some(b => !b.disabled));
    for (const region of regions) {
      const was = !!before && tokenInRegion(region, before, scene.grid.size, before.level ?? fallback);
      const is = tokenInRegion(region, after, scene.grid.size, after.level ?? fallback);
      if (was === is) continue;
      const event: RegionEvent = is ? "tokenEnter" : "tokenExit";
      for (const b of region.behaviors) {
        if (b.disabled) continue;
        run(world, b, event, region, scene, after, actingUserId, out, emits);
      }
    }
  }
  return { changes: out, emits };
}

function owners(world: World, token: TokenDoc): string[] {
  const actor = world.get("Actor", token.actorId ?? "") as ActorDoc | undefined;
  return world.all<UserDoc>("User")
    .filter(u => u.role === "gm" || (actor && (actor.ownership[u._id] ?? actor.ownership.default) >= 3))
    .map(u => u._id);
}

function run(
  world: World, b: RegionBehavior, event: RegionEvent, region: RegionDoc, scene: SceneDoc, token: TokenDoc,
  actingUserId: string, out: Change[], emits: Emit[]
): void {
  const half = (scene.grid.size * token.width) / 2;
  switch (b.type) {
    case "teleportToken": {
      if (event !== "tokenEnter") return;
      const targets = b.system.destinations.map(id => world.get("Region", id) as RegionDoc | undefined).filter((r): r is RegionDoc => !!r && r._id !== region._id);
      const dest = targets[Math.floor(Math.random() * targets.length)];
      if (!dest) return;
      const destScene = world.get("Scene", dest._parent!) as SceneDoc | undefined;
      const point = destScene && randomPointIn(dest, destScene.grid.size);
      if (!destScene || !point) return;
      const x = point.x - (destScene.grid.size * token.width) / 2;
      const y = point.y - (destScene.grid.size * token.height) / 2;
      const level = dest.levels[0] ?? null;
      if (destScene._id === scene._id) {
        out.push(...world.applyAsSystem({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, x, y, ...(level ? { level } : {}) }] }));
      } else {
        // Another scene: recreate the token there and send its owners along.
        const { _id, _parent, ...data } = world.get("Token", token._id) as TokenDoc;
        out.push(...world.applyAsSystem({ op: "create", type: "Token", parent: destScene._id, data: [{ ...data, x, y, level }] }));
        out.push(...world.applyAsSystem({ op: "delete", type: "Token", parent: scene._id, ids: [_id] }));
        void _parent;
        emits.push({ to: owners(world, token).filter(id => (world.get("User", id) as UserDoc).role !== "gm"), event: "pull", data: destScene._id });
      }
      return;
    }
    case "changeLevel": {
      if (event !== "tokenEnter" || region.levels.length < 2) return;
      const current = token.level ?? defaultLevel(scene, world)?._id ?? null;
      const levels = region.levels.filter(id => id !== current && world.get("Level", id));
      if (levels.length) emits.push({ to: [actingUserId], event: "levelPrompt", data: { sceneId: scene._id, tokenId: token._id, regionName: region.name, levels } });
      return;
    }
    case "applyActiveEffect": {
      const origin = `region:${region._id}`;
      const actor = world.get("Actor", token.actorId ?? "") as ActorDoc | undefined;
      if (!actor) return;
      if (token.actorLink) {
        if (event === "tokenEnter") {
          out.push(...world.applyAsSystem({ op: "create", type: "ActiveEffect", parent: actor._id, data: [{ ...b.system.effect, origin }] }));
        } else {
          const ids = world.all("ActiveEffect").filter(e => e._parent === actor._id && (e as { origin?: string }).origin === origin).map(e => e._id);
          if (ids.length) out.push(...world.applyAsSystem({ op: "delete", type: "ActiveEffect", parent: actor._id, ids }));
        }
      } else {
        const current = world.get("Token", token._id) as TokenDoc;
        const effects = (current.delta?.effects ?? []).filter(e => e.origin !== origin);
        if (event === "tokenEnter") effects.push({ ...b.system.effect, _id: randomId(), origin });
        out.push(...world.applyAsSystem({ op: "update", type: "Token", parent: scene._id, updates: [{ _id: token._id, delta: { ...current.delta, effects } }] }));
      }
      return;
    }
    case "displayScrollingText": {
      if (!b.system.events.includes(event)) return;
      const gms = world.all<UserDoc>("User").filter(u => u.role === "gm").map(u => u._id);
      const to = b.system.visibility === "all" ? null : b.system.visibility === "gm" ? gms : owners(world, token);
      emits.push({ to, event: "scrollingText", data: { sceneId: scene._id, x: token.x + half, y: token.y, text: b.system.text, color: b.system.color } });
      return;
    }
    case "toggleBehavior": {
      if (!b.system.events.includes(event)) return;
      const enable = new Set(b.system.enable), disable = new Set(b.system.disable);
      for (const r of world.all<RegionDoc>("Region").filter(x => x._parent === scene._id)) {
        const live = world.get("Region", r._id) as RegionDoc;
        if (!live.behaviors.some(x => enable.has(x._id) || disable.has(x._id))) continue;
        const behaviors = live.behaviors.map(x => (enable.has(x._id) ? { ...x, disabled: false } : disable.has(x._id) ? { ...x, disabled: true } : x));
        out.push(...world.applyAsSystem({ op: "update", type: "Region", parent: scene._id, updates: [{ _id: r._id, behaviors }] }));
      }
      return;
    }
    case "adjustDarkness":
      return; // Drawn by clients.
  }
}
