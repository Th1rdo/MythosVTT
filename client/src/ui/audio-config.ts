import type { AmbientSoundDoc, AudioChannel, PlaylistDoc, PlaylistSoundDoc, SoundEffectType } from "../../../shared/protocol.ts";
import { AUDIO_CHANNELS, OWNERSHIP } from "../../../shared/protocol.ts";
import { game, toast } from "../game.ts";
import { h, upload } from "../dom.ts";
import { browseButton } from "./file-picker.ts";
import { closeWindow, confirmDialog, openWindow } from "./windows.ts";
import { levelsField } from "./canvas-config.ts";
import { audio } from "../audio/engine.ts";

export const AUDIO_ACCEPT = ".mp3,.ogg,.wav,.webm,.m4a,audio/*";
export const CHANNEL_LABELS: Record<AudioChannel, string> = { music: "Música", environment: "Ambiente", interface: "Interface" };
const EFFECT_OPTIONS: [string, string][] = [["", "Nenhum"], ["lowpass", "Abafado (passa-baixo)"], ["highpass", "Fino (passa-alto)"], ["reverb", "Eco (reverberação)"]];

function field(label: string, input: HTMLElement): HTMLElement {
  return h("label.field", null, h("span", null, label), input);
}

function select(options: [number | string, string][], value: number | string): HTMLSelectElement {
  return h("select", null, options.map(([v, l]) => h("option", { value: String(v), selected: String(v) === String(value) }, l)));
}

function num(value: number, attrs: Record<string, unknown> = {}): HTMLInputElement {
  return h("input", { type: "number", value: String(value), step: "any", ...attrs });
}

/** 0–1 slider with a percentage next to it. */
function percentSlider(value: number): { node: HTMLElement; read: () => number } {
  const input = h("input", { type: "range", min: 0, max: 1, step: 0.01, value: String(value) });
  const label = h("span.scale-value", null, `${Math.round(value * 100)}%`);
  input.addEventListener("input", () => (label.textContent = `${Math.round(Number(input.value) * 100)}%`));
  return { node: h("div.row", null, input, label), read: () => Number(input.value) };
}

/** Path to an audio file: type it, upload one, or listen to it. */
export function audioPathField(value: string | null, onUpload?: (path: string, fileName: string) => void): { node: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { value: value ?? "", placeholder: "/assets/… ou URL" });
  const choose = browseButton(input, "audio", path => onUpload?.(path, path.split("/").pop() ?? path));
  const listen = h("button", {
    type: "button", title: "Ouvir",
    onclick: () => input.value && audio.playOnce(input.value, { channel: "interface", volume: 0.8 })
  }, h("i.fa-solid.fa-headphones"));
  return { node: h("div.row", null, input, choose, listen), input };
}

export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise(resolve => {
    const input = h("input", { type: "file", accept, multiple });
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.click();
  });
}

/** A file name as a track title: "02 - Dark_Forest.mp3" → "02 - Dark Forest". */
export function titleFromFile(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").trim() || "Faixa";
}

