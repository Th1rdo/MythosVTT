import type { PlaylistDoc, PlaylistSoundDoc } from "../../../shared/protocol.ts";
import { PLAYLIST_MODE } from "../../../shared/protocol.ts";
import { ownsPlaylist } from "../../../shared/permissions.ts";
import { sortedSounds } from "../../../shared/audio.ts";
import { game } from "../game.ts";
import { h } from "../dom.ts";
import { directory } from "./directory.ts";
import { importTracks, openPlaylistConfig, openPlaylistSoundConfig, volumeControls } from "./audio-config.ts";
import type { PlaylistPlayer } from "../audio/playlists.ts";
import { openContextMenu } from "./context-menu.ts";
import { deleteDoc } from "./doc-actions.ts";

const EXPANDED_KEY = "mesa.expandedPlaylists";
const MODES: Record<number, { icon: string; label: string }> = {
  [PLAYLIST_MODE.DISABLED]: { icon: "fa-solid fa-ban", label: "Desligado: só toca faixa a faixa" },
  [PLAYLIST_MODE.SEQUENTIAL]: { icon: "fa-solid fa-arrow-right-long", label: "Sequencial" },
  [PLAYLIST_MODE.SHUFFLE]: { icon: "fa-solid fa-shuffle", label: "Aleatório" },
  [PLAYLIST_MODE.SIMULTANEOUS]: { icon: "fa-solid fa-layer-group", label: "Simultâneo" }
};

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Playlists tab, like Foundry's: the volume sliders, what's playing now, then the directory. Click a
 * playlist to open its tracks. GMs (and owners) play, pause, stop, skip, change mode and volume;
 * players see only the playlists that are playing (or that they own).
 */
