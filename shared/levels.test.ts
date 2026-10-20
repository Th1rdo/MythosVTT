import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultLevel, levelForElevation, onLevel, sceneLevels, tokenOnLevel } from "./levels.ts";
import type { BaseDoc, DocType, LevelDoc, SceneDoc, TokenDoc } from "./protocol.ts";

const level = (id: string, bottom: number | null, top: number | null): LevelDoc =>
  ({ _id: id, _parent: "s", name: id, elevation: { bottom, top }, background: { src: null, color: "#000" }, foreground: { src: null }, sort: 0 });
const docs = (levels: LevelDoc[]) => ({
  get: (t: DocType, id: string) => (t === "Level" ? levels.find(l => l._id === id) : undefined) as BaseDoc | undefined,
  all: (t: DocType) => (t === "Level" ? levels : []) as BaseDoc[]
});

test("levels sort bottom-up; the initial level wins, else the lowest", () => {
  const ls = [level("up", 10, 20), level("rc", 0, 10)];
  assert.deepEqual(sceneLevels("s", docs(ls)).map(l => l._id), ["rc", "up"]);
  assert.equal(defaultLevel({ _id: "s", initialLevel: null } as SceneDoc, docs(ls))?._id, "rc");
  assert.equal(defaultLevel({ _id: "s", initialLevel: "up" } as SceneDoc, docs(ls))?._id, "up");
  assert.equal(levelForElevation(ls, 12)?._id, "up");
  assert.equal(levelForElevation(ls, 10)?._id, "up", "bands are [bottom, top)");
});

test("placeables with no levels appear everywhere; tokens without a level use the default", () => {
  assert.equal(onLevel({ _id: "w", levels: [] }, "up"), true);
  assert.equal(onLevel({ _id: "w", levels: ["rc"] }, "up"), false);
  assert.equal(tokenOnLevel({ level: null } as TokenDoc, "rc", "rc"), true);
  assert.equal(tokenOnLevel({ level: null } as TokenDoc, "up", "rc"), false);
  assert.equal(tokenOnLevel({ level: "up" } as TokenDoc, "up", "rc"), true);
});
