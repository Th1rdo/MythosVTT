import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-packages-"));
process.env.MESA_DATA = tmp;
process.env.MESA_BUNDLED = path.join(tmp, "bundled");
const { BUNDLED_DIR, MODULES_DIR, activePackages, installedPackages, missingRequirements, packageDir } = await import("./packages.ts");
const { World } = await import("./world.ts");

function writePackage(id: string, manifest: Record<string, unknown>, files: string[] = [], root = MODULES_DIR): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ id, title: id, version: "1.0.0", ...manifest }));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "");
  }
}

test("packages: manifests, Mesa compatibility, dependency order, settings and flags", () => {
  writePackage("base", { mesa: { esmodules: ["main.js"] } }, ["main.js"]);
  writePackage("extra", { mesa: { esmodules: ["extra.js"], styles: ["s.css"] }, socket: true, relationships: { requires: [{ id: "base" }] } }, ["extra.js", "s.css"]);
  writePackage("foundry-only", { esmodules: ["scripts/main.js"] }, ["scripts/main.js"]);
  writePackage("broken", { mesa: { esmodules: ["missing.js", "../escape.js"] } });
  fs.mkdirSync(path.join(MODULES_DIR, "Not An Id"), { recursive: true });
  // Bundled with Mesa; the Foundry-safe flags.mesa block works the same; a data/modules copy wins.
  writePackage("bundled", { version: "1.0.0", flags: { mesa: { esmodules: ["b.js"] } } }, ["b.js"], BUNDLED_DIR);
  writePackage("base", { version: "0.1.0", mesa: {} }, [], BUNDLED_DIR);

  const all = installedPackages(true);
  assert.deepEqual([...all.keys()].sort(), ["base", "broken", "bundled", "extra", "foundry-only"]);
  assert.equal(all.get("bundled")!.compatible, true);
  assert.deepEqual(all.get("bundled")!.esmodules, ["b.js"]);
  assert.equal(packageDir("bundled"), path.join(BUNDLED_DIR, "bundled"));
  assert.equal(all.get("base")!.version, "1.0.0");
  assert.equal(packageDir("base"), path.join(MODULES_DIR, "base"));
  assert.equal(all.get("base")!.compatible, true);
  assert.equal(all.get("foundry-only")!.compatible, false);
  assert.match(all.get("foundry-only")!.problems[0], /Foundry/);
  // Paths that escape the package are dropped; missing files make it incompatible.
  assert.deepEqual(all.get("broken")!.esmodules, ["missing.js"]);
  assert.equal(all.get("broken")!.compatible, false);
  assert.deepEqual(all.get("extra")!.styles, ["s.css"]);

  const world = World.create({ id: "pkg-test", title: "T", system: "ordemparanormal" });
  try {
    assert.deepEqual(activePackages(world), []);
    // A package whose dependency is off doesn't run.
    world.setWorldSetting("core.modules", { extra: true, "foundry-only": true });
    assert.deepEqual(activePackages(world).map(p => p.id), []);
    assert.deepEqual(missingRequirements(world, "extra"), ["base"]);
    // Dependencies load first, whatever the order they were switched on.
    world.setWorldSetting("core.modules", { extra: true, base: true, "foundry-only": true });
    assert.deepEqual(activePackages(world).map(p => p.id), ["base", "extra"]);

    // Package settings: accepted for installed packages, refused for unknown ones and core typos.
    world.setWorldSetting("extra.data", { anything: [1, 2, 3] });
    assert.throws(() => world.setWorldSetting("nope.data", 1), /desconhecida/);
    assert.throws(() => world.setWorldSetting("core.nothing", 1), /desconhecida/);
    assert.throws(() => world.setWorldSetting("extra.big", "x".repeat(200_000)), /grande/);

    // User settings of packages live on the User like core ones.
    const [{ after: gm }] = world.applyAsSystem({ op: "create", type: "User", data: [{ name: "Mestre", role: "gm" }] });
    world.applyAsSystem({ op: "update", type: "User", updates: [{ _id: gm!._id, "settings.extra:colour": "#ff0000" }] });
    assert.throws(() => world.applyAsSystem({ op: "update", type: "User", updates: [{ _id: gm!._id, "settings.nope:x": 1 }] }), /desconhecida/);

    // Flags: any package data on any document, as an object.
    const [actor] = world.applyAsSystem({ op: "create", type: "Actor", data: [{ name: "A", flags: { extra: { marks: 2 } } }] });
    assert.deepEqual((actor.after as { flags?: unknown }).flags, { extra: { marks: 2 } });
    assert.throws(() => world.applyAsSystem({ op: "create", type: "Actor", data: [{ name: "B", flags: "x" }] }), /flags/);
  } finally {
    world.close();
  }
});
