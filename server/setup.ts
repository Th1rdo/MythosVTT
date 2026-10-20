import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { DATA_DIR, ROOT, WORLDS_DIR, worldDir } from "./paths.ts";
import { World, listWorlds } from "./world.ts";
import type { WorldMeta } from "./world.ts";
import { hashPassword, parseCookies, verifyPassword } from "./auth.ts";

/**
 * The setup screen's API (Foundry's /setup): list, create, edit, delete, launch and back up worlds, and
 * import worlds from Foundry. Guarded by an admin password kept in data/config.json; with no password
 * set, only requests from this computer get in.
 */
export interface WorldControl {
  active(): World | null;
  launch(id: string): void;
  close(): void;
}

const CONFIG = path.join(DATA_DIR, "config.json");
const BACKUPS = path.join(DATA_DIR, "backups");
const COOKIE = "mesa_admin";
const adminTokens = new Set<string>();

interface Config {
  adminHash?: string | null;
}

function readConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(c: Config): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 });
}

/** Set the admin password from the environment on start (MESA_ADMIN_PASSWORD), e.g. for hosting. */
export function applyAdminPasswordFromEnv(): void {
  const pw = process.env.MESA_ADMIN_PASSWORD;
  if (pw) writeConfig({ ...readConfig(), adminHash: hashPassword(pw) });
}

const isLocal = (req: express.Request) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

function isAdmin(req: express.Request): boolean {
  const { adminHash } = readConfig();
  if (!adminHash) return isLocal(req);
  return adminTokens.has(parseCookies(req.headers.cookie)[COOKIE] ?? "");
}

function backupsOf(id: string): { name: string; created: number; size: number }[] {
  const dir = path.join(BACKUPS, id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => fs.existsSync(path.join(dir, n, "world.json"))).map(name => ({
    name, created: fs.statSync(path.join(dir, name)).mtimeMs, size: dirSize(path.join(dir, name))
  })).sort((a, b) => b.created - a.created);
}

function dirSize(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

/** Run one of the CLI importers as a child process, collecting its output. */
function runCli(script: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, "server", "cli", script), ...args], { env: { ...process.env, MESA_DATA: DATA_DIR } });
    let output = "";
    child.stdout.on("data", d => (output += d));
    child.stderr.on("data", d => (output += d));
    child.on("close", code => resolve({ ok: code === 0, output: output.slice(-8000) }));
  });
}

