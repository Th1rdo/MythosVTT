import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-setup-"));
process.env.MESA_DATA = tmp;
const express = (await import("express")).default;
const { setupRouter } = await import("./setup.ts");
const { World } = await import("./world.ts");

test("setup: create, edit, back up, restore, delete; admin password guards it", async () => {
  let active: ReturnType<typeof World.open> | null = null;
  const app = express();
  app.use(express.json());
  app.use("/api/setup", setupRouter({
    active: () => active,
    launch: id => { active?.close(); active = World.open(id); },
    close: () => { active?.close(); active = null; }
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/setup`;
  let cookie = "";
  const call = async (route: string, body?: unknown) => {
    const res = await fetch(base + route, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return res.json();
  };
  try {
    assert.equal((await call("")).authed, true, "no password: this computer gets in");
    assert.match((await call("/create", { id: "Mau!" })).error, /Id inválido/);
    assert.equal((await call("/create", { id: "caso-1", title: "Caso 1" })).ok, true);
    await call("/edit", { id: "caso-1", title: "Caso Um" });
    const { name } = await call("/backup", { id: "caso-1" });
    await call("/edit", { id: "caso-1", title: "Estragado" });
    await call("/restore", { id: "caso-1", backup: name });
    const s = await call("");
    assert.equal(s.worlds.find((w: { id: string }) => w.id === "caso-1").title, "Caso Um");
    assert.equal(s.worlds[0].backups.length, 2, "the replaced state is kept as a backup");

    await call("/launch", { id: "caso-1" });
    assert.match((await call("/delete", { id: "caso-1", confirm: "caso-1" })).error, /Fecha o mundo/);
    await call("/close", {});
    assert.match((await call("/delete", { id: "caso-1", confirm: "não" })).error, /confirmar/);
    assert.equal((await call("/delete", { id: "caso-1", confirm: "caso-1" })).ok, true);

    await call("/password", { password: "segredo" });
    cookie = "";
    assert.equal((await call("")).authed, false);
    assert.match((await call("/create", { id: "x" })).error, /administrador/);
    assert.match((await call("/login", { password: "nope" })).error, /errada/);
    await call("/login", { password: "segredo" });
    assert.equal((await call("")).authed, true);
  } finally {
    (active as ReturnType<typeof World.open> | null)?.close();
    server.close();
  }
});
