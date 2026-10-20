import type { ActorDoc, JournalEntryDoc, SceneDoc, UserDoc } from "../../../shared/protocol.ts";
import { OWNERSHIP } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { avatar, h, imageSize, pickFile, safeHtml, upload } from "../dom.ts";
import { openSheet, ownershipEditor } from "./sheet.ts";
import { closeWindow, confirmDialog, openWindow, prompt, setWindowTitle } from "./windows.ts";

// ---------------------------------------------------------------------------
// Actors

export function actorsPanel(): HTMLElement {
  const list = h("ul.doc-list");
  const render = () => {
    const actors = game.all<ActorDoc>("Actor").sort((a, b) => a.name.localeCompare(b.name, "pt"));
    list.replaceChildren(...actors.map(a => h("li", {
      draggable: game.isGM,
      ondragstart: (e: DragEvent) => e.dataTransfer?.setData("application/x-mesa-actor", a._id),
      onclick: () => openSheet(a._id)
    },
      avatar(a.img, a.name, 32),
      h("span.grow", null, a.name),
      h("span.muted.small", null, a.type),
      game.isGM && h("button.icon.small", {
        title: "Apagar",
        onclick: async (e: Event) => {
          e.stopPropagation();
          if (await confirmDialog(`Apagar "${a.name}"?`)) game.delete("Actor", a._id);
        }
      }, "✕")
    )));
    if (!actors.length) list.append(h("li.muted", null, "Sem atores."));
  };
  game.on("Actor", render);
  game.on("ready", render);
  render();

  const add = async () => {
    const v = await prompt("Novo ator", [{ name: "name", label: "Nome" }, { name: "type", label: "Tipo (agent / threat)", value: "agent" }]);
    if (!v?.name) return;
    const [actor] = await game.create<ActorDoc>("Actor", { name: v.name, type: v.type || "agent", system: v.type === "threat" ? {} : blankAgent() });
    openSheet(actor._id);
  };

  return h("div.panel", null,
    game.isGM && h("div.row.toolbar", null, h("button.primary", { onclick: add }, "+ Ator"), h("span.muted.small", null, "Arrasta um ator para o mapa")),
    list
  );
}

/** Minimal Ordem Paranormal agent so the sheet has something to show. */
function blankAgent(): Record<string, unknown> {
  const skill = (attr: string) => ({ value: 0, attr: [attr, 1], degree: { label: "untrained", value: 0 }, mod: null });
  const skills: Record<string, unknown> = {};
  const map: Record<string, string> = {
    acrobatics: "dex", animal: "pre", arts: "pre", athleticism: "str", relevance: "int", sciences: "int", crime: "dex",
    diplomacy: "pre", deception: "pre", resilience: "vit", stealth: "dex", initiative: "dex", intimidation: "pre",
    intuition: "pre", investigation: "int", fighting: "str", medicine: "int", occultism: "int", perception: "pre",
    driving: "dex", aim: "dex", reflexes: "dex", religion: "pre", survival: "int", tactics: "int", technology: "int", will: "pre"
  };
  for (const [k, a] of Object.entries(map)) skills[k] = skill(a);
  return {
    PV: { value: 20, max: 20 }, SAN: { value: 12, max: 12 }, PE: { value: 2, max: 2 },
    NEX: { value: 5 }, defense: { value: 10 }, desloc: { value: 9 },
    attributes: { dex: { value: 1 }, str: { value: 1 }, int: { value: 1 }, pre: { value: 1 }, vit: { value: 1 } },
    skills, biography: ""
  };
}

// ---------------------------------------------------------------------------
// Scenes (GM)

export function scenesPanel(): HTMLElement {
  const list = h("ul.doc-list");
  const render = () => {
    const scenes = game.all<SceneDoc>("Scene").sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"));
    list.replaceChildren(...scenes.map(s => h("li", {
      className: s._id === game.viewedSceneId ? "current" : "",
      onclick: () => game.view(s._id)
    },
      h("span.grow", null, s.active ? "● " : "", s.name),
      !s.active && h("button.small", { title: "Ativar para todos", onclick: (e: Event) => (e.stopPropagation(), game.update("Scene", { _id: s._id, active: true })) }, "Ativar"),
      h("button.icon.small", { title: "Configurar", onclick: (e: Event) => (e.stopPropagation(), sceneConfig(s._id)) }, "⚙"),
      h("button.icon.small", {
        title: "Apagar",
        onclick: async (e: Event) => {
          e.stopPropagation();
          if (await confirmDialog(`Apagar a cena "${s.name}" e os seus tokens?`)) game.delete("Scene", s._id);
        }
      }, "✕")
    )));
  };
  game.on("Scene", render);
  game.on("view", render);
  game.on("ready", render);
  render();

  const add = async () => {
    const v = await prompt("Nova cena", [{ name: "name", label: "Nome" }]);
    if (!v?.name) return;
    const [scene] = await game.create<SceneDoc>("Scene", { name: v.name });
    game.view(scene._id);
    sceneConfig(scene._id);
  };

  return h("div.panel", null,
    h("div.row.toolbar", null,
      h("button.primary", { onclick: add }, "+ Cena"),
      h("button", { title: "Levar os jogadores para a cena que estás a ver", onclick: () => game.viewedSceneId && game.pullPlayers(game.viewedSceneId) }, "Puxar jogadores")
    ),
    list
  );
}