export function playlistsPanel(player: PlaylistPlayer): HTMLElement {
  const expanded = loadExpanded();
  const saveExpanded = () => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
    } catch {
      // Not remembered in private mode.
    }
  };
  const owns = (p: PlaylistDoc) => ownsPlaylist(p._id, game.user, game);
  const act = (action: "playAll" | "stopAll" | "next" | "previous" | "cycleMode", p: PlaylistDoc) => player.request({ action, playlistId: p._id });
  const button = (icon: string, title: string, run: () => void, cls = "") =>
    h("button.icon.small", { className: `icon small ${cls}`, title, onclick: (e: Event) => { e.stopPropagation(); run(); } }, h("i", { className: icon }));

  const timeLabel = (s: PlaylistSoundDoc) => h("span.sound-time", { dataset: { id: s._id } });

  const soundRow = (p: PlaylistDoc, s: PlaylistSoundDoc) => {
    const mine = owns(p);
    const volume = h("input.sound-volume", {
      type: "range", min: 0, max: 1, step: 0.01, value: String(s.volume), title: `Volume ${Math.round(s.volume * 100)}%`,
      onclick: (e: Event) => e.stopPropagation(),
      onchange: (e: Event) => game.update("PlaylistSound", { _id: s._id, volume: Number((e.target as HTMLInputElement).value) }, p._id)
    });
    return h("li", {
      className: `sound${s.playing ? " playing" : ""}${s.pausedTime ? " paused" : ""}`, onclick: (e: Event) => e.stopPropagation(),
      // The track's own menu wins over its playlist's (the row sits inside the playlist entry).
      oncontextmenu: (e: MouseEvent) => game.isGM && openContextMenu(e, [
        { label: "Editar faixa", icon: "fa-solid fa-pen-to-square", onClick: () => openPlaylistSoundConfig(p._id, s._id) },
        { label: s.repeat ? "Não repetir" : "Repetir", icon: "fa-solid fa-repeat", onClick: () => game.update("PlaylistSound", { _id: s._id, repeat: !s.repeat }, p._id) },
        { label: "Apagar faixa", icon: "fa-solid fa-trash", group: "delete", classes: "danger", onClick: () => deleteDoc("PlaylistSound", s._id) }
      ], s, "PlaylistSound")
    },
      h("span.grow.sound-name", { title: s.description || s.name }, s.name),
      s.playing || s.pausedTime ? timeLabel(s) : null,
      mine && h("span.hover-only", null, volume),
      mine && button(s.repeat ? "fa-solid fa-repeat" : "fa-solid fa-repeat", s.repeat ? "Repetir: ligado" : "Repetir: desligado",
        () => game.update("PlaylistSound", { _id: s._id, repeat: !s.repeat }, p._id), s.repeat ? "on" : "off"),
      mine && (s.playing
        ? button("fa-solid fa-pause", "Pausa", () => player.request({ action: "pause", playlistId: p._id, soundId: s._id }))
        : button("fa-solid fa-play", s.pausedTime ? "Continuar" : "Tocar", () => player.request({ action: "play", playlistId: p._id, soundId: s._id }))),
      mine && (s.playing || !!s.pausedTime) && button("fa-solid fa-square", "Parar", () => player.request({ action: "stop", playlistId: p._id, soundId: s._id }))
    );
  };

  const dir = directory<PlaylistDoc>({
    type: "Playlist",
    create: { label: "Criar playlist", icon: "fa-solid fa-music", run: () => openPlaylistConfig() },
    ownership: true,
    canManage: p => game.isGM && !!p,
    contextOptions: p => [
      { label: "Configurar", icon: "fa-solid fa-gear", group: "view", visible: game.isGM, onClick: () => openPlaylistConfig(p._id) },
      { label: "Adicionar faixa", icon: "fa-solid fa-plus", group: "view", visible: game.isGM, onClick: () => openPlaylistSoundConfig(p._id) },
      { label: "Importar vários ficheiros", icon: "fa-solid fa-file-import", group: "view", visible: game.isGM, onClick: () => importTracks(p._id) },
      ...([[PLAYLIST_MODE.DISABLED, "Só soundboard", "fa-solid fa-ban"], [PLAYLIST_MODE.SEQUENTIAL, "Sequencial", "fa-solid fa-arrow-right"],
        [PLAYLIST_MODE.SHUFFLE, "Aleatória", "fa-solid fa-shuffle"], [PLAYLIST_MODE.SIMULTANEOUS, "Simultânea", "fa-solid fa-layer-group"]] as const)
        .map(([mode, label, icon]) => ({
          label, icon: p.mode === mode ? "fa-solid fa-check" : icon, group: "mode", visible: owns(p),
          onClick: () => player.request({ action: "setMode", playlistId: p._id, mode })
        }))
    ],
    docs: () => game.all<PlaylistDoc>("Playlist").filter(p => owns(p) || p.playing),
    empty: game.isGM ? "Sem playlists." : "Nada a tocar.",
    sort: (a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt"),
    rowClass: p => `playlist${p.playing ? " playing" : ""}${expanded.has(p._id) ? " open" : ""}`,
    onOpen: p => {
      if (expanded.has(p._id)) expanded.delete(p._id);
      else expanded.add(p._id);
      saveExpanded();
      dir.render();
    },
    entry: p => {
      const mine = owns(p);
      const mode = MODES[p.mode] ?? MODES[0];
      const sequential = p.mode === PLAYLIST_MODE.SEQUENTIAL || p.mode === PLAYLIST_MODE.SHUFFLE;
      const sounds = sortedSounds(p, game.children<PlaylistSoundDoc>("PlaylistSound", p._id));
      return [
        h("i", { className: `fa-solid fa-caret-${expanded.has(p._id) ? "down" : "right"} caret` }),
        h("span.grow.playlist-name", null, p.name),
        mine && button(mode.icon, `Modo: ${mode.label} (clicar para mudar)`, () => act("cycleMode", p)),
        mine && p.playing && sequential && button("fa-solid fa-backward", "Faixa anterior", () => act("previous", p)),
        mine && p.playing && sequential && button("fa-solid fa-forward", "Faixa seguinte", () => act("next", p)),
        mine && p.mode !== PLAYLIST_MODE.DISABLED && (p.playing
          ? button("fa-solid fa-square", "Parar tudo", () => act("stopAll", p))
          : button("fa-solid fa-play", "Tocar tudo", () => act("playAll", p))),
        game.isGM && button("fa-solid fa-plus", "Adicionar faixa", () => openPlaylistSoundConfig(p._id), "hover-only"),
        expanded.has(p._id) || (!mine && p.playing)
          ? h("ul.doc-list.sounds", null,
            (mine ? sounds : sounds.filter(s => s.playing)).map(s => soundRow(p, s)),
            !sounds.length && h("li.muted", null, "Sem faixas."))
          : null
      ];
    }
  });

  // What's playing right now, across every playlist.
  const nowPlaying = h("section.now-playing");
  const renderNow = () => {
    const playing = game.all<PlaylistSoundDoc>("PlaylistSound").filter(s => s.playing);
    nowPlaying.hidden = !playing.length;
    nowPlaying.replaceChildren(
      h("header.now-title", null, h("i.fa-solid.fa-compact-disc"), " A tocar"),
      h("ul.doc-list.sounds", null, playing.map(s => {
        const p = game.get<PlaylistDoc>("Playlist", s._parent)!;
        const row = soundRow(p, s);
        row.querySelector(".sound-name")?.append(h("span.muted.small", null, ` · ${p?.name ?? ""}`));
        return row;
      }))
    );
  };

  const render = () => {
    dir.render();
    renderNow();
    tick();
  };
  // Positions tick once a second without re-rendering the lists.
  const tick = () => {
    for (const el of root.querySelectorAll<HTMLElement>(".sound-time")) {
      const id = el.dataset.id!;
      const s = game.get<PlaylistSoundDoc>("PlaylistSound", id);
      const prog = player.progress(id);
      el.textContent = prog ? `${formatTime(prog.time)} / ${formatTime(prog.duration)}` : s?.pausedTime ? `⏸ ${formatTime(s.pausedTime)}` : "";
    }
  };
  const root = h("div.panel.playlists-panel", null, volumeControls(), nowPlaying, dir.element);
  game.on("PlaylistSound", render);
  game.on("Playlist", renderNow);
  setInterval(tick, 1000);
  render();
  return root;
}
