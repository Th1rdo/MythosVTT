import fs from "node:fs";
import path from "node:path";
import type { DocLookup } from "../shared/permissions.ts";
import type { PackageInfo } from "../shared/protocol.ts";
import { worldSetting } from "../shared/settings.ts";
import { DATA_DIR } from "./paths.ts";

/**
 * Packages (Foundry's modules): folders under data/modules/<id> with a `module.json` manifest — the same
 * file name and the same core fields as Foundry (id, title, description, version, authors, esmodules,
 * styles, languages, socket, relationships.requires), so one repository can serve both. A package runs in
 * Mesa only when its manifest has a `mesa` block; that block may override esmodules/styles/languages with
 * Mesa-specific files (the Foundry scripts use Foundry's API and don't run here). The GM switches packages
 * on per world (world setting core.modules = { id: true }).
 */
export const MODULES_DIR = path.join(DATA_DIR, "modules");

const PACKAGE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface Manifest {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  version?: unknown;
  authors?: { name?: unknown }[];
  esmodules?: unknown;
  styles?: unknown;
  languages?: { lang?: unknown; name?: unknown; path?: unknown }[];
  socket?: unknown;
  url?: unknown;
  relationships?: { requires?: { id?: unknown; type?: unknown }[] };
  mesa?: {
    esmodules?: unknown;
    styles?: unknown;
    languages?: unknown;
    compatibility?: { minimum?: unknown; verified?: unknown };
  };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => (typeof x === "string" ? x : (x as { src?: unknown })?.src)).filter((x): x is string => typeof x === "string" && !!x) : [];

/** A relative file path inside the package (no escaping it, no URLs). */
const relFile = (p: string) => !/^([a-z]+:|\/|\\)/i.test(p) && !p.split(/[\\/]/).includes("..");

let cache: Map<string, PackageInfo> | null = null;

/** Read every manifest (cached; `rescan` re-reads after an install). */
export function installedPackages(rescan = false): Map<string, PackageInfo> {
  if (cache && !rescan) return cache;
  const out = new Map<string, PackageInfo>();
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(MODULES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    // No modules folder yet.
  }
  for (const dir of dirs) {
    const info = readManifest(dir);
    if (info) out.set(info.id, info);
  }
  cache = out;
  return out;
}

function readManifest(dir: string): PackageInfo | null {
  let m: Manifest;
  try {
    m = JSON.parse(fs.readFileSync(path.join(MODULES_DIR, dir, "module.json"), "utf8"));
  } catch {
    return null;
  }
  const problems: string[] = [];
  const id = typeof m.id === "string" ? m.id : dir;
  if (!PACKAGE_ID.test(id)) return null;
  if (id !== dir) problems.push(`A pasta chama-se "${dir}" mas o id é "${id}"`);
  const mesa = m.mesa && typeof m.mesa === "object" ? m.mesa : null;
  const pick = (k: "esmodules" | "styles") => strings(mesa?.[k] ?? m[k]).filter(relFile);
  const langs = (Array.isArray(mesa?.languages) ? mesa.languages : m.languages) as Manifest["languages"];
  const languages = (Array.isArray(langs) ? langs : [])
    .filter(l => typeof l?.lang === "string" && typeof l.path === "string" && relFile(l.path))
    .map(l => ({ lang: l.lang as string, name: typeof l.name === "string" ? l.name : (l.lang as string), path: l.path as string }));
  const requires = (m.relationships?.requires ?? []).map(r => r?.id).filter((x): x is string => typeof x === "string" && PACKAGE_ID.test(x));
  if (!mesa) problems.push("Feito para o Foundry: não tem bloco \"mesa\" no module.json");
  for (const f of [...pick("esmodules"), ...pick("styles"), ...languages.map(l => l.path)]) {
    if (!fs.existsSync(path.join(MODULES_DIR, dir, f))) problems.push(`Falta o ficheiro ${f}`);
  }
  return {
    id,
    title: typeof m.title === "string" ? m.title : id,
    description: typeof m.description === "string" ? m.description.slice(0, 2000) : "",
    version: typeof m.version === "string" ? m.version : "0",
    authors: (m.authors ?? []).map(a => a?.name).filter((x): x is string => typeof x === "string"),
    url: typeof m.url === "string" ? m.url : null,
    esmodules: pick("esmodules"),
    styles: pick("styles"),
    languages,
    socket: m.socket === true,
    requires,
    compatible: !!mesa && problems.length === 0,
    problems
  };
}

export function isInstalledPackage(id: string): boolean {
  return installedPackages().has(id);
}

/** The world's switched-on packages that can run, dependencies first; packages missing a dependency are left out. */
export function activePackages(world: DocLookup): PackageInfo[] {
  const wanted = worldSetting<Record<string, boolean>>(world, "core.modules") ?? {};
  const all = installedPackages();
  const on = (id: string) => wanted[id] === true && !!all.get(id)?.compatible;
  const ok = new Map<string, boolean>();
  const usable = (id: string, seen: Set<string>): boolean => {
    if (ok.has(id)) return ok.get(id)!;
    if (seen.has(id) || !on(id)) return false;
    seen.add(id);
    const res = all.get(id)!.requires.every(r => usable(r, seen));
    ok.set(id, res);
    return res;
  };
  const order: PackageInfo[] = [];
  const visit = (id: string) => {
    const p = all.get(id)!;
    if (order.includes(p)) return;
    p.requires.forEach(visit);
    order.push(p);
  };
  for (const id of all.keys()) if (usable(id, new Set())) visit(id);
  return order;
}

/** Why a package that is switched on doesn't run (for the management window). */
export function missingRequirements(world: DocLookup, id: string): string[] {
  const wanted = worldSetting<Record<string, boolean>>(world, "core.modules") ?? {};
  const all = installedPackages();
  return (all.get(id)?.requires ?? []).filter(r => !all.get(r)?.compatible || wanted[r] !== true);
}