function sceneConfig(sceneId: string): void {
  const key = `scene-${sceneId}`;
  const scene = game.get<SceneDoc>("Scene", sceneId);
  if (!scene) return;
  const body = openWindow(key, `Cena: ${scene.name}`, { width: 420 });
  if (!body) return;
  const field = (label: string, input: HTMLElement) => h("label.field", null, h("span", null, label), input);
  const name = h("input", { value: scene.name });
  const gridSize = h("input", { type: "number", min: 20, max: 500, value: String(scene.grid.size) });
  const gridAlpha = h("input", { type: "range", min: 0, max: 1, step: 0.05, value: String(scene.grid.alpha) });
  const gridColor = h("input", { type: "color", value: scene.grid.color });
  const width = h("input", { type: "number", value: String(scene.width) });
  const height = h("input", { type: "number", value: String(scene.height) });
  const bgColor = h("input", { type: "color", value: scene.backgroundColor });
  const tokenVision = h("input", { type: "checkbox", checked: scene.tokenVision });
  const fogMode = h("select", null, [[0, "Desligado"], [1, "Individual"], [2, "Partilhado"]].map(([v, l]) => h("option", { value: String(v), selected: scene.fog.mode === v }, String(l))));
  const unexplored = h("input", { type: "color", value: scene.fog.unexplored || "#000000" });
  const darkness = h("input", { type: "range", min: 0, max: 1, step: 0.05, value: String(scene.environment.darkness) });
  const globalLight = h("input", { type: "checkbox", checked: scene.environment.globalLight });
  const globalThreshold = h("input", { type: "range", min: 0, max: 1, step: 0.05, value: String(scene.environment.globalLightThreshold) });
  let img = scene.img;
  const imgLabel = h("span.muted.small.grow", null, img ? img.split("/").pop() : "sem imagem");

  const chooseImage = async () => {
    const file = await pickFile("image/*,video/webm");
    if (!file) return;
    try {
      img = await upload(file);
      imgLabel.textContent = file.name;
      const size = await imageSize(img).catch(() => null);
      if (size) {
        width.value = String(size.width);
        height.value = String(size.height);
      }
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      await game.update("Scene", {
        _id: sceneId, name: name.value.trim() || scene.name, img,
        width: Number(width.value) || scene.width, height: Number(height.value) || scene.height,
        backgroundColor: bgColor.value,
        grid: { size: Number(gridSize.value) || 100, alpha: Number(gridAlpha.value), color: gridColor.value },
        tokenVision: tokenVision.checked,
        fog: { mode: Number(fogMode.value), unexplored: unexplored.value },
        environment: { darkness: Number(darkness.value), globalLight: globalLight.checked, globalLightThreshold: Number(globalThreshold.value) }
      });
      closeWindow(key);
    }
  },
    field("Nome", name),
    h("div.field", null, h("span", null, "Fundo"), h("div.row", null, imgLabel, h("button", { type: "button", onclick: chooseImage }, "Carregar…"), img && h("button", { type: "button", onclick: () => { img = null; imgLabel.textContent = "sem imagem"; } }, "Remover"))),
    h("div.row", null, field("Largura (px)", width), field("Altura (px)", height)),
    h("div.row", null, field("Grelha (px)", gridSize), field("Cor", gridColor)),
    field("Opacidade da grelha", gridAlpha),
    field("Cor de fundo", bgColor),
    h("h4", null, "Visão e iluminação"),
    h("label.row", null, tokenVision, "Visão dos tokens (os jogadores só veem o que os seus tokens veem)"),
    h("div.row", null, field("Nevoeiro de guerra", fogMode), field("Cor do inexplorado", unexplored)),
    field("Escuridão", darkness),
    h("label.row", null, globalLight, "Iluminação global"),
    field("…enquanto a escuridão for no máximo", globalThreshold),
    h("div.row.end", null, h("button.primary", { type: "submit" }, "Guardar"))
  ));
}

// ---------------------------------------------------------------------------
// Journal

