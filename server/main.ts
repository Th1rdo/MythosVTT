import fs from "node:fs";
import { worldSetting } from "../shared/settings.ts";
import http from "node:http";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import type { UserDoc } from "../shared/protocol.ts";
import { CLIENT_DIST, WORLDS_DIR, safeJoin } from "./paths.ts";
import { World, listWorlds } from "./world.ts";
import { Hub } from "./hub.ts";
import { Sessions, parseCookies, verifyPassword } from "./auth.ts";
import { applyAdminPasswordFromEnv, setupRouter } from "./setup.ts";
import { MODULES_DIR, activePackages, installedPackages, isInstalledPackage, missingRequirements } from "./packages.ts";

const PORT = Number(process.env.MESA_PORT ?? 30100);

/** The world to open on start: --world / MESA_WORLD, or the only one; otherwise start on the setup screen. */
function startingWorld(): string | null {
  const argIdx = process.argv.indexOf("--world");
  const requested = argIdx >= 0 ? process.argv[argIdx + 1] : process.env.MESA_WORLD;
  if (requested) return requested;
  const worlds = listWorlds(WORLDS_DIR);
  return worlds.length === 1 ? worlds[0].id : null;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const hub = new Hub(io);
let active: { world: World; sessions: Sessions } | null = null;

/** Open a world and serve it (closing the one before). */
function launch(id: string): void {
  if (!World.exists(id)) throw new Error(`O mundo "${id}" não existe`);
  close();
  const w = World.open(id);
  w.saveMeta({ lastPlayed: Date.now() });
  active = { world: w, sessions: new Sessions(path.join(w.dir, "sessions.json")) };
  hub.attach(active.world, active.sessions);
  console.log(`Mesa — "${w.meta.title}" (${w.meta.id})`);
}

/** Back to the setup screen. */
function close(): void {
  if (!active) return;
  hub.detach();
  active.world.close();
  active = null;
}

applyAdminPasswordFromEnv();
const first = startingWorld();
if (first) launch(first);
else console.log("Mesa — sem mundo aberto: abre /setup para escolher ou criar um.");

/** The open world (routes that need one answer 503 on the setup screen). */
function requireWorld(res: express.Response): World | null {
  if (active) return active.world;
  res.status(503).json({ error: "Nenhum mundo aberto", setup: true });
  return null;
}

function currentUser(req: express.Request): UserDoc | undefined {
  if (!active) return undefined;
  return active.world.user(active.sessions.userId(parseCookies(req.headers.cookie)[Sessions.COOKIE]));
}

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

/** Public info for the join screen. */
app.use("/api/setup", setupRouter({ active: () => active?.world ?? null, launch, close }));

app.get("/api/world", (req, res) => {
  if (!active) return res.json({ world: null, setup: true });
  const world = active.world;
  const { id, title, system } = world.meta;
  res.json({
    world: { id, title, system },
    users: world.all<UserDoc>("User").map(u => ({ _id: u._id, name: u.name, role: u.role, color: u.color })),
    me: currentUser(req)?._id ?? null
  });
});

const failedLogins = new Map<string, { count: number; until: number }>();

app.post("/api/login", (req, res) => {
  const ip = req.ip ?? "?";
  const lock = failedLogins.get(ip);
  if (lock && lock.until > Date.now()) return res.status(429).json({ error: "Demasiadas tentativas. Espera um minuto." });

  const world = requireWorld(res);
  if (!world || !active) return;
  const user = world.user(String(req.body?.userId ?? ""));
  if (!user || !verifyPassword(String(req.body?.password ?? ""), user.passwordHash)) {
    const count = (lock?.count ?? 0) + 1;
    failedLogins.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    return res.status(401).json({ error: "Palavra-passe errada" });
  }
  failedLogins.delete(ip);
  const sid = active.sessions.create(user._id);
  res.cookie(Sessions.COOKIE, sid, { httpOnly: true, sameSite: "lax", maxAge: Sessions.MAX_AGE_MS, path: "/" });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  active?.sessions.destroy(parseCookies(req.headers.cookie)[Sessions.COOKIE]);
  res.clearCookie(Sessions.COOKIE, { path: "/" });
  res.json({ ok: true });
});

const UPLOAD_TYPES = /\.(png|jpe?g|webp|gif|svg|avif|mp3|ogg|oga|opus|flac|aac|wav|webm|mp4|m4v|m4a|pdf)$/i;
const KINDS: Record<string, RegExp> = {
  image: /\.(png|jpe?g|webp|gif|svg|avif)$/i,
  imagevideo: /\.(png|jpe?g|webp|gif|svg|avif|webm|mp4|m4v)$/i,
  audio: /\.(mp3|ogg|oga|opus|flac|aac|wav|webm|m4a)$/i,
  video: /\.(webm|mp4|m4v)$/i,
  pdf: /\.pdf$/i,
  any: UPLOAD_TYPES
};
const canBrowse = (u: UserDoc | undefined) => !!u && !!active && (u.role === "gm" || !!worldSetting(active.world, "core.playerBrowse"));
/** A folder inside the world's assets ("" = the root), or null if it escapes or doesn't exist. */
function assetDir(rel: unknown): { abs: string; rel: string } | null {
  if (!active) return null;
  const world = active.world;
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  try {
    const abs = safeJoin(world.assetsDir, clean);
    return fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? { abs, rel: clean } : null;
  } catch {
    return null;
  }
}
const assetUrl = (rel: string) => "/assets/" + rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");

/** Browse the world's assets: folders and files of one kind (image, audio, video, pdf, any). */
app.get("/api/files", (req, res) => {
  if (!canBrowse(currentUser(req))) return res.status(403).json({ error: "Sem permissão para ver os ficheiros" });
  const dir = assetDir(req.query.path);
  if (!dir) return res.status(404).json({ error: "Pasta não existe" });
  const kind = KINDS[String(req.query.type ?? "any")] ?? UPLOAD_TYPES;
  const entries = fs.readdirSync(dir.abs, { withFileTypes: true }).filter(e => !e.name.startsWith("."));
  const join = (n: string) => (dir.rel ? `${dir.rel}/${n}` : n);
  res.json({
    path: dir.rel,
    dirs: entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b, "pt")),
    files: entries.filter(e => e.isFile() && kind.test(e.name)).map(e => {
      const st = fs.statSync(path.join(dir.abs, e.name));
      return { name: e.name, url: assetUrl(join(e.name)), size: st.size, mtime: st.mtimeMs };
    }).sort((a, b) => a.name.localeCompare(b.name, "pt"))
  });
});

