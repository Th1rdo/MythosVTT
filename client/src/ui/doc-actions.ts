import type { BaseDoc, DocType } from "../../../shared/protocol.ts";
import { DOC_TYPES, PARENT_TYPE } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { pickFile } from "../dom.ts";
import { t } from "../i18n.ts";
import { confirmDialog, openWindow } from "./windows.ts";
import { ownershipEditor } from "./sheet.ts";

/**
 * What Foundry's directory right-click menus do to any document: duplicate (with what it contains), export
 * to / import from a JSON file, configure ownership, delete.
 */

/** Child types kept with their parent when copying (fog is per-user state, not content). */
const childTypes = (type: DocType) => DOC_TYPES.filter(c => PARENT_TYPE[c] === type && c !== "FogExploration");

const strip = (d: BaseDoc): Record<string, unknown> => {
  const { _id, _parent, ...rest } = d as BaseDoc & Record<string, unknown>;
  return rest;
};

/** Replace old ids by new ones wherever a copied child points at a sibling (tokens/walls on levels). */
function remap(data: Record<string, unknown>, ids: Map<string, string>): Record<string, unknown> {
  const fix = (v: unknown): unknown =>
    typeof v === "string" ? ids.get(v) ?? v : Array.isArray(v) ? v.map(fix) : v;
  for (const k of ["level", "levels", "initialLevel"]) if (k in data) data[k] = fix(data[k]);
  return data;
}

/** Copy a document with its children ("<name> (cópia)"). Returns the new document. */
export async function duplicateDoc(type: DocType, id: string): Promise<BaseDoc | null> {
  const doc = game.get(type, id) as (BaseDoc & { name?: string }) | undefined;
  if (!doc) return null;
  const data = strip(doc);
  if (typeof doc.name === "string") data.name = t("{nome} (cópia)", { nome: doc.name });
  if (type === "Scene") data.active = false;
  const [copy] = await game.create(type, data, doc._parent);
  if (!copy) return null;
  const ids = new Map<string, string>();
  // Levels first: other children refer to them.
  const kids = childTypes(type).sort((a, b) => (a === "Level" ? -1 : b === "Level" ? 1 : 0));
  for (const c of kids) {
    const children = game.children(c, id);
    if (!children.length) continue;
    const created = await game.create(c, children.map(ch => remap(strip(ch), ids)), copy._id);
    children.forEach((ch, i) => created[i] && ids.set(ch._id, created[i]._id));
  }
  if (type === "Scene" && ids.size) {
    const init = (doc as { initialLevel?: string | null }).initialLevel;
    if (init && ids.has(init)) await game.update("Scene", { _id: copy._id, initialLevel: ids.get(init)! });
  }
  return copy;
}

/** Download a document (and its children) as JSON — Foundry's "Export Data". */
export function exportDoc(type: DocType, id: string): void {
  const doc = game.get(type, id) as (BaseDoc & { name?: string }) | undefined;
  if (!doc) return;
  const children = Object.fromEntries(childTypes(type).map(c => [c, game.children(c, id).map(strip)]).filter(([, v]) => (v as unknown[]).length));
  const json = JSON.stringify({ mesa: 1, type, data: strip(doc), children }, null, 2);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = `${type.toLowerCase()}-${(doc.name ?? id).replace(/[^\w\-]+/g, "-").replace(/^-|-$/g, "")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Replace a document's content with an exported file — Foundry's "Import Data". Keeps its id, folder and
 * ownership; the children are replaced by the file's.
 */
export async function importDoc(type: DocType, id: string): Promise<void> {
  const doc = game.get(type, id) as (BaseDoc & { name?: string }) | undefined;
  const file = doc && (await pickFile(".json,application/json"));
  if (!file || !doc) return;
  let parsed: { type?: string; data?: Record<string, unknown>; children?: Record<string, Record<string, unknown>[]> };
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return toast(t("O ficheiro não é JSON válido"), "error");
  }
  if (parsed.type !== type || !parsed.data) return toast(t("O ficheiro não é de um documento deste tipo"), "error");
  if (!(await confirmDialog(t("Substituir o conteúdo de «{nome}» pelo do ficheiro? Isto não se pode desfazer.", { nome: doc.name ?? id }), t("Importar")))) return;
  const { folder, ownership, sort, active, ...data } = parsed.data;
  await game.update(type, { _id: id, ...data }, doc._parent);
  for (const [c, list] of Object.entries(parsed.children ?? {})) {
    if (!childTypes(type).includes(c as DocType)) continue;
    const old = game.children(c as DocType, id).map(x => x._id);
    if (old.length) await game.delete(c as DocType, old, id);
    if (list.length) await game.create(c as DocType, list, id);
  }
  toast(t("Importado"));
}

/** The ownership grid in its own window — Foundry's "Configure Ownership". */
export function openOwnership(type: "Actor" | "JournalEntry" | "Item" | "Cards", id: string): void {
  const doc = game.get(type, id) as (BaseDoc & { name?: string; ownership: Record<string, number | null> }) | undefined;
  if (!doc) return;
  const body = openWindow(`ownership-${id}`, t("Permissões: {nome}", { nome: doc.name ?? "" }), { width: 360 });
  if (!body) return;
  const draw = () => {
    const fresh = game.get(type, id) as typeof doc | undefined;
    if (!fresh) return;
    const ed = ownershipEditor(fresh, type);
    ed.setAttribute("open", "");
    body.replaceChildren(ed);
  };
  game.on(type, e => e.ids.includes(id) && body.isConnected && draw());
  draw();
}

/** Delete after asking, as every "Delete" entry does. */
export async function deleteDoc(type: DocType, id: string): Promise<void> {
  const doc = game.get(type, id) as (BaseDoc & { name?: string }) | undefined;
  if (doc && (await confirmDialog(t("Apagar «{nome}»?", { nome: doc.name ?? id })))) await game.delete(type, id, doc._parent);
}
