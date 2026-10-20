import type { ActorDoc, ItemDoc, JournalEntryDoc, LevelDoc, SceneDoc, UserDoc } from "../../../shared/protocol.ts";
import { sceneLevels } from "../../../shared/levels.ts";
import { ITEM_TYPES, itemTemplate } from "../../../shared/ordem.ts";
import { OWNERSHIP } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { avatar, h, imageSize, pickFile, safeHtml, setChildren, upload } from "../dom.ts";
import { ITEM_DRAG, openSheet, ownershipEditor } from "./sheet.ts";
import { openItemSheet } from "./item-sheet.ts";
import { directory } from "./directory.ts";
import { closeWindow, confirmDialog, openWindow, prompt, setWindowTitle } from "./windows.ts";

// ---------------------------------------------------------------------------
// Actors

export function actorsPanel(): HTMLElement {
  const dir = directory<ActorDoc>({
    type: "Actor",
    create: { label: "Criar ator", icon: "fa-solid fa-user", run: () => add() },
    docs: () => game.all<ActorDoc>("Actor"),
    empty: "Sem atores.",
    onOpen: a => openSheet(a._id),
    dragData: (a, dt) => dt.setData("application/x-mesa-actor", a._id),
    entry: a => [
      avatar(a.img, a.name, 44),
      h("span.grow", null, a.name),
      h("span.muted.small", null, a.type),
      game.isGM && h("button.icon.small", {
        title: "Apagar",
        onclick: async (e: Event) => {
          e.stopPropagation();
          if (await confirmDialog(`Apagar "${a.name}"?`)) game.delete("Actor", a._id);
        }
      }, "✕")
    ]
  });

  const add = async () => {
    const v = await prompt("Novo ator", [{ name: "name", label: "Nome" }, { name: "type", label: "Tipo (agent / threat)", value: "agent" }]);
    if (!v?.name) return;
    const agent = v.type !== "threat";
    const [actor] = await game.create<ActorDoc>("Actor", {
      name: v.name, type: agent ? "agent" : "threat", system: blankAgent(),
      // Agents are player characters: linked tokens that see; threats are copies.
      token: agent
        ? { actorLink: true, disposition: 1, sight: { enabled: true, range: 0, angle: 360 }, bar1: { attribute: "PV" }, bar2: { attribute: "SAN" } }
        : { actorLink: false, disposition: -1, bar1: { attribute: "PV" } }
    });
    openSheet(actor._id);
  };

  return h("div.panel", null, dir.element);
}

// ---------------------------------------------------------------------------
// Items