export function setupRouter(control: WorldControl): express.Router {
  const r = express.Router();
  const guard: express.RequestHandler = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Precisas da palavra-passe de administrador" }));
  const fail = (res: express.Response, err: unknown) => res.status(400).json({ error: (err as Error).message });

  r.get("/", (req, res) => {
    const authed = isAdmin(req);
    const hasPassword = !!readConfig().adminHash;
    if (!authed) return res.json({ authed, hasPassword });
    const active = control.active()?.meta.id ?? null;
    res.json({
      authed, hasPassword, active, dataDir: DATA_DIR,
      worlds: listWorlds(WORLDS_DIR).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.title.localeCompare(b.title, "pt"))
        .map(w => ({ ...w, backups: backupsOf(w.id) }))
    });
  });

  r.post("/login", (req, res) => {
    const { adminHash } = readConfig();
    if (!adminHash) return res.status(400).json({ error: "Ainda não há palavra-passe de administrador" });
    if (!verifyPassword(String(req.body?.password ?? ""), adminHash)) return res.status(401).json({ error: "Palavra-passe errada" });
    const token = crypto.randomBytes(32).toString("base64url");
    adminTokens.add(token);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
    res.json({ ok: true });
  });

  r.post("/logout", (req, res) => {
    adminTokens.delete(parseCookies(req.headers.cookie)[COOKIE] ?? "");
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  r.post("/password", guard, (req, res) => {
    const pw = String(req.body?.password ?? "");
    writeConfig({ ...readConfig(), adminHash: pw ? hashPassword(pw) : null });
    adminTokens.clear();
    res.json({ ok: true });
  });

  r.post("/launch", guard, (req, res) => {
    try {
      control.launch(String(req.body?.id ?? ""));
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/close", guard, (_req, res) => {
    control.close();
    res.json({ ok: true });
  });

  r.post("/create", guard, (req, res) => {
    try {
      const id = String(req.body?.id ?? "").trim();
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Id inválido: usa minúsculas, algarismos e hífenes (ex.: akrasia-2)");
      worldDir(id);
      if (World.exists(id)) throw new Error("Já existe um mundo com esse id");
      const w = World.create({ id, title: String(req.body?.title ?? id).slice(0, 120) || id, system: String(req.body?.system ?? "ordemparanormal") });
      w.createAsSystem("User", [{ name: "Mestre", role: "gm", color: "#ee9b3a" }]);
      w.close();
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/edit", guard, (req, res) => {
    try {
      const id = String(req.body?.id ?? "");
      const changes: Partial<WorldMeta> = { title: String(req.body?.title ?? "").slice(0, 120) || undefined, description: String(req.body?.description ?? "").slice(0, 2000) };
      const active = control.active();
      if (active?.meta.id === id) active.saveMeta(changes);
      else {
        const file = path.join(worldDir(id), "world.json");
        const meta = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...meta, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) }, null, 2));
      }
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/delete", guard, (req, res) => {
    try {
      const id = String(req.body?.id ?? "");
      if (control.active()?.meta.id === id) throw new Error("Fecha o mundo antes de o apagar");
      if (req.body?.confirm !== id) throw new Error("Escreve o id do mundo para confirmar");
      fs.rmSync(worldDir(id), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/backup", guard, (req, res) => {
    try {
      const id = String(req.body?.id ?? "");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dest = path.join(BACKUPS, id, stamp);
      const active = control.active();
      if (active?.meta.id === id) active.backup(dest);
      else {
        const w = World.open(id);
        try {
          w.backup(dest);
        } finally {
          w.close();
        }
      }
      res.json({ ok: true, name: stamp });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/restore", guard, (req, res) => {
    try {
      const id = String(req.body?.id ?? "");
      const name = path.basename(String(req.body?.backup ?? ""));
      const src = path.join(BACKUPS, id, name);
      if (!fs.existsSync(path.join(src, "world.json"))) throw new Error("Cópia não existe");
      const wasActive = control.active()?.meta.id === id;
      if (wasActive) control.close();
      const dir = worldDir(id);
      // Keep what's there as a backup of its own before replacing it.
      if (fs.existsSync(dir)) fs.renameSync(dir, path.join(BACKUPS, id, `antes-de-repor-${Date.now()}`));
      fs.cpSync(src, dir, { recursive: true });
      if (wasActive) control.launch(id);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/deleteBackup", guard, (req, res) => {
    try {
      const dir = path.join(BACKUPS, String(req.body?.id ?? ""), path.basename(String(req.body?.backup ?? "")));
      if (!dir.startsWith(BACKUPS + path.sep) || !fs.existsSync(dir)) throw new Error("Cópia não existe");
      fs.rmSync(dir, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Import a Foundry world folder on this computer (and optionally its system's compendia). */
  r.post("/import", guard, async (req, res) => {
    const raw = String(req.body?.path ?? "").trim();
    const source = path.resolve(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw);
    if (!fs.existsSync(path.join(source, "world.json"))) return res.status(400).json({ error: "Essa pasta não tem um world.json do Foundry" });
    const id = String(req.body?.id ?? "").trim();
    const first = await runCli("import-foundry.ts", [source, ...(id ? ["--id", id] : [])]);
    if (!first.ok) return res.status(400).json({ error: "A importação falhou", output: first.output });
    let output = first.output;
    const worldId = id || JSON.parse(fs.readFileSync(path.join(source, "world.json"), "utf8")).id;
    if (req.body?.systemPacks) {
      const system = JSON.parse(fs.readFileSync(path.join(source, "world.json"), "utf8")).system;
      const systemDir = path.resolve(source, "..", "..", "systems", system);
      if (fs.existsSync(systemDir)) {
        const packs = await runCli("import-packs.ts", [worldId, systemDir]);
        output += "\n" + packs.output;
      }
    }
    res.json({ ok: true, id: worldId, output });
  });

  return r;
}