export function openAmbientSoundConfig(soundId: string, sceneId: string): void {
  const key = `ambient-sound-${soundId}`;
  const s = game.get<AmbientSoundDoc>("AmbientSound", soundId);
  const scene = game.get("Scene", sceneId) as { grid: { units: string } } | undefined;
  if (!s || !scene) return;
  const body = openWindow(key, "Som ambiente", { width: 420 });
  if (!body) return;
  const name = h("input", { value: s.name ?? "" });
  const path = audioPathField(s.path, (_, file) => { if (!name.value) name.value = titleFromFile(file); });
  const radius = num(s.radius, { min: 0 });
  const elevation = num(s.elevation ?? 0);
  const volume = percentSlider(s.volume);
  const repeat = h("input", { type: "checkbox", checked: s.repeat });
  const walls = h("input", { type: "checkbox", checked: s.walls });
  const easing = h("input", { type: "checkbox", checked: s.easing });
  const hidden = h("input", { type: "checkbox", checked: s.hidden });
  const locked = h("input", { type: "checkbox", checked: s.locked });
  const dmin = num(s.darkness?.min ?? 0, { min: 0, max: 1, step: 0.05 });
  const dmax = num(s.darkness?.max ?? 1, { min: 0, max: 1, step: 0.05 });
  const baseType = select(EFFECT_OPTIONS, s.effects?.base?.type ?? "");
  const baseI = num(s.effects?.base?.intensity ?? 5, { min: 1, max: 10, step: 1 });
  const mufType = select(EFFECT_OPTIONS, s.effects?.muffled?.type ?? "");
  const mufI = num(s.effects?.muffled?.intensity ?? 5, { min: 1, max: 10, step: 1 });
  const soundLevels = levelsField(sceneId, s.levels ?? []);
  const clampI = (v: string) => Math.min(10, Math.max(1, Math.round(Number(v) || 5)));
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      await game.update("AmbientSound", {
        _id: soundId, name: name.value.trim(), path: path.input.value.trim() || null,
        radius: Math.max(0, Number(radius.value) || 0), elevation: Number(elevation.value) || 0, volume: volume.read(),
        repeat: repeat.checked, walls: walls.checked, easing: easing.checked, hidden: hidden.checked, locked: locked.checked,
        darkness: { min: Math.min(1, Math.max(0, Number(dmin.value) || 0)), max: Math.min(1, Math.max(0, Number(dmax.value))) },
        effects: {
          base: { type: (baseType.value || null) as SoundEffectType | null, intensity: clampI(baseI.value) },
          muffled: { type: (mufType.value || null) as SoundEffectType | null, intensity: clampI(mufI.value) }
        },
        levels: soundLevels.read()
      }, sceneId);
      closeWindow(key);
    }
  },
    field("Nome", name),
    field("Ficheiro de áudio", path.node),
    h("div.cols2", null, field(`Raio (${scene.grid.units})`, radius), field("Elevação", elevation)),
    field("Volume", volume.node),
    h("label.row", null, repeat, "Repetir em ciclo"),
    h("label.row", null, walls, "Paredes bloqueiam o som (desligado: só o abafam)"),
    h("label.row", null, easing, "Diminuir com a distância"),
    h("div.cols2", null, field("Escuridão mínima", dmin), field("Escuridão máxima", dmax)),
    h("div.cols2", null, field("Efeito", baseType), field("Intensidade (1–10)", baseI)),
    h("div.cols2", null, field("Efeito atrás de paredes", mufType), field("Intensidade (1–10)", mufI)),
    soundLevels.node,
    h("label.row", null, hidden, "Desligado"),
    h("label.row", null, locked, "Trancado (não se move por engano)"),
    h("div.row.end", null,
      h("button.danger", { type: "button", onclick: () => { game.delete("AmbientSound", soundId, sceneId); closeWindow(key); } }, "Apagar"),
      h("button.primary", { type: "submit" }, "Guardar"))
  ));
}

const MODE_OPTIONS: [number, string][] = [[0, "Sequencial"], [1, "Aleatório"], [2, "Simultâneo"], [-1, "Desligado (só mesa de sons)"]];

/** Create (no id) or edit a playlist. */
export function openPlaylistConfig(playlistId?: string): void {
  const key = `playlist-${playlistId ?? "new"}`;
  const p = playlistId ? game.get<PlaylistDoc>("Playlist", playlistId) : undefined;
  if (playlistId && !p) return;
  const body = openWindow(key, p ? `Playlist: ${p.name}` : "Nova playlist", { width: 400 });
  if (!body) return;
  const name = h("input", { value: p?.name ?? "", required: true });
  const description = h("textarea", { rows: 2, value: p?.description ?? "" });
  const mode = select(MODE_OPTIONS, p?.mode ?? 0);
  const channel = select(AUDIO_CHANNELS.map(c => [c, CHANNEL_LABELS[c]]), p?.channel ?? "music");
  const sorting = select([["a", "Alfabética"], ["m", "Manual"]], p?.sorting ?? "a");
  const fade = num((p?.fade ?? 0) / 1000, { min: 0, max: 60, step: 0.5 });
  const shared = h("input", { type: "checkbox", checked: (p?.ownership?.default ?? 0) >= OWNERSHIP.OWNER });
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const fadeMs = Math.round((Number(fade.value) || 0) * 1000);
      const data = {
        name: name.value.trim() || "Playlist", description: description.value, mode: Number(mode.value), channel: channel.value,
        sorting: sorting.value, fade: fadeMs || null,
        ownership: { ...(p?.ownership ?? {}), default: shared.checked ? OWNERSHIP.OWNER : OWNERSHIP.NONE }
      };
      if (p) {
        // Changing mode or channel stops playback so nothing keeps playing on the old settings.
        if ((data.mode !== p.mode || data.channel !== p.channel) && p.playing) {
          await game.socket.timeout(10_000).emitWithAck("playlist", { action: "stopAll", playlistId: p._id });
        }
        await game.update("Playlist", { _id: p._id, ...data });
      } else await game.create("Playlist", { ...data, sort: Date.now() });
      closeWindow(key);
    }
  },
    field("Nome", name),
    field("Descrição", description),
    h("div.cols2", null, field("Modo", mode), field("Canal de volume", channel)),
    h("div.cols2", null, field("Ordenação", sorting), field("Transição (segundos)", fade)),
    h("label.row", null, shared, "Os jogadores podem controlar esta playlist"),
    h("div.row.end", null,
      p && h("button.danger", {
        type: "button",
        onclick: async () => {
          if (!(await confirmDialog(`Apagar a playlist "${p.name}" e as suas faixas?`))) return;
          await game.delete("Playlist", p._id);
          closeWindow(key);
        }
      }, "Apagar"),
      h("button.primary", { type: "submit" }, p ? "Guardar" : "Criar"))
  ));
  name.focus();
}

