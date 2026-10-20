import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-playlists-"));
process.env.MESA_DATA = tmp;
const { World } = await import("./world.ts");
const { runPlaylistAction } = await import("./playlists.ts");
type UserDoc = import("../shared/protocol.ts").UserDoc;
type PlaylistDoc = import("../shared/protocol.ts").PlaylistDoc;
type PlaylistSoundDoc = import("../shared/protocol.ts").PlaylistSoundDoc;

function setup(mode = 0) {
  const world = World.create({ id: `p${Math.random().toString(36).slice(2, 8)}`, title: "T", system: "ordemparanormal" });
  const [gm, alice] = world.createAsSystem("User", [{ name: "GM", role: "gm" }, { name: "Alice" }]) as UserDoc[];
  const [playlist] = world.createAsSystem("Playlist", [{ name: "Música", mode }]) as PlaylistDoc[];
  world.createAsSystem("PlaylistSound", [{ name: "A", path: "a.ogg" }, { name: "B", path: "b.ogg" }, { name: "C", path: "c.ogg" }], playlist._id);
  const sounds = () => Object.fromEntries(world.all<PlaylistSoundDoc>("PlaylistSound").map(s => [s.name, s]));
  const pl = () => world.get("Playlist", playlist._id) as PlaylistDoc;
  return { world, gm, alice, playlist, sounds, pl };
}

test("sequential: play all starts the first track, next/previous move along, the end advances", () => {
  const { world, gm, playlist, sounds, pl } = setup();
  runPlaylistAction(world, gm, { action: "playAll", playlistId: playlist._id }, 1000);
  assert.equal(pl().playing, true);
  assert.deepEqual(Object.values(sounds()).filter(s => s.playing).map(s => s.name), ["A"]);
  assert.equal(sounds().A.startedAt, 1000);

  runPlaylistAction(world, gm, { action: "next", playlistId: playlist._id }, 2000);
  assert.deepEqual(Object.values(sounds()).filter(s => s.playing).map(s => s.name), ["B"]);
  runPlaylistAction(world, gm, { action: "previous", playlistId: playlist._id }, 3000);
  assert.equal(sounds().A.playing, true);

  // A stale report (older playback of the same track) is ignored; the matching one advances.
  runPlaylistAction(world, gm, { action: "ended", playlistId: playlist._id, soundId: sounds().A._id, startedAt: 1000 }, 4000);
  assert.equal(sounds().A.playing, true);
  runPlaylistAction(world, gm, { action: "ended", playlistId: playlist._id, soundId: sounds().A._id, startedAt: 3000 }, 4000);
  assert.equal(sounds().B.playing, true);
  assert.equal(sounds().A.playing, false);
});

test("pause keeps the position and play all resumes it; stop forgets it", () => {
  const { world, gm, playlist, sounds, pl } = setup();
  runPlaylistAction(world, gm, { action: "play", playlistId: playlist._id, soundId: sounds().B._id }, 10_000);
  runPlaylistAction(world, gm, { action: "pause", playlistId: playlist._id, soundId: sounds().B._id }, 25_000);
  assert.equal(sounds().B.playing, false);
  assert.equal(sounds().B.pausedTime, 15);
  assert.equal(pl().playing, false);
  runPlaylistAction(world, gm, { action: "playAll", playlistId: playlist._id }, 30_000);
  assert.equal(sounds().B.playing, true);
  assert.equal(sounds().B.pausedTime, 15);
  assert.equal(sounds().B.startedAt, 30_000);
  runPlaylistAction(world, gm, { action: "stop", playlistId: playlist._id, soundId: sounds().B._id }, 31_000);
  assert.equal(sounds().B.pausedTime, null);
  assert.equal(pl().playing, false);
});

test("simultaneous plays everything; an ended track stops only itself", () => {
  const { world, gm, playlist, sounds, pl } = setup(2);
  runPlaylistAction(world, gm, { action: "playAll", playlistId: playlist._id }, 1);
  assert.equal(Object.values(sounds()).filter(s => s.playing).length, 3);
  runPlaylistAction(world, gm, { action: "ended", playlistId: playlist._id, soundId: sounds().C._id, startedAt: 1 }, 2);
  assert.equal(sounds().C.playing, false);
  assert.equal(pl().playing, true);
});

test("cycle mode stops playback; players need ownership to control, but may report an end", () => {
  const { world, gm, alice, playlist, sounds, pl } = setup();
  runPlaylistAction(world, gm, { action: "playAll", playlistId: playlist._id }, 1);
  runPlaylistAction(world, gm, { action: "cycleMode", playlistId: playlist._id }, 2);
  assert.equal(pl().mode, 1);
  assert.equal(pl().playing, false);
  assert.equal(Object.values(sounds()).some(s => s.playing), false);

  assert.throws(() => runPlaylistAction(world, alice, { action: "playAll", playlistId: playlist._id }), /Sem permissão/);
  assert.throws(() => world.apply({ op: "update", type: "PlaylistSound", parent: playlist._id, updates: [{ _id: sounds().A._id, volume: 1 }] }, alice), /Sem permissão/);
  world.apply({ op: "update", type: "Playlist", updates: [{ _id: playlist._id, ownership: { default: 0, [alice._id]: 3 } }] }, gm);
  runPlaylistAction(world, alice, { action: "play", playlistId: playlist._id, soundId: sounds().A._id }, 5);
  assert.equal(sounds().A.playing, true);
  assert.throws(() => world.apply({ op: "update", type: "Playlist", updates: [{ _id: playlist._id, ownership: { default: 3 } }] }, alice), /Sem permissão/);
  runPlaylistAction(world, alice, { action: "ended", playlistId: playlist._id, soundId: sounds().A._id, startedAt: 5 }, 6);
});
