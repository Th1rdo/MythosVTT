import { test } from "node:test";
import assert from "node:assert/strict";
import type { AmbientSoundDoc, PlaylistDoc, PlaylistSoundDoc } from "./protocol.ts";
import { adjacentSound, distanceVolume, playbackOrder, playbackPosition, sliderToVolume, soundActive, volumeToSlider } from "./audio.ts";

const playlist = (over: Partial<PlaylistDoc> = {}) => ({ _id: "p", name: "P", mode: 0, sorting: "a", seed: 1, ...over }) as PlaylistDoc;
const track = (id: string, name: string, sort = 0) => ({ _id: id, name, sort }) as PlaylistSoundDoc;
const tracks = [track("c", "Chuva", 2), track("a", "Abertura", 3), track("b", "Batalha", 1)];

test("playback order: alphabetical, manual, and a shuffle every client agrees on", () => {
  assert.deepEqual(playbackOrder(playlist(), tracks), ["a", "b", "c"]);
  assert.deepEqual(playbackOrder(playlist({ sorting: "m" }), tracks), ["b", "c", "a"]);
  const s1 = playbackOrder(playlist({ mode: 1, seed: 42 }), tracks);
  assert.deepEqual(playbackOrder(playlist({ mode: 1, seed: 42 }), [...tracks].reverse()), s1);
  assert.deepEqual([...s1].sort(), ["a", "b", "c"]);
});

test("next/previous wrap around", () => {
  const order = ["a", "b", "c"];
  assert.equal(adjacentSound(order, "c", 1), "a");
  assert.equal(adjacentSound(order, "a", -1), "c");
  assert.equal(adjacentSound(order, null, 1), "a");
  assert.equal(adjacentSound([], null, 1), null);
});

test("playback position follows the server clock; loops wrap, finished tracks are null", () => {
  const s = { playing: true, pausedTime: 10, startedAt: 1000, repeat: false };
  assert.equal(playbackPosition(s, 6000), 15);
  assert.equal(playbackPosition(s, 6000, 100), 15);
  assert.equal(playbackPosition(s, 200_000, 100), null);
  assert.equal(playbackPosition({ ...s, repeat: true }, 1000 + 95_000, 100), 5);
  assert.equal(playbackPosition({ ...s, playing: false }, 99_999), 10);
});

test("volume slider curve round-trips", () => {
  assert.equal(sliderToVolume(1), 1);
  assert.ok(Math.abs(sliderToVolume(0.5) - 0.3536) < 1e-3);
  assert.ok(Math.abs(volumeToSlider(sliderToVolume(0.37)) - 0.37) < 1e-9);
});

test("ambient sound: darkness range, radius and easing", () => {
  const snd = { x: 0, y: 0, elevation: 0, radius: 10, path: "a.ogg", hidden: false, easing: true, darkness: { min: 0, max: 0.5 } } as AmbientSoundDoc;
  assert.equal(soundActive(snd, 0.3), true);
  assert.equal(soundActive(snd, 0.8), false);
  assert.equal(soundActive({ ...snd, hidden: true }, 0), false);
  // 10 units × 10 px per unit = 100 px radius.
  assert.equal(distanceVolume(snd, { x: 0, y: 0, elevation: 0 }, 10), 1);
  assert.equal(distanceVolume(snd, { x: 150, y: 0, elevation: 0 }, 10), 0);
  assert.ok(Math.abs(distanceVolume(snd, { x: 50, y: 0, elevation: 0 }, 10) - 0.5) < 1e-9);
  assert.equal(distanceVolume({ ...snd, easing: false }, { x: 90, y: 0, elevation: 0 }, 10), 1);
  assert.ok(distanceVolume(snd, { x: 50, y: 0, elevation: 5 }, 10) < 0.5);
});
