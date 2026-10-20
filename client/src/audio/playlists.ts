import type { PlaylistAction, PlaylistDoc, PlaylistSoundDoc } from "../../../shared/protocol.ts";
import { playbackPosition } from "../../../shared/audio.ts";
import { game, toast } from "../game.ts";
import { audio, Track } from "./engine.ts";

interface Playing {
  track: Track;
  /** Identifies the playback (the server re-stamps it when a track restarts). */
  startedAt: number | null;
  path: string;
  fadeOutTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Plays whatever the playlists say is playing. The server decides; this only follows: start at the
 * position given by the server clock, cross-fade, loop, and report when a track reaches its end.
 */
export class PlaylistPlayer {
  #playing = new Map<string, Playing>();

  constructor() {
    game.on("PlaylistSound", () => this.syncAll());
    game.on("Playlist", () => this.syncAll());
    game.on("ready", () => {
      this.#syncClock();
      this.syncAll();
    });
    setInterval(() => this.#syncClock(), 60_000);
  }

  async #syncClock(): Promise<void> {
    try {
      const t0 = Date.now();
      const server: number = await game.socket.timeout(5000).emitWithAck("time");
      audio.setClockOffset(server - (t0 + Date.now()) / 2);
    } catch {
      // Keep the previous offset.
    }
  }

  syncAll(): void {
    if (audio.locked) {
      audio.whenReady(() => this.syncAll());
      return;
    }
    const sounds = game.all<PlaylistSoundDoc>("PlaylistSound");
    const live = new Set(sounds.map(s => s._id));
    for (const [id, p] of this.#playing) {
      if (!live.has(id)) this.#stop(id, p, 0);
    }
    for (const s of sounds) this.#sync(s);
  }

  #sync(sound: PlaylistSoundDoc): void {
    const playlist = game.get<PlaylistDoc>("Playlist", sound._parent);
    const current = this.#playing.get(sound._id);
    const fade = sound.fade ?? playlist?.fade ?? 0;
    if (!playlist || !sound.playing || !sound.path) {
      // A pause cuts immediately (so it resumes from the same spot); a stop fades out.
      if (current) this.#stop(sound._id, current, sound.pausedTime ? 0 : fade);
      return;
    }
    if (current && current.startedAt === sound.startedAt && current.path === sound.path) {
      current.track.el.loop = sound.repeat;
      current.track.fade(sound.volume, 500);
      this.#scheduleFadeOut(sound, current, fade);
      return;
    }
    if (current) this.#stop(sound._id, current, fade);
    const track = new Track(audio, sound.path, sound.channel || playlist.channel);
    const entry: Playing = { track, startedAt: sound.startedAt, path: sound.path, fadeOutTimer: null };
    this.#playing.set(sound._id, entry);
    track.onEnded = () => {
      this.#playing.delete(sound._id);
      track.dispose();
      this.request({ action: "ended", playlistId: playlist._id, soundId: sound._id, startedAt: entry.startedAt });
    };
    track.duration().then(duration => {
      if (track.disposed) return;
      const offset = playbackPosition(sound, audio.serverNow(), duration);
      if (offset === null) return track.onEnded?.(); // Finished before we got here.
      track.play({ offset, volume: sound.volume, loop: sound.repeat, fade }).then(() => this.#scheduleFadeOut(sound, entry, fade));
    });
  }

  /** Non-looping tracks with a fade start fading out `fade` ms before they end. */
  #scheduleFadeOut(sound: PlaylistSoundDoc, p: Playing, fade: number): void {
    if (p.fadeOutTimer) clearTimeout(p.fadeOutTimer);
    p.fadeOutTimer = null;
    const d = p.track.el.duration;
    if (sound.repeat || !fade || !Number.isFinite(d)) return;
    const left = (d - p.track.el.currentTime) * 1000 - fade;
    p.fadeOutTimer = setTimeout(() => p.track.fade(0, fade), Math.max(0, left));
  }

  #stop(id: string, p: Playing, fade: number): void {
    if (p.fadeOutTimer) clearTimeout(p.fadeOutTimer);
    p.track.stop(fade);
    this.#playing.delete(id);
  }

  /** Current position (seconds) and length of a track this browser is playing. */
  progress(soundId: string): { time: number; duration: number } | null {
    const p = this.#playing.get(soundId);
    if (!p) return null;
    return { time: p.track.el.currentTime, duration: p.track.el.duration };
  }

  async request(action: PlaylistAction): Promise<void> {
    const res = await game.socket.timeout(10_000).emitWithAck("playlist", action);
    if (!res.ok && action.action !== "ended") toast(res.error, "error");
  }
}
