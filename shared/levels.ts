import type { BaseDoc, LevelDoc, SceneDoc, TokenDoc } from "./protocol.ts";
import type { DocLookup } from "./permissions.ts";

/** A scene's levels, lowest first. */
export function sceneLevels(sceneId: string, docs: DocLookup): LevelDoc[] {
  return (docs.all("Level") as LevelDoc[])
    .filter(l => l._parent === sceneId)
    .sort((a, b) => (a.elevation.bottom ?? -Infinity) - (b.elevation.bottom ?? -Infinity) || a.sort - b.sort);
}

/** The level shown when a scene opens: its initial level, else the lowest. */
export function defaultLevel(scene: SceneDoc, docs: DocLookup): LevelDoc | undefined {
  const levels = sceneLevels(scene._id, docs);
  return levels.find(l => l._id === scene.initialLevel) ?? levels[0];
}

/** Whether a wall/light/tile with this `levels` list appears on `levelId` (empty list = every level). */
export function onLevel(doc: BaseDoc & { levels?: string[] }, levelId: string | null): boolean {
  if (!levelId || !doc.levels?.length) return true;
  return doc.levels.includes(levelId);
}

/** Whether a token stands on `levelId` (tokens without a level count as being on the default level). */
export function tokenOnLevel(token: TokenDoc, levelId: string | null, fallback: string | null): boolean {
  if (!levelId) return true;
  return (token.level ?? fallback) === levelId;
}

/** The level whose elevation band contains `elevation`. */
export function levelForElevation(levels: LevelDoc[], elevation: number): LevelDoc | undefined {
  return levels.find(l => elevation >= (l.elevation.bottom ?? -Infinity) && elevation < (l.elevation.top ?? Infinity));
}
