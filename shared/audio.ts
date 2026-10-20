import type { AmbientSoundDoc, PlaylistDoc, PlaylistSoundDoc } from "./protocol.ts";
import { PLAYLIST_MODE } from "./protocol.ts";

/**
 * Pure audio rules shared by the server (playlist sequencing) and the client (what to play, from
 * where, how loud). Nothing here touches the Web Audio API.
 */

/** Volume sliders are perceptual: slider position p plays at p^1.5 (quiet end gets more travel). */
export const VOLUME_CURVE = 1.5;
export const sliderToVolume = (p: number) => Math.pow(Math.min(1, Math.max(0, p)), VOLUME_CURVE);
export const volumeToSlider = (v: number) => Math.pow(Math.min(1, Math.max(0, v)), 1 / VOLUME_CURVE);

/** Small deterministic PRNG (mulberry32) so every client derives the same shuffle from a seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Code-point comparison: identical on every machine regardless of locale. */
const byName = (a: PlaylistSoundDoc, b: PlaylistSoundDoc) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a._id < b._id ? -1 : 1);

/** Tracks in display order (alphabetical or manual). */
export function sortedSounds(playlist: PlaylistDoc, sounds: PlaylistSoundDoc[]): PlaylistSoundDoc[] {
  const list = [...sounds];
  if (playlist.sorting === "m") return list.sort((a, b) => a.sort - b.sort || byName(a, b));
  return list.sort(byName);
}

/** The order tracks play in: display order, or a seeded shuffle of it. */
export function playbackOrder(playlist: PlaylistDoc, sounds: PlaylistSoundDoc[]): string[] {
  const ids = sortedSounds(playlist, sounds).map(s => s._id);
  if (playlist.mode !== PLAYLIST_MODE.SHUFFLE) return ids;
  const rnd = seededRandom(playlist.seed ?? 0);
  const keys = new Map(ids.map(id => [id, rnd()]));
  return ids.sort((a, b) => keys.get(a)! - keys.get(b)!);
}

/** The track after (direction 1) or before (-1) `currentId`, wrapping around. */
export function adjacentSound(order: string[], currentId: string | null, direction: 1 | -1): string | null {
  if (!order.length) return null;
  const i = currentId ? order.indexOf(currentId) : -1;
  if (direction === 1) return order[(i + 1) % order.length];
  if (i === -1) return order[order.length - 1];
  return order[(i - 1 + order.length) % order.length];
}

/**
 * Where a track is right now, in seconds, given the server clock. Looping tracks wrap by `duration`;
 * a non-looping track past its end returns null (it has finished).
 */
export function playbackPosition(sound: Pick<PlaylistSoundDoc, "playing" | "pausedTime" | "startedAt" | "repeat">, serverNow: number, duration?: number): number | null {
  const base = sound.pausedTime ?? 0;
  if (!sound.playing || sound.startedAt === null) return base;
  const t = base + Math.max(0, serverNow - sound.startedAt) / 1000;
  if (!duration || !Number.isFinite(duration)) return t;
  if (t < duration) return t;
  return sound.repeat ? t % duration : null;
}

/** Whether an ambient sound can be heard at all right now (before distance and walls). */
export function soundActive(sound: AmbientSoundDoc, darkness: number): boolean {
  if (!sound.path || sound.hidden || !(sound.radius > 0)) return false;
  return darkness >= (sound.darkness?.min ?? 0) && darkness <= (sound.darkness?.max ?? 1);
}

export interface Listener {
  x: number;
  y: number;
  /** Elevation in scene units. */
  elevation: number;
}

/**
 * Loudness factor 0–1 of an ambient sound for one listener: 1 at the source, 0 outside its radius,
 * cosine-eased towards the edge when `easing` is on. Height difference counts like distance.
 */
export function distanceVolume(sound: AmbientSoundDoc, listener: Listener, pxPerUnit: number): number {
  const radius = sound.radius * pxPerUnit;
  const dxy = Math.hypot(listener.x - sound.x, listener.y - sound.y);
  const dz = Math.abs(listener.elevation - (sound.elevation ?? 0)) * pxPerUnit;
  if (dxy === 0 && dz === 0) return 1;
  if (dxy > radius || dz > radius) return 0;
  if (!sound.easing) return 1;
  // Combine both distances so being above/below a source also fades it.
  const near = (1 - dxy / radius) * (1 - Math.min(dz, radius) / radius);
  return (Math.cos(Math.PI * (1 - near)) + 1) / 2;
}
