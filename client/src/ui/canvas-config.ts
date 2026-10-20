import type { ActorDoc, AmbientLightDoc, LightConfig, TileDoc, TokenDoc, WallDoc } from "../../../shared/protocol.ts";
import { sceneLevels } from "../../../shared/levels.ts";
import { game } from "../game.ts";
import { h } from "../dom.ts";
import { closeWindow, openWindow } from "./windows.ts";

const SENSE_OPTIONS: [number, string][] = [[0, "Nenhuma"], [10, "Limitada"], [20, "Normal"]];

function field(label: string, input: HTMLElement): HTMLElement {
  return h("label.field", null, h("span", null, label), input);
}

function select(options: [number | string, string][], value: number | string): HTMLSelectElement {
  return h("select", null, options.map(([v, l]) => h("option", { value: String(v), selected: v === value }, l)));
}

function num(value: number, attrs: Record<string, unknown> = {}): HTMLInputElement {
  return h("input", { type: "number", value: String(value), step: "any", ...attrs });
}

export function openWallConfig(wallId: string, sceneId: string): void {
  const key = `wall-${wallId}`;
  const w = game.get<WallDoc>("Wall", wallId);
  if (!w) return;
  const body = openWindow(key, "Parede", { width: 340 });
  if (!body) return;
  const move = select([[0, "Não bloqueia"], [20, "Bloqueia"]], w.move);
  const sight = select(SENSE_OPTIONS, w.sight);
  const light = select(SENSE_OPTIONS, w.light);
  const sound = select(SENSE_OPTIONS, w.sound);
  const dir = select([[0, "Ambos os lados"], [1, "Só da direita"], [2, "Só da esquerda"]], w.dir);
  const door = select([[0, "Não é porta"], [1, "Porta"], [2, "Porta secreta"]], w.door);
  const ds = select([[0, "Fechada"], [1, "Aberta"], [2, "Trancada"]], w.ds);
  const wallLevels = levelsField(sceneId, w.levels ?? []);
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      await game.update("Wall", {
        _id: wallId,
        move: Number(move.value), sight: Number(sight.value), light: Number(light.value), sound: Number(sound.value),
        dir: Number(dir.value), door: Number(door.value), ds: Number(ds.value), levels: wallLevels.read()
      }, sceneId);
      closeWindow(key);
    }
  },
    h("div.row", null, field("Movimento", move), field("Visão", sight)),
    h("div.row", null, field("Luz", light), field("Som", sound)),
    field("Bloqueia a partir de", dir),
    h("div.row", null, field("Porta", door), field("Estado", ds)),
    wallLevels.node,
    h("p.muted.small", null, "Limitada = deixa passar através de uma parede destas, mas não de duas (ex.: vegetação)."),
    h("div.row.end", null, h("button.primary", { type: "submit" }, "Guardar"))
  ));
}

/** Editor for a LightConfig; returns the inputs and a reader. */
function lightFields(config: LightConfig, units: string) {
  const dim = num(config.dim, { min: 0 });
  const bright = num(config.bright, { min: 0 });
  const color = h("input", { type: "color", value: config.color ?? "#ffffff" });
  const useColor = h("input", { type: "checkbox", checked: !!config.color });
  const alpha = h("input", { type: "range", min: 0, max: 1, step: 0.05, value: String(config.alpha) });
  const angle = num(config.angle, { min: 1, max: 360 });
  const anim = select([["", "Nenhuma"], ["torch", "Tocha"], ["pulse", "Pulsar"], ["flicker", "Tremeluzir"]], config.animation?.type ?? "");
  const speed = h("input", { type: "range", min: 1, max: 10, step: 1, value: String(config.animation?.speed ?? 5) });
  const intensity = h("input", { type: "range", min: 1, max: 10, step: 1, value: String(config.animation?.intensity ?? 5) });
  const nodes = [
    h("div.row", null, field(`Raio fraco (${units})`, dim), field(`Raio forte (${units})`, bright)),
    h("div.row", null, field("Cor", h("div.row", null, useColor, color)), field("Intensidade", alpha)),
    field("Ângulo (graus)", angle),
    h("div.row", null, field("Animação", anim), field("Velocidade", speed), field("Força", intensity))
  ];
  const read = (): LightConfig => ({
    dim: Math.max(0, Number(dim.value) || 0),
    bright: Math.max(0, Number(bright.value) || 0),
    color: useColor.checked ? color.value : null,
    alpha: Number(alpha.value),
    angle: Math.min(360, Math.max(1, Number(angle.value) || 360)),
    animation: { type: (anim.value || null) as LightConfig["animation"]["type"], speed: Number(speed.value), intensity: Number(intensity.value) }
  });
  return { nodes, read };
}