/** GM: make a folder inside the world's assets. */
app.post("/api/files/folder", express.json(), (req, res) => {
  if (currentUser(req)?.role !== "gm") return res.status(403).json({ error: "Só o mestre pode criar pastas" });
  const parent = assetDir(req.body?.path);
  const name = String(req.body?.name ?? "").trim().normalize("NFKD").replace(/[^\w .-]+/g, "").replace(/^[.\s]+/, "").slice(0, 80);
  if (!parent || !name) return res.status(400).json({ error: "Nome de pasta inválido" });
  const abs = path.join(parent.abs, name);
  if (fs.existsSync(abs)) return res.status(400).json({ error: "Já existe" });
  fs.mkdirSync(abs);
  res.json({ path: parent.rel ? `${parent.rel}/${name}` : name });
});

/**
 * Uploads: raw body, filename in ?name=, folder in ?dir= (default "uploads"; players who can't browse
 * always get "uploads"). The GM, or players when the world allows it.
 */
// Accept any body type: browsers send files of unknown type (some audio formats) without a Content-Type.
app.post("/api/upload", express.raw({ type: () => true, limit: "200mb" }), (req, res) => {
  const uploader = currentUser(req);
  const world = active?.world;
  if (!world || !uploader || (uploader.role !== "gm" && !worldSetting(world, "core.playerUpload"))) {
    return res.status(403).json({ error: "Só o mestre pode carregar ficheiros" });
  }
  const original = path.basename(String(req.query.name ?? ""));
  if (!UPLOAD_TYPES.test(original)) return res.status(400).json({ error: "Tipo de ficheiro não suportado" });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Ficheiro vazio" });
  const safe = original.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^-+/, "").toLowerCase();
  const wanted = canBrowse(uploader) && req.query.dir !== undefined ? String(req.query.dir) : "uploads";
  if (wanted === "uploads") fs.mkdirSync(path.join(world.assetsDir, "uploads"), { recursive: true });
  const dir = assetDir(wanted);
  if (!dir) return res.status(400).json({ error: "Pasta não existe" });
  let name = safe;
  for (let i = 1; fs.existsSync(path.join(dir.abs, name)); i++) name = safe.replace(/(\.\w+)$/, `-${i}$1`);
  fs.writeFileSync(path.join(dir.abs, name), req.body as Buffer);
  res.json({ path: assetUrl(dir.rel ? `${dir.rel}/${name}` : name) });
});

/** World assets. Requires a session so a world's maps aren't public. */
app.get("/assets/{*rest}", (req, res) => {
  if (!currentUser(req) || !active) return res.status(401).end();
  const world = active.world;
  try {
    const rel = decodeURIComponent(req.path.slice("/assets/".length));
    const file = safeJoin(world.assetsDir, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).end();
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (file.endsWith(".svg")) res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    res.sendFile(file, { maxAge: "1h" });
  } catch {
    res.status(400).end();
  }
});

/** Package files (scripts, styles, languages, art), for logged-in users. */
app.get("/modules/{*rest}", (req, res) => {
  if (!currentUser(req) || !active) return res.status(401).end();
  try {
    const rel = decodeURIComponent(req.path.slice("/modules/".length));
    const id = rel.split("/")[0];
    if (!isInstalledPackage(id)) return res.status(404).end();
    const file = safeJoin(MODULES_DIR, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).end();
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Scripts change while a package is being written; don't let the browser keep stale copies.
    res.sendFile(file, { maxAge: 0 });
  } catch {
    res.status(400).end();
  }
});

/** GM: every installed package with whether it's on in this world and why it might not run. */
app.get("/api/packages", (req, res) => {
  const me = currentUser(req);
  if (!me || !active) return res.status(401).end();
  if (me.role !== "gm") return res.status(403).end();
  const world = active.world;
  const on = new Set(activePackages(world).map(p => p.id));
  const wanted = worldSetting<Record<string, boolean>>(world, "core.modules") ?? {};
  res.json([...installedPackages(true).values()].map(p => ({
    ...p, enabled: wanted[p.id] === true, running: on.has(p.id), missing: missingRequirements(world, p.id)
  })));
});

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: "index.html" }));
  app.get("/{*rest}", (_req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
}

server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}` + (fs.existsSync(CLIENT_DIST) ? "" : "  (dev: open the Vite URL, usually http://localhost:5173)"));
});

function shutdown() {
  io.close();
  server.close();
  active?.world.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

