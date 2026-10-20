import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import type { UserDoc } from "../shared/protocol.ts";
import { CLIENT_DIST, WORLDS_DIR, safeJoin } from "./paths.ts";
import { World, listWorlds } from "./world.ts";
import { Hub } from "./hub.ts";
import { Sessions, parseCookies, verifyPassword } from "./auth.ts";

const PORT = Number(process.env.MESA_PORT ?? 30100);

function pickWorld(): World {
  const argIdx = process.argv.indexOf("--world");
  const requested = argIdx >= 0 ? process.argv[argIdx + 1] : process.env.MESA_WORLD;
  if (requested) return World.open(requested);
  const worlds = listWorlds(WORLDS_DIR);
  if (worlds.length === 1) return World.open(worlds[0].id);
  if (!worlds.length) {
    console.error(`No worlds in ${WORLDS_DIR}.\nCreate one:   npm run world -- create <id> "<Title>"\nor import:    npm run import -- <path-to-foundry-world>`);
  } else {
    console.error(`Several worlds found, pick one with --world <id> or MESA_WORLD:\n` + worlds.map(w => `  ${w.id}  (${w.title})`).join("\n"));
  }
  process.exit(1);
}

const world = pickWorld();
const sessions = new Sessions(path.join(world.dir, "sessions.json"));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
new Hub(io, world, sessions);

function currentUser(req: express.Request): UserDoc | undefined {
  return world.user(sessions.userId(parseCookies(req.headers.cookie)[Sessions.COOKIE]));
}

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

/** Public info for the join screen. */
app.get("/api/world", (req, res) => {
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

  const user = world.user(String(req.body?.userId ?? ""));
  if (!user || !verifyPassword(String(req.body?.password ?? ""), user.passwordHash)) {
    const count = (lock?.count ?? 0) + 1;
    failedLogins.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    return res.status(401).json({ error: "Palavra-passe errada" });
  }
  failedLogins.delete(ip);
  const sid = sessions.create(user._id);
  res.cookie(Sessions.COOKIE, sid, { httpOnly: true, sameSite: "lax", maxAge: Sessions.MAX_AGE_MS, path: "/" });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  sessions.destroy(parseCookies(req.headers.cookie)[Sessions.COOKIE]);
  res.clearCookie(Sessions.COOKIE, { path: "/" });
  res.json({ ok: true });
});

const UPLOAD_TYPES = /\.(png|jpe?g|webp|gif|svg|avif|mp3|ogg|wav|webm|mp4|m4a)$/i;

/** GM uploads: raw body, filename in ?name=. Stored under the world's assets/uploads. */
app.post("/api/upload", express.raw({ type: "*/*", limit: "200mb" }), (req, res) => {
  if (currentUser(req)?.role !== "gm") return res.status(403).json({ error: "Só o mestre pode carregar ficheiros" });
  const original = path.basename(String(req.query.name ?? ""));
  if (!UPLOAD_TYPES.test(original)) return res.status(400).json({ error: "Tipo de ficheiro não suportado" });
  const safe = original.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^-+/, "").toLowerCase();
  const dir = path.join(world.assetsDir, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  let name = safe;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = safe.replace(/(\.\w+)$/, `-${i}$1`);
  fs.writeFileSync(path.join(dir, name), req.body as Buffer);
  res.json({ path: `/assets/uploads/${name}` });
});

/** World assets. Requires a session so a world's maps aren't public. */
app.get("/assets/{*rest}", (req, res) => {
  if (!currentUser(req)) return res.status(401).end();
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

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: "index.html" }));
  app.get("/{*rest}", (_req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
}

server.listen(PORT, () => {
  console.log(`Mesa — "${world.meta.title}" (${world.meta.id})`);
  console.log(`Server on http://localhost:${PORT}` + (fs.existsSync(CLIENT_DIST) ? "" : "  (dev: open the Vite URL, usually http://localhost:5173)"));
});

function shutdown() {
  io.close();
  server.close();
  world.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