export function openLightConfig(lightId: string, sceneId: string): void {
  const key = `light-${lightId}`;
  const l = game.get<AmbientLightDoc>("AmbientLight", lightId);
  const scene = game.get("Scene", sceneId) as { grid: { units: string } } | undefined;
  if (!l || !scene) return;
  const body = openWindow(key, "Luz", { width: 380 });
  if (!body) return;
  const lf = lightFields(l.config, scene.grid.units);
  const walls = h("input", { type: "checkbox", checked: l.walls });
  const hidden = h("input", { type: "checkbox", checked: l.hidden });
  const rotation = num(l.rotation, { min: 0, max: 359 });
  const lightLevels = levelsField(sceneId, l.levels ?? []);
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      await game.update("AmbientLight", { _id: lightId, config: lf.read(), walls: walls.checked, hidden: hidden.checked, rotation: Number(rotation.value) || 0, levels: lightLevels.read() }, sceneId);
      closeWindow(key);
    }
  },
    ...lf.nodes,
    field("Direção (graus)", rotation),
    h("label.row", null, walls, "Bloqueada por paredes"),
    h("label.row", null, hidden, "Desligada"),
    lightLevels.node,
    h("div.row.end", null,
      h("button.danger", { type: "button", onclick: () => { game.delete("AmbientLight", lightId, sceneId); closeWindow(key); } }, "Apagar"),
      h("button.primary", { type: "submit" }, "Guardar"))
  ));
}

const DISPLAY_OPTIONS: [number, string][] = [
  [0, "Nunca"], [10, "Quando selecionado"], [20, "Dono, ao passar o rato"], [30, "Ao passar o rato"], [40, "Sempre para o dono"], [50, "Sempre para todos"]
];

/** Attributes that look like resources ({value, max}) in an actor's system data. */
function barChoices(actorId: string | null): [string, string][] {
  const actor = actorId ? game.get<ActorDoc>("Actor", actorId) : undefined;
  const keys = Object.entries(actor?.system ?? {})
    .filter(([, v]) => v && typeof v === "object" && typeof (v as any).value === "number" && "max" in (v as any))
    .map(([k]) => [k, k] as [string, string]);
  return [["", "— nenhuma —"], ...keys];
}

type TokenSettings = Pick<TokenDoc, "width" | "height" | "disposition" | "actorLink" | "displayName" | "displayBars" | "bar1" | "bar2" | "sight" | "light">;

/** The settings form shared by placed tokens and an actor's prototype token. */
function tokenSettingsForm(
  values: TokenSettings & { name?: string; rotation?: number; elevation?: number },
  actorId: string | null,
  units: string,
  onSave: (data: Record<string, unknown>) => Promise<unknown>
): HTMLFormElement {
  const name = values.name !== undefined ? h("input", { value: values.name }) : null;
  const width = num(values.width, { min: 0.5, step: 0.5 });
  const height = num(values.height, { min: 0.5, step: 0.5 });
  const disposition = select([[-1, "Hostil"], [0, "Neutro"], [1, "Amigável"]], values.disposition);
  const rotation = values.rotation !== undefined ? num(values.rotation, { min: 0, max: 359 }) : null;
  const elevation = values.elevation !== undefined ? num(values.elevation) : null;
  const actorLink = h("input", { type: "checkbox", checked: values.actorLink });
  const displayName = select(DISPLAY_OPTIONS, values.displayName);
  const displayBars = select(DISPLAY_OPTIONS, values.displayBars);
  const bars = barChoices(actorId);
  const bar1 = select(bars, values.bar1?.attribute ?? "");
  const bar2 = select(bars, values.bar2?.attribute ?? "");
  const sightOn = h("input", { type: "checkbox", checked: values.sight.enabled });
  const sightRange = num(values.sight.range, { min: 0 });
  const sightAngle = num(values.sight.angle, { min: 1, max: 360 });
  const lf = lightFields(values.light, units);
  return h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      await onSave({
        ...(name ? { name: name.value.trim() } : {}),
        ...(rotation ? { rotation: Number(rotation.value) || 0 } : {}),
        ...(elevation ? { elevation: Number(elevation.value) || 0 } : {}),
        width: Math.max(0.5, Number(width.value) || 1),
        height: Math.max(0.5, Number(height.value) || 1),
        disposition: Number(disposition.value),
        actorLink: actorLink.checked,
        displayName: Number(displayName.value),
        displayBars: Number(displayBars.value),
        bar1: { attribute: bar1.value || null },
        bar2: { attribute: bar2.value || null },
        sight: { enabled: sightOn.checked, range: Math.max(0, Number(sightRange.value) || 0), angle: Math.min(360, Math.max(1, Number(sightAngle.value) || 360)) },
        light: lf.read()
      });
    }
  },
    name && field("Nome", name),
    h("div.row", null, field("Largura (quadrados)", width), field("Altura (quadrados)", height)),
    h("div.row", null, field("Atitude", disposition), rotation && field("Direção (graus)", rotation), elevation && field("Elevação", elevation)),
    h("label.row", null, actorLink, "Ligado ao ator (alterações no token mudam a ficha do ator)"),
    h("h4", null, "Nome e barras"),
    h("div.row", null, field("Mostrar nome", displayName), field("Mostrar barras", displayBars)),
    h("div.row", null, field("Barra 1 (em baixo)", bar1), field("Barra 2 (em cima)", bar2)),
    h("h4", null, "Visão"),
    h("label.row", null, sightOn, "Tem visão"),
    h("div.row", null, field(`Alcance no escuro (${units}, 0 = só vê o que está iluminado)`, sightRange), field("Ângulo", sightAngle)),
    h("h4", null, "Luz emitida"),
    ...lf.nodes,
    h("div.row.end", null, h("button.primary", { type: "submit" }, "Guardar"))
  );
}

