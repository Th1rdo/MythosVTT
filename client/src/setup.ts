import { h, setChildren, timeLabel } from "./dom.ts";
import { t } from "./i18n.ts";

interface WorldRow {
  id: string;
  title: string;
  system: string;
  created: number;
  lastPlayed?: number;
  description?: string;
  backups: { name: string; created: number; size: number }[];
}

interface SetupState {
  authed: boolean;
  hasPassword: boolean;
  active?: string | null;
  dataDir?: string;
  worlds?: WorldRow[];
}

async function api<T = { ok: boolean; error?: string }>(route: string, body?: unknown): Promise<T & { error?: string }> {
  const res = await fetch(`/api/setup${route}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

const size = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.round(n / 1e3)} kB`);

/**
 * The setup screen (Foundry's /setup): worlds to launch, create, edit, back up, restore and delete,
 * Foundry imports, and the admin password. Shown when no world is open, or at /setup.
 */
export async function setupScreen(app: HTMLElement): Promise<void> {
  const message = h("p.setup-message");
  const say = (text: string, error = false) => {
    message.textContent = text;
    message.className = `setup-message${error ? " error" : ""}`;
  };
  const act = async (route: string, body: unknown, done?: string) => {
    say("…");
    const r = await api(route, body);
    if (r.error) say(r.error, true);
    else if (done) say(done);
    await render();
    return !r.error;
  };

  const render = async () => {
    const s = await api<SetupState>("");
    if (!s.authed) return renderLogin(s);
    const worlds = s.worlds ?? [];
    const card = (w: WorldRow) => {
      const isActive = w.id === s.active;
      const backups = h("ul.backup-list", { hidden: true }, w.backups.map(b => h("li", null,
        h("span.grow", null, `${new Date(b.created).toLocaleString("pt-PT")} · ${size(b.size)}`),
        h("button.small", { onclick: () => confirm(`Repor "${w.title}" como estava a ${new Date(b.created).toLocaleString("pt-PT")}? O estado atual fica guardado como outra cópia.`) && act("/restore", { id: w.id, backup: b.name }, t("Mundo reposto")) }, t("Repor")),
        h("button.small.danger", { onclick: () => confirm(t("Apagar esta cópia?")) && act("/deleteBackup", { id: w.id, backup: b.name }) }, "✕"))));
      return h("article", { className: `world-card${isActive ? " active" : ""}` },
        h("header.row", null,
          h("div.stack.grow", null, h("h3", null, w.title), h("span.muted.small", null, `${w.id} · ${w.system}${w.lastPlayed ? ` · jogado ${timeLabel(w.lastPlayed)}` : ""}`)),
          isActive ? h("span.tag", null, "aberto") : null),
        w.description ? h("p.small", null, w.description) : null,
        h("div.row.wrap", null,
          isActive
            ? h("button.primary", { onclick: () => (location.href = "/") }, h("i.fa-solid.fa-door-open"), (" " + t("Entrar")))
            : h("button.primary", { onclick: async () => { if (await act("/launch", { id: w.id })) location.href = "/"; } }, h("i.fa-solid.fa-play"), (" " + t("Lançar"))),
          isActive ? h("button", { onclick: () => act("/close", {}, t("Mundo fechado — os jogadores foram desligados.")) }, h("i.fa-solid.fa-power-off"), (" " + t("Fechar"))) : null,
          h("button", {
            onclick: async () => {
              const title = prompt(t("Título do mundo"), w.title);
              if (title === null) return;
              const description = prompt(t("Descrição (opcional)"), w.description ?? "") ?? w.description ?? "";
              act("/edit", { id: w.id, title, description });
            }
          }, h("i.fa-solid.fa-pen"), (" " + t("Editar"))),
          h("button", { onclick: () => act("/backup", { id: w.id }, t("Cópia de segurança feita")) }, h("i.fa-solid.fa-box-archive"), (" " + t("Cópia de segurança"))),
          w.backups.length ? h("button", { onclick: () => (backups.hidden = !backups.hidden) }, `Cópias (${w.backups.length})`) : null,
          !isActive ? h("button.danger", {
            onclick: () => {
              const typed = prompt(`Apagar "${w.title}" para sempre? Escreve o id (${w.id}) para confirmar.`);
              if (typed) act("/delete", { id: w.id, confirm: typed }, t("Mundo apagado"));
            }
          }, h("i.fa-solid.fa-trash")) : null),
        backups);
    };

    const newId = h("input", { placeholder: t("id (ex.: akrasia)"), pattern: "[a-z0-9][a-z0-9-]*" });
    const newTitle = h("input", { placeholder: t("Título") });
    const newSystem = h("input", { value: "ordemparanormal" });
    const importPath = h("input", { placeholder: "~/Library/Application Support/FoundryVTT/Data/worlds/<mundo>" });
    const importId = h("input", { placeholder: "id na Mesa (vazio = o do Foundry)" });
    const importPacks = h("input", { type: "checkbox", checked: true });
    const importOutput = h("pre.setup-output", { hidden: true });
    const pw = h("input", { type: "password", placeholder: "Nova palavra-passe (vazio = nenhuma)" });

    setChildren(app, h("main.setup", null,
      h("header.setup-head", null,
        h("h1", null, t("Mesa · Configuração")),
        h("span.grow"),
        s.active ? h("button", { onclick: () => (location.href = "/") }, t("Voltar ao jogo")) : null,
        s.hasPassword ? h("button", { onclick: async () => { await api("/logout", {}); render(); } }, h("i.fa-solid.fa-right-from-bracket"), (" " + t("Sair"))) : null),
      message,
      !s.hasPassword ? h("p.setup-warning", null, t("Sem palavra-passe de administrador: só este computador abre a configuração. Define uma antes de pôr a Mesa na internet.")) : null,
      h("section", null, h("h2", null, t("Mundos")), worlds.length ? h("div.world-grid", null, worlds.map(card)) : h("p.muted", null, t("Ainda não há mundos."))),
      h("section.setup-forms", null,
        h("form.setup-box.stack", {
          onsubmit: (e: Event) => { e.preventDefault(); act("/create", { id: newId.value.trim(), title: newTitle.value.trim(), system: newSystem.value.trim() }, t("Mundo criado (o utilizador \"Mestre\" não tem palavra-passe)")); }
        }, h("h3", null, t("Criar mundo")), newId, newTitle, h("label.field", null, h("span", null, t("Sistema")), newSystem), h("button.primary", { type: "submit" }, t("Criar"))),
        h("form.setup-box.stack", {
          onsubmit: async (e: Event) => {
            e.preventDefault();
            say(t("A importar… (pode demorar)"));
            const r = await api<{ ok: boolean; output?: string; id?: string }>("/import", { path: importPath.value.trim(), id: importId.value.trim(), systemPacks: importPacks.checked });
            importOutput.hidden = !r.output;
            importOutput.textContent = r.output ?? "";
            say(r.error ?? `Importado como "${r.id}"`, !!r.error);
            render();
          }
        }, h("h3", null, t("Importar do Foundry")),
          h("label.field", null, h("span", null, t("Pasta do mundo (neste computador)")), importPath), importId,
          h("label.row", null, importPacks, t("Trazer também os compêndios do sistema")),
          h("button.primary", { type: "submit" }, t("Importar")), importOutput),
        h("form.setup-box.stack", {
          onsubmit: (e: Event) => { e.preventDefault(); act("/password", { password: pw.value }, pw.value ? t("Palavra-passe definida — volta a entrar") : t("Palavra-passe retirada")); }
        }, h("h3", null, t("Palavra-passe de administrador")), pw, h("button", { type: "submit" }, t("Guardar")))),
      s.dataDir ? h("p.muted.small", null, `Dados em ${s.dataDir}`) : null));
  };

  const renderLogin = (s: SetupState) => {
    const pw = h("input", { type: "password", placeholder: t("Palavra-passe de administrador"), autocomplete: "current-password" });
    setChildren(app, h("main.join", null, h("form.join-card.stack", {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const r = await api("/login", { password: pw.value });
        if (r.error) say(r.error, true);
        else render();
      }
    },
      h("h1", null, t("Mesa · Configuração")),
      s.hasPassword ? pw : h("p", null, t("Ainda não há palavra-passe de administrador: abre esta página no computador onde a Mesa está a correr.")),
      message,
      s.hasPassword ? h("button.primary", { type: "submit" }, t("Entrar")) : null,
      h("a.muted.small", { href: "/" }, t("Voltar")))));
    pw.focus();
  };

  await render();
}