export function journalPanel(): HTMLElement {
  const list = h("ul.doc-list");
  const render = () => {
    const entries = game.all<JournalEntryDoc>("JournalEntry").sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"));
    list.replaceChildren(...entries.map(j => h("li", { onclick: () => openJournal(j._id) },
      h("span.grow", null, j.name),
      game.isGM && (j.ownership.default ?? 0) >= OWNERSHIP.LIMITED && h("span.tag", null, "partilhado")
    )));
    if (!entries.length) list.append(h("li.muted", null, "Sem entradas."));
  };
  game.on("JournalEntry", render);
  game.on("ready", render);
  render();

  const add = async () => {
    const v = await prompt("Nova entrada", [{ name: "name", label: "Título" }]);
    if (!v?.name) return;
    const [entry] = await game.create<JournalEntryDoc>("JournalEntry", { name: v.name, content: "<p></p>" });
    openJournal(entry._id, true);
  };

  return h("div.panel", null, game.isGM && h("div.row.toolbar", null, h("button.primary", { onclick: add }, "+ Entrada")), list);
}

function openJournal(id: string, startEditing = false): void {
  const key = `journal-${id}`;
  let off = () => {};
  const body = openWindow(key, game.get<JournalEntryDoc>("JournalEntry", id)?.name ?? "", { width: 620, onClose: () => off() });
  if (!body) return;
  let editing = startEditing;

  const render = () => {
    const j = game.get<JournalEntryDoc>("JournalEntry", id);
    if (!j) return closeWindow(key);
    setWindowTitle(key, j.name);
    const content = h("div.prose.journal", { contentEditable: editing ? "true" : "false" }, safeHtml(j.content));
    const shared = (j.ownership.default ?? 0) >= OWNERSHIP.LIMITED;
    body.replaceChildren(...[
      game.isGM ? h("div.row.toolbar", null,
        editing
          ? h("button.primary", { onclick: async () => { await game.update("JournalEntry", { _id: id, content: content.innerHTML }); editing = false; render(); } }, "Guardar")
          : h("button", { onclick: () => { editing = true; render(); } }, "Editar"),
        h("button", {
          onclick: () => game.update("JournalEntry", { _id: id, "ownership.default": shared ? OWNERSHIP.NONE : OWNERSHIP.OBSERVER })
        }, shared ? "Deixar de partilhar" : "Partilhar com todos"),
        h("span.grow"),
        h("button.danger", { onclick: async () => { if (await confirmDialog(`Apagar "${j.name}"?`)) game.delete("JournalEntry", id); } }, "Apagar")
      ) : null,
      content,
      game.isGM ? ownershipEditor(j, "JournalEntry") : null
    ].filter((n): n is HTMLElement => !!n));
    if (editing) content.focus();
  };
  off = game.on("JournalEntry", e => {
    if (e.ids.includes(id) && !editing) render();
    if (e.op === "delete" && e.ids.includes(id)) closeWindow(key);
  });
  render();
}

// ---------------------------------------------------------------------------
// Players (GM)

export function playersPanel(): HTMLElement {
  const list = h("ul.doc-list");
  const render = () => {
    const users = game.all<UserDoc & { hasPassword?: boolean }>("User");
    const actors = game.all<ActorDoc>("Actor");
    list.replaceChildren(...users.map(u => h("li.user-row", null,
      h("span.dot", { className: game.online.includes(u._id) ? "dot on" : "dot", style: { background: u.color } }),
      h("span.grow", null, u.name, u.role === "gm" ? " (mestre)" : ""),
      u.role !== "gm" && h("select", {
        title: "Personagem",
        onchange: (e: Event) => game.update("User", { _id: u._id, character: (e.target as HTMLSelectElement).value || null })
      }, h("option", { value: "" }, "— personagem —"), actors.map(a => h("option", { value: a._id, selected: u.character === a._id }, a.name))),
      h("button.small", {
        title: u.hasPassword ? "Mudar palavra-passe" : "Sem palavra-passe! Definir uma",
        className: u.hasPassword ? "small" : "small warn",
        onclick: async () => {
          const v = await prompt(`Palavra-passe de ${u.name}`, [{ name: "password", label: "Nova palavra-passe (vazio = nenhuma)", type: "password" }]);
          if (v) game.update("User", { _id: u._id, password: v.password });
        }
      }, "🔑"),
      u._id !== game.userId && h("button.icon.small", {
        title: "Apagar",
        onclick: async () => { if (await confirmDialog(`Apagar o utilizador "${u.name}"?`)) game.delete("User", u._id); }
      }, "✕")
    )));
  };
  game.on("User", render);
  game.on("Actor", render);
  game.on("presence", render);
  game.on("ready", render);
  render();

  const add = async () => {
    const v = await prompt("Novo jogador", [{ name: "name", label: "Nome" }, { name: "password", label: "Palavra-passe", type: "password" }]);
    if (!v?.name) return;
    await game.create("User", { name: v.name, role: "player", color: randomColor(), password: v.password });
  };

  return h("div.panel", null, h("div.row.toolbar", null, h("button.primary", { onclick: add }, "+ Jogador")), list);
}

function randomColor(): string {
  return "#" + Array.from(crypto.getRandomValues(new Uint8Array(3)), b => (96 + (b % 160)).toString(16).padStart(2, "0")).join("");
}
