import { test } from "node:test";
import assert from "node:assert/strict";
import { HookRegistry } from "./hooks.ts";

test("hooks: on/once/off, call stops on false, callAll runs all", () => {
  const hooks = new HookRegistry();
  const seen: string[] = [];
  const a = hooks.on("x", (v: string) => seen.push(`a${v}`));
  hooks.once("x", (v: string) => seen.push(`once${v}`));
  hooks.callAll("x", 1);
  hooks.callAll("x", 2);
  assert.deepEqual(seen, ["a1", "once1", "a2"]);

  hooks.off(a);
  hooks.callAll("x", 3);
  assert.equal(seen.length, 3);
  assert.deepEqual(hooks.events, {});

  const order: number[] = [];
  hooks.on("pre", () => { order.push(1); });
  hooks.on("pre", () => { order.push(2); return false; });
  hooks.on("pre", () => { order.push(3); });
  assert.equal(hooks.call("pre"), false);
  assert.deepEqual(order, [1, 2]);
  hooks.callAll("pre");
  assert.deepEqual(order, [1, 2, 1, 2, 3]);
  assert.equal(hooks.call("nobody"), true);

  const fn = () => {};
  hooks.on("y", fn);
  hooks.off("y", fn);
  assert.deepEqual(hooks.events, { pre: 3 });
});

test("hooks: a throwing listener is reported and skipped", () => {
  const hooks = new HookRegistry();
  const errors: string[] = [];
  hooks.onError = hook => errors.push(hook);
  hooks.on("error", (hook: string) => errors.push(`error:${hook}`));
  let after = false;
  hooks.on("z", () => { throw new Error("boom"); });
  hooks.on("z", () => { after = true; });
  assert.equal(hooks.call("z"), true);
  assert.equal(after, true);
  assert.deepEqual(errors, ["z", "error:z"]);
});