export function openTokenConfig(tokenId: string, sceneId: string): void {
  const key = `token-${tokenId}`;
  const t = game.get<TokenDoc>("Token", tokenId);
  const scene = game.get("Scene", sceneId) as { grid: { units: string } } | undefined;
  if (!t || !scene) return;
  const body = openWindow(key, `Token: ${t.name}`, { width: 440 });
  if (!body) return;
  body.append(tokenSettingsForm(t, t.actorId, scene.grid.units, async data => {
    await game.update("Token", { _id: tokenId, ...data, name: (data.name as string) || t.name }, sceneId);
    closeWindow(key);
  }));
}

/** GM: the token settings new tokens of this actor start with. */
export function openPrototypeConfig(actorId: string): void {
  const key = `proto-${actorId}`;
  const actor = game.get<ActorDoc>("Actor", actorId);
  if (!actor) return;
  const units = game.viewedScene?.grid.units ?? "m";
  const body = openWindow(key, `Token de ${actor.name}`, { width: 440 });
  if (!body) return;
  body.append(
    h("p.muted.small", null, "Valores usados quando arrastas este ator para o mapa."),
    tokenSettingsForm(actor.token, actorId, units, async data => {
      await game.update("Actor", { _id: actorId, token: { ...actor.token, ...data } });
      closeWindow(key);
    })
  );
}

/** Checkboxes for which levels of the scene a placeable appears on (none ticked = all). */
export function levelsField(sceneId: string, selected: string[]): { node: HTMLElement | null; read: () => string[] } {
  const levels = sceneLevels(sceneId, game);
  if (!levels.length) return { node: null, read: () => selected };
  const boxes = levels.map(l => [l._id, h("input", { type: "checkbox", checked: selected.includes(l._id) })] as const);
  return {
    node: h("div.field", null, h("span", null, "Níveis (nenhum = todos)"),
      h("div.row.wrap", null, boxes.map(([id, box]) => h("label.row", null, box, levels.find(l => l._id === id)!.name)))),
    read: () => boxes.filter(([, b]) => b.checked).map(([id]) => id)
  };
}

export function openTileConfig(tileId: string, sceneId: string): void {
  const key = `tile-${tileId}`;
  const t = game.get<TileDoc>("Tile", tileId);
  if (!t) return;
  const body = openWindow(key, "Tile", { width: 400 });
  if (!body) return;
  const x = num(t.x), y = num(t.y), width = num(t.width, { min: 1 }), height = num(t.height, { min: 1 });
  const rotation = num(t.rotation, { min: 0, max: 359 });
  const alpha = h("input", { type: "range", min: 0, max: 1, step: 0.05, value: String(t.alpha) });
  const elevation = num(t.elevation);
  const foreground = h("input", { type: "checkbox", checked: t.foreground });
  const fade = h("input", { type: "checkbox", checked: t.occlusion.fade });
  const fadeAlpha = h("input", { type: "range", min: 0, max: 1, step: 0.05, value: String(t.occlusion.alpha) });
  const hidden = h("input", { type: "checkbox", checked: t.hidden });
  const locked = h("input", { type: "checkbox", checked: t.locked });
  const lv = levelsField(sceneId, t.levels);
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      await game.update("Tile", {
        _id: tileId, x: Number(x.value) || 0, y: Number(y.value) || 0,
        width: Math.max(1, Number(width.value) || t.width), height: Math.max(1, Number(height.value) || t.height),
        rotation: Number(rotation.value) || 0, alpha: Number(alpha.value), elevation: Number(elevation.value) || 0,
        foreground: foreground.checked, occlusion: { fade: fade.checked, alpha: Number(fadeAlpha.value) },
        hidden: hidden.checked, locked: locked.checked, levels: lv.read()
      }, sceneId);
      closeWindow(key);
    }
  },
    h("div.row", null, field("X", x), field("Y", y), field("Largura", width), field("Altura", height)),
    h("div.row", null, field("Rotação", rotation), field("Elevação", elevation), field("Opacidade", alpha)),
    h("label.row", null, foreground, "Primeiro plano (por cima dos tokens: telhados, copas)"),
    h("div.row", null, h("label.row", null, fade, "Desvanecer com token por baixo"), field("Opacidade ao desvanecer", fadeAlpha)),
    h("div.row", null, h("label.row", null, hidden, "Escondido dos jogadores"), h("label.row", null, locked, "Trancado")),
    lv.node,
    h("div.row.end", null,
      h("button.danger", { type: "button", onclick: () => { game.delete("Tile", tileId, sceneId); closeWindow(key); } }, "Apagar"),
      h("button.primary", { type: "submit" }, "Guardar"))
  ));
}
