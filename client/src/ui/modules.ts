import type { PackageInfo } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { h, setChildren } from "../dom.ts";
import { t } from "../i18n.ts";
import { settings } from "../settings.ts";
import { closeWindow, confirmDialog, openWindow } from "./windows.ts";

interface Row extends PackageInfo {
  enabled: boolean;
  running: boolean;
  missing: string[];
}

/**
 * Ask whether to reload every connected page now (a change that only applies after a reload: packages, or
 * a world setting marked `reload`). The GM's "yes" reloads the others through the server, then this page.
 */
export async function reloadConfirm(world: boolean): Promise<void> {
  const yes = await confirmDialog(world ? t("Recarregar agora a página de toda a mesa para aplicar?") : t("Recarregar a página para aplicar?"), t("Recarregar"));
  if (!yes) return;
  if (world && game.isGM) game.socket.emit("reload");
  setTimeout(() => location.reload(), 150);
}

/**
 * Gerir módulos (GM): every package in data/modules with on/off for this world. Switching one on offers its
 * dependencies too; one that others need can't be switched off. Saved = core.modules, then a reload.
 */
export async function openModuleManagement(): Promise<void> {
  const body = openWindow("module-management", t("Gerir módulos"), { width: 640 });
  if (!body) return;
  const res = await fetch("/api/packages");
  if (!res.ok) {
    closeWindow("module-management");
    return toast(t("Só o mestre gere os módulos"), "error");
  }
  const rows: Row[] = await res.json();
  const byId = new Map(rows.map(r => [r.id, r]));
  const on = new Set(rows.filter(r => r.enabled).map(r => r.id));
  const initial = JSON.stringify([...on].sort());
  let filter: "all" | "on" | "off" = "all";
  let query = "";

  /** Packages `id` needs (recursively) that aren't on yet; null when one can't run at all. */
  const needs = (id: string, seen = new Set<string>()): string[] | null => {
    const out: string[] = [];
    for (const r of byId.get(id)?.requires ?? []) {
      if (seen.has(r)) continue;
      seen.add(r);
      const dep = byId.get(r);
      if (!dep?.compatible) return null;
      if (!on.has(r)) out.push(r);
      const deeper = needs(r, seen);
      if (!deeper) return null;
      out.push(...deeper);
    }
    return [...new Set(out)];
  };
  const requiredBy = (id: string) => rows.filter(r => on.has(r.id) && r.requires.includes(id));
  const titles = (ids: string[]) => ids.map(i => byId.get(i)?.title ?? i).join(", ");

  const toggle = async (row: Row, want: boolean) => {
    if (want) {
      const deps = needs(row.id);
      if (!deps) return toast(t("«{titulo}» precisa de um módulo que não está instalado ou não corre na Mesa: {em_falta}", { titulo: row.title, em_falta: titles(row.requires.filter(r => !byId.get(r)?.compatible)) }), "error");
      if (deps.length && !(await confirmDialog(t("«{titulo}» precisa de: {deps}. Ativar também?", { titulo: row.title, deps: titles(deps) }), t("Ativar")))) return render();
      for (const d of deps) on.add(d);
      on.add(row.id);
    } else {
      const users = requiredBy(row.id);
      if (users.length) {
        toast(t("Não dá para desativar «{titulo}»: {outros} precisa(m) dele.", { titulo: row.title, outros: users.map(u => u.title).join(", ") }), "error");
        return render();
      }
      on.delete(row.id);
    }
    render();
  };

  const list = h("ul.module-list");
  const footer = h("div.row.end");
  const render = () => {
    const q = query.trim().toLocaleLowerCase("pt");
    const shown = rows.filter(r =>
      (filter === "all" || (filter === "on") === on.has(r.id)) &&
      (!q || [r.id, r.title, ...r.authors].some(s => s.toLocaleLowerCase("pt").includes(q))));
    setChildren(list, shown.length ? shown.map(r => {
      const checked = on.has(r.id);
      return h("li", { className: `module-row${checked ? " on" : ""}${r.compatible ? "" : " incompatible"}` },
        h("label.row", null,
          h("input", { type: "checkbox", checked, disabled: !r.compatible && !checked, onchange: (e: Event) => toggle(r, (e.target as HTMLInputElement).checked) }),
          h("strong.grow", null, r.title),
          h("span.tag", null, `v${r.version}`)),
        h("div.module-meta.muted.small", null,
          r.id, r.authors.length ? ` · ${r.authors.join(", ")}` : "",
          r.requires.length ? ` · ${t("precisa de")} ${titles(r.requires)}` : ""),
        r.description ? h("p.small", null, r.description) : null,
        r.problems.map(p => h("p.module-problem.small", null, h("i.fa-solid.fa-triangle-exclamation"), " ", p)),
        r.enabled && !r.running && r.compatible && r.missing.length ? h("p.module-problem.small", null, t("Não está a correr: falta ativar {deps}", { deps: titles(r.missing) })) : null);
    }) : h("li.muted", null, rows.length ? t("Nenhum módulo corresponde.") : t("Não há módulos instalados. Copia a pasta de um módulo para data/modules/ e volta a abrir esta janela.")));
    const changed = JSON.stringify([...on].sort()) !== initial;
    setChildren(footer,
      h("span.muted.small.grow", null, t("{n} de {total} ativos", { n: on.size, total: rows.length })),
      h("button", { onclick: () => { on.clear(); render(); } }, t("Desativar todos")),
      h("button.primary", {
        disabled: !changed,
        onclick: async () => {
          const value = Object.fromEntries(rows.map(r => [r.id, on.has(r.id)]).filter(([, v]) => v));
          if (!(await settings.set("core.modules", value))) return;
          closeWindow("module-management");
          await reloadConfirm(true);
        }
      }, t("Guardar")));
  };

  const filters = h("div.module-filters.row", null,
    (["all", "on", "off"] as const).map(f => h("button.small", {
      className: `small${f === filter ? " active" : ""}`,
      onclick: (e: Event) => {
        filter = f;
        for (const b of filters.querySelectorAll("button")) b.classList.toggle("active", b === e.currentTarget);
        render();
      }
    }, f === "all" ? t("Todos") : f === "on" ? t("Ativos") : t("Inativos"))),
    h("input.grow", { type: "search", placeholder: t("Procurar por nome, id ou autor"), oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; render(); } }));

  body.append(h("div.module-management.stack", null,
    h("p.muted.small", null, t("Os módulos ficam em data/modules/. Só correm na Mesa os que têm o bloco \"mesa\" no module.json (ver docs/packages.md).")),
    filters, list, footer));
  render();
}
