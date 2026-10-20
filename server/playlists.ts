import type { PlaylistAction, PlaylistDoc, PlaylistSoundDoc, UserDoc } from "../shared/protocol.ts";
import { PLAYLIST_MODE } from "../shared/protocol.ts";
import { adjacentSound, playbackOrder, playbackPosition } from "../shared/audio.ts";
import { ownsPlaylist } from "../shared/permissions.ts";
import type { Change, World } from "./world.ts";

type SoundUpdate = { _id: string } & Partial<Pick<PlaylistSoundDoc, "playing" | "pausedTime" | "startedAt">>;

/**
 * Playlist playback runs on the server: it decides which tracks play and stamps each start with the
 * server clock, so every client (including ones that join later) hears the same thing at the same point.
 */
export function runPlaylistAction(world: World, user: UserDoc, a: PlaylistAction, now = Date.now()): Change[] {
  const playlist = world.get("Playlist", a?.playlistId) as PlaylistDoc | undefined;
  if (!playlist) throw new Error("Playlist não existe");
  // Any listener may report that a track ended; everything else needs control of the playlist.
  if (a.action !== "ended" && !ownsPlaylist(playlist._id, user, world)) throw new Error("Sem permissão");
  const sounds = world.all<PlaylistSoundDoc>("PlaylistSound").filter(s => s._parent === playlist._id);
  const sound = "soundId" in a ? sounds.find(s => s._id === a.soundId) : undefined;
  if ("soundId" in a && !sound) throw new Error("Faixa não existe");
  const sequential = playlist.mode === PLAYLIST_MODE.SEQUENTIAL || playlist.mode === PLAYLIST_MODE.SHUFFLE;

  const start = (s: PlaylistSoundDoc, keepPosition: boolean): SoundUpdate =>
    ({ _id: s._id, playing: true, startedAt: now, pausedTime: keepPosition ? s.pausedTime : null });
  const stop = (s: PlaylistSoundDoc): SoundUpdate => ({ _id: s._id, playing: false, startedAt: null, pausedTime: null });
  const othersPlaying = (id: string) => sounds.some(s => s._id !== id && s.playing);

  let playlistUpdate: Partial<PlaylistDoc> = {};
  let updates: SoundUpdate[] = [];

  /** Sequential/shuffle: exactly one track plays — `id` (or none). */
  const only = (id: string | null, keepPosition: boolean) => {
    updates = sounds.map(s => (s._id === id ? start(s, keepPosition) : stop(s)));
    playlistUpdate.playing = !!id;
  };

  switch (a.action) {
    case "playAll": {
      if (!sounds.length || playlist.mode === PLAYLIST_MODE.DISABLED) break;
      if (playlist.mode === PLAYLIST_MODE.SIMULTANEOUS) {
        updates = sounds.map(s => start(s, true));
        playlistUpdate.playing = true;
        break;
      }
      // A fresh shuffle each time the playlist starts; a paused track resumes where it was.
      const seed = Math.floor(Math.random() * 100_000);
      playlistUpdate.seed = seed;
      const paused = sounds.find(s => s.pausedTime);
      only(paused?._id ?? playbackOrder({ ...playlist, seed }, sounds)[0], true);
      break;
    }
    case "stopAll":
      updates = sounds.map(s => ({ _id: s._id, playing: false, startedAt: null }));
      playlistUpdate.playing = false;
      break;
    case "play":
      if (sequential) only(sound!._id, true);
      else {
        updates = [start(sound!, true)];
        playlistUpdate.playing = true;
      }
      break;
    case "pause":
      if (!sound!.playing) break;
      updates = [{ _id: sound!._id, playing: false, startedAt: null, pausedTime: playbackPosition(sound!, now) ?? 0 }];
      playlistUpdate.playing = othersPlaying(sound!._id);
      break;
    case "stop":
      updates = [stop(sound!)];
      playlistUpdate.playing = othersPlaying(sound!._id);
      break;
    case "next":
    case "previous": {
      if (!sequential || !playlist.playing) break;
      const current = sounds.find(s => s.playing)?._id ?? null;
      only(adjacentSound(playbackOrder(playlist, sounds), current, a.action === "next" ? 1 : -1), false);
      break;
    }
    case "cycleMode": {
      const mode = playlist.mode >= PLAYLIST_MODE.SIMULTANEOUS ? PLAYLIST_MODE.DISABLED : ((playlist.mode + 1) as PlaylistDoc["mode"]);
      playlistUpdate = { mode, playing: false };
      updates = sounds.filter(s => s.playing || s.pausedTime).map(stop);
      break;
    }
    case "ended": {
      // Every listener reports the end; only the first report for this playback counts.
      if (!sound!.playing || sound!.repeat || sound!.startedAt !== a.startedAt) break;
      if (sequential) only(adjacentSound(playbackOrder(playlist, sounds), sound!._id, 1), false);
      else {
        updates = [stop(sound!)];
        playlistUpdate.playing = othersPlaying(sound!._id);
      }
      break;
    }
    default:
      throw new Error("Ação desconhecida");
  }

  const changes: Change[] = [];
  if (Object.keys(playlistUpdate).length) {
    changes.push(...world.applyAsSystem({ op: "update", type: "Playlist", updates: [{ _id: playlist._id, ...playlistUpdate }] }));
  }
  if (updates.length) {
    changes.push(...world.applyAsSystem({ op: "update", type: "PlaylistSound", parent: playlist._id, updates }));
  }
  return changes;
}
