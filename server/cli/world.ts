/**
 * World management.
 *   npm run world -- list
 *   npm run world -- create <id> "<Title>" [--gm <name>] [--password <pw>]
 *   npm run world -- add-user <world> <name> [--gm] [--password <pw>]
 *   npm run world -- passwd <world> <user name> [<new password>]   (omit to clear)
 */
import { World, listWorlds } from "../world.ts";
import { WORLDS_DIR } from "../paths.ts";
import { hashPassword } from "../auth.ts";
import type { UserDoc } from "../../shared/protocol.ts";

const [cmd, ...args] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : "";
}

function addUser(world: World, name: string, role: "gm" | "player", password?: string): UserDoc {
  const [user] = world.createAsSystem("User", [{
    name, role, color: role === "gm" ? "#e0b84a" : "#7c8cff",
    passwordHash: password ? hashPassword(password) : null
  }]);
  return user as UserDoc;
}

switch (cmd) {
  case "list": {
    const worlds = listWorlds(WORLDS_DIR);
    if (!worlds.length) console.log(`No worlds in ${WORLDS_DIR}`);
    for (const w of worlds) console.log(`${w.id}\t${w.title}\t(${w.system})`);
    break;
  }
  case "create": {
    const gm = flag("gm") || "Mestre";
    const password = flag("password");
    const [id, title] = args;
    if (!id) throw new Error('Usage: create <id> "<Title>"');
    const world = World.create({ id, title: title || id, system: "ordemparanormal" });
    addUser(world, gm, "gm", password);
    world.createAsSystem("Scene", [{ name: "Cena inicial", active: true }]);
    world.close();
    console.log(`Created world "${id}" in ${world.dir}\nGM user: ${gm} ${password ? "(password set)" : "(no password — set one with: npm run world -- passwd " + id + " " + gm + " <pw>)"}`);
    break;
  }
  case "add-user": {
    const isGm = flag("gm") !== undefined;
    const password = flag("password");
    const [id, name] = args;
    if (!id || !name) throw new Error("Usage: add-user <world> <name> [--gm] [--password <pw>]");
    const world = World.open(id);
    addUser(world, name, isGm ? "gm" : "player", password);
    world.close();
    console.log(`Added ${isGm ? "GM" : "player"} "${name}"`);
    break;
  }
  case "passwd": {
    const [id, name, password] = args;
    if (!id || !name) throw new Error("Usage: passwd <world> <user name> [<new password>]");
    const world = World.open(id);
    const user = world.all<UserDoc>("User").find(u => u.name === name);
    if (!user) throw new Error(`No user named "${name}"`);
    world.insertRaw("User", [{ ...user, passwordHash: password ? hashPassword(password) : null }]);
    world.close();
    console.log(password ? `Password set for "${name}"` : `Password cleared for "${name}"`);
    break;
  }
  default:
    console.log(`Usage:
  npm run world -- list
  npm run world -- create <id> "<Title>" [--gm <name>] [--password <pw>]
  npm run world -- add-user <world> <name> [--gm] [--password <pw>]
  npm run world -- passwd <world> <user name> [<new password>]`);
}