export function itemsPanel(): HTMLElement {
  const dir = directory<ItemDoc>({
    type: "Item",
    create: { label: "Criar item", icon: "fa-solid fa-suitcase", run: () => add() },
    docs: () => game.all<ItemDoc>("Item").filter(i => !i._parent),
    empty: game.isGM ? "Sem itens. Cria um com + Item." : "O mestre ainda não partilhou itens.",
    onOpen: i => openItemSheet(i._id),
    dragData: (i, dt) => dt.setData(ITEM_DRAG, JSON.stringify({ id: i._id })),
    entry: i => [
      avatar(i.img, i.name, 36),
      h("span.grow", null, i.name),
      h("span.muted.small", null, ITEM_TYPES.find(([t]) => t === i.type)?.[1] ?? i.type),
      game.isGM && h("button.icon.small", {
        title: "Apagar",
        onclick: async (e: Event) => {
          e.stopPropagation();
          if (await confirmDialog(`Apagar "${i.name}"?`)) game.delete("Item", i._id);
        }
      }, "✕")
    ]
  });
  const add = async () => {
    const v = await prompt("Novo item", [{ name: "name", label: "Nome" }]);
    if (!v?.name) return;
    const [item] = await game.create<ItemDoc>("Item", { name: v.name, type: "generalEquipment", system: itemTemplate("generalEquipment") });
    if (item) openItemSheet(item._id);
  };
  return h("div.panel", null, dir.element);
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
  const dir = directory<SceneDoc>({
    type: "Scene",
    create: { label: "Criar cena", icon: "fa-solid fa-map", run: () => add() },
    banner: s => s.img,
    docs: () => game.all<SceneDoc>("Scene"),
    empty: "Sem cenas.",
    sort: (a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"),
    rowClass: s => (s._id === game.viewedSceneId ? "current" : ""),
    onOpen: s => game.view(s._id),
    entry: s => [
      h("span.grow.scene-title", null, s.active ? h("i.fa-solid.fa-bullseye", { title: "Ativa" }) : null, " ", s.name),
      !s.active && h("button.small", { title: "Ativar para todos", onclick: (e: Event) => (e.stopPropagation(), game.update("Scene", { _id: s._id, active: true })) }, "Ativar"),
      h("button.icon.small", { title: "Configurar", onclick: (e: Event) => (e.stopPropagation(), sceneConfig(s._id)) }, "⚙"),
      h("button.icon.small", {
        title: "Apagar",
        onclick: async (e: Event) => {
          e.stopPropagation();
          if (await confirmDialog(`Apagar a cena "${s.name}" e os seus tokens?`)) game.delete("Scene", s._id);
        }
      }, "✕")
    ]
  });
  game.on("view", dir.render);
  const list = dir.element;

  const add = async () => {
    const v = await prompt("Nova cena", [{ name: "name", label: "Nome" }]);
    if (!v?.name) return;
    const [scene] = await game.create<SceneDoc>("Scene", { name: v.name });
    game.view(scene._id);
    sceneConfig(scene._id);
  };

  return h("div.panel", null,
    h("div.row.toolbar", null,
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
  ), levelsEditor(sceneId));
}

/**
 * Levels (floors) of a scene, edited live: each has a name, an elevation band and its own background.
 * With levels, the scene's own background is not used.
 */
function levelsEditor(sceneId: string): HTMLElement {
  const host = h("div.stack.levels-editor");
  const render = () => {
    const scene = game.get<SceneDoc>("Scene", sceneId);
    if (!scene) return;
    const levels = sceneLevels(sceneId, game);
    const row = (l: LevelDoc) => {
      const upd = (changes: Record<string, unknown>) => game.update("Level", { _id: l._id, ...changes }, sceneId);
      const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
      return h("div.level-row", null,
        h("input.grow", { value: l.name, onchange: (e: Event) => upd({ name: (e.target as HTMLInputElement).value.trim() || l.name }) }),
        h("input", { type: "number", value: l.elevation.bottom ?? "", placeholder: "−∞", title: "Elevação de baixo", style: { width: "64px" },
          onchange: (e: Event) => upd({ "elevation.bottom": numOrNull((e.target as HTMLInputElement).value) }) }),
        h("input", { type: "number", value: l.elevation.top ?? "", placeholder: "∞", title: "Elevação de cima", style: { width: "64px" },
          onchange: (e: Event) => upd({ "elevation.top": numOrNull((e.target as HTMLInputElement).value) }) }),
        h("button.small", {
          type: "button", title: l.background.src ? `Fundo: ${l.background.src.split("/").pop()}` : "Escolher fundo",
          onclick: async () => {
            const file = await pickFile("image/*,video/webm");
            if (!file) return;
            try {
              const src = await upload(file);
              await upd({ "background.src": src });
              const size = await imageSize(src).catch(() => null);
              if (size && levels.length === 1) game.update("Scene", { _id: sceneId, width: size.width, height: size.height });
            } catch (err) {
              toast((err as Error).message, "error");
            }
          }
        }, l.background.src ? "🖼" : "＋🖼"),
        h("button.icon.small", { type: "button", title: "Ver este nível", onclick: () => game.view(sceneId, l._id) }, h("i.fa-solid.fa-eye")),
        h("button.icon.small", {
          type: "button", title: "Apagar nível",
          onclick: async () => { if (await confirmDialog(`Apagar o nível "${l.name}"?`)) game.delete("Level", l._id, sceneId); }
        }, "✕")
      );
    };
    setChildren(host,
      h("h4", null, "Níveis (andares)"),
      levels.length ? h("div.muted.small", null, "Nome · elevação de baixo · de cima · fundo") : h("p.muted.small", null, "Sem níveis: a cena usa o fundo acima. Cria níveis para cenas com vários andares."),
      ...[...levels].reverse().map(row),
      levels.length > 1 && h("label.field", null, h("span", null, "Nível inicial"), h("select", {
        onchange: (e: Event) => game.update("Scene", { _id: sceneId, initialLevel: (e.target as HTMLSelectElement).value || null })
      }, h("option", { value: "" }, "— o mais baixo —"), levels.map(l => h("option", { value: l._id, selected: scene.initialLevel === l._id }, l.name)))),
      h("div.row.end", null, h("button", {
        type: "button",
        onclick: () => {
          const top = levels.at(-1);
          const bottom = top ? (top.elevation.top ?? (top.elevation.bottom ?? 0) + 10) : 0;
          // The first level inherits the scene's background so nothing visibly changes.
          game.create("Level", {
            name: levels.length ? `Andar ${levels.length + 1}` : "R/C",
            elevation: { bottom, top: bottom + 10 },
            background: { src: levels.length ? null : scene.img, color: scene.backgroundColor },
            sort: levels.length
          }, sceneId);
        }
      }, "+ Nível"))
    );
  };
  const offs = [game.on("Level", render), game.on("Scene", render)];
  const observer = new MutationObserver(() => {
    if (!host.isConnected) {
      offs.forEach(o => o());
      observer.disconnect();
    }
  });
  setTimeout(() => host.parentElement && observer.observe(document.body, { childList: true, subtree: true }));
  render();
  return host;
}

// ---------------------------------------------------------------------------
// Journal

export function journalPanel(): HTMLElement {
  const dir = directory<JournalEntryDoc>({
    type: "JournalEntry",
    create: { label: "Criar entrada", icon: "fa-solid fa-book-open", run: () => add() },
    docs: () => game.all<JournalEntryDoc>("JournalEntry"),
    empty: "Sem entradas.",
    sort: (a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"),
    onOpen: j => openJournal(j._id),
    entry: j => [
      h("span.grow", null, j.name),
      game.isGM && (j.ownership.default ?? 0) >= OWNERSHIP.LIMITED && h("span.tag", null, "partilhado")
    ]
  });

  const add = async () => {
    const v = await prompt("Nova entrada", [{ name: "name", label: "Título" }]);
    if (!v?.name) return;
    const [entry] = await game.create<JournalEntryDoc>("JournalEntry", { name: v.name, content: "<p></p>" });
    openJournal(entry._id, true);
  };

  return h("div.panel", null, dir.element);
}

export function openJournal(id: string, startEditing = false): void {
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