/** Create (no soundId) or edit a track. */
export function openPlaylistSoundConfig(playlistId: string, soundId?: string): void {
  const key = `playlist-sound-${soundId ?? `new-${playlistId}`}`;
  const s = soundId ? game.get<PlaylistSoundDoc>("PlaylistSound", soundId) : undefined;
  const playlist = game.get<PlaylistDoc>("Playlist", playlistId);
  if (!playlist || (soundId && !s)) return;
  const body = openWindow(key, s ? `Faixa: ${s.name}` : `Nova faixa em ${playlist.name}`, { width: 400 });
  if (!body) return;
  const name = h("input", { value: s?.name ?? "" });
  const path = audioPathField(s?.path ?? null, (_, file) => { if (!name.value) name.value = titleFromFile(file); });
  const description = h("textarea", { rows: 2, value: s?.description ?? "" });
  const channel = select([["", `Da playlist (${CHANNEL_LABELS[playlist.channel]})`], ...AUDIO_CHANNELS.map(c => [c, CHANNEL_LABELS[c]] as [string, string])], s?.channel ?? "");
  const volume = percentSlider(s?.volume ?? 0.5);
  const repeat = h("input", { type: "checkbox", checked: s?.repeat ?? false });
  const fade = num(s?.fade != null ? s.fade / 1000 : 0, { min: 0, max: 60, step: 0.5 });
  body.append(h("form.stack", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const src = path.input.value.trim();
      if (!src) return toast("Escolhe um ficheiro de áudio", "error");
      const fadeMs = Math.round((Number(fade.value) || 0) * 1000);
      const data = {
        name: name.value.trim() || titleFromFile(src.split("/").pop() ?? ""), path: src, description: description.value,
        channel: channel.value, volume: volume.read(), repeat: repeat.checked, fade: fadeMs || null
      };
      if (s) await game.update("PlaylistSound", { _id: s._id, ...data }, playlistId);
      else await game.create("PlaylistSound", { ...data, sort: Date.now() }, playlistId);
      closeWindow(key);
    }
  },
    field("Nome", name),
    field("Ficheiro de áudio", path.node),
    field("Descrição", description),
    field("Canal de volume", channel),
    field("Volume", volume.node),
    h("div.cols2", null, field("Transição (segundos, 0 = da playlist)", fade), h("label.row", null, repeat, "Repetir")),
    h("div.row.end", null,
      s && h("button.danger", { type: "button", onclick: () => { game.delete("PlaylistSound", s._id, playlistId); closeWindow(key); } }, "Apagar"),
      h("button.primary", { type: "submit" }, s ? "Guardar" : "Adicionar"))
  ));
}

/** Upload several files at once as new tracks of a playlist. */
export async function importTracks(playlistId: string): Promise<void> {
  const files = await pickFiles(AUDIO_ACCEPT, true);
  if (!files.length) return;
  toast(`A carregar ${files.length} ficheiro(s)…`);
  const data: Record<string, unknown>[] = [];
  for (const [i, file] of files.entries()) {
    try {
      data.push({ name: titleFromFile(file.name), path: await upload(file), sort: Date.now() + i });
    } catch (err) {
      toast(`${file.name}: ${(err as Error).message}`, "error");
    }
  }
  if (data.length) await game.create("PlaylistSound", data, playlistId);
}

/** The three per-browser volume sliders (music / environment / interface). */
export function volumeControls(): HTMLElement {
  const box = h("div.audio-volumes");
  const render = () => {
    box.replaceChildren(...AUDIO_CHANNELS.map(c => {
      const input = h("input", {
        type: "range", min: 0, max: 1, step: 0.01, value: String(audio.settings[c]),
        title: `${CHANNEL_LABELS[c]}: ${Math.round(audio.settings[c] * 100)}%`,
        oninput: (e: Event) => audio.setVolume(c, Number((e.target as HTMLInputElement).value))
      });
      const icon = { music: "fa-solid fa-music", environment: "fa-solid fa-tree", interface: "fa-solid fa-bell" }[c];
      return h("label.audio-volume", null, h("i", { className: icon, title: CHANNEL_LABELS[c] }), h("span", null, CHANNEL_LABELS[c]), input);
    }));
  };
  // Re-render only on changes from elsewhere (mute button), not while dragging this slider.
  audio.onChange(() => {
    if (!box.contains(document.activeElement)) render();
  });
  render();
  return box;
}
