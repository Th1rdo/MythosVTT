# Foundry parity checklist

Goal: everything Foundry VTT v14 does, implemented originally in Mesa. Deployment comes last.
Inventory source: REA analysis of the Foundry client + common code
(`ev_6395f4e0275028d1fd2a159949521558ef74ffb36be6b764bce75ead0bf9fffc`, 782 JS files) and the server
(`ev_a90ceefd…6c6c`), plus the app's file tree. Each phase starts with a focused REA pass over the
Foundry modules for that feature; findings go in `docs/analysis/<phase>.md`.

Legend: ✅ done · 🟡 partial · ⬜ not started

## Phase 0 — Foundation (v0.1)
- ✅ Server, world storage, sessions, per-user visibility, socket protocol
- ✅ Scenes (background, square grid), tokens (move, hide, delete), pan/zoom, pings, pull to scene
- ✅ Chat, server-side dice (`NdX`, kh/kl, +/-), whispers to GM
- ✅ Actors with Ordem Paranormal sheet, journal (single rich-text page), ownership levels
- ✅ Foundry world importer (LevelDB + NeDB)

## Phase 1 — Walls, vision, fog, lighting  *(foundry: canvas/geometry, perception, sources, layers/walls, layers/lighting — REA `ev_fede3572…`)*
- ✅ Walls: draw (snap, chain with Ctrl, join endpoints), select, drag endpoints, delete, config; presets wall/door/secret/terrain/invisible/ethereal/window
- ✅ Per-sense restriction (move/sight/light/sound: none/limited/normal), one-way walls (Foundry's side convention), doors open/closed/locked, secret doors hidden from players server-side
- ✅ Movement blocked by walls — enforced on the server; players open/close unlocked doors
- ✅ Vision: wall-constrained LOS polygon per token, sight range, vision cone + token rotation (Shift+wheel), GM sees through a selected token
- ✅ Fog of war: explored areas accumulate, saved per user per scene (WebP, debounced 2 s), GM reset
- 🟡 Fog "shared" mode (stored, behaves as individual for now)
- ✅ Lighting: ambient lights (dim/bright radius, colour, intensity, cone, torch/pulse/flicker animation, walls on/off, on/off toggle), token light emission, darkness level, global illumination with threshold
- ⬜ Proximity/distance wall thresholds (imported as limited), door sounds and animations
- ⬜ Vision modes (darkvision, etc.) and detection modes — OP doesn't use them by default
- ✅ Ruler (waypoints with Space, shared live with other players) and distance readout while dragging tokens

## Phase 2 — Combat  *(documents/combat, combatant, combatant-group; sidebar/combat-tracker)*
- ⬜ Combat encounters per scene, add/remove combatants (from tokens), initiative roll (OP: AGI-based), sort, turns/rounds, next/previous, hidden/defeated, combatant groups
- ⬜ Turn marker on canvas, tracker UI, combat settings

## Phase 3 — Actors, items, effects  *(documents/actor, actor-delta, item, active-effect; hud/token-hud)*
- ⬜ Item documents with sheets (OP: weapons, protection, rituals, abilities, generic items), drag items onto actors, inventory/spaces
- ⬜ Linked vs unlinked tokens (actor deltas), prototype token config, token config sheet
- ⬜ Token HUD: resource bars (bar1/bar2), status effects, elevation, visibility, combat toggle
- ⬜ Active effects (changes to actor data, durations, status conditions)
- ⬜ Folders for every directory, sorting, search/filter

## Phase 4 — More placeables  *(placeables/*, layers/*)*
- ⬜ Tiles (image/video, overhead/occlusion, z-order)
- ⬜ Drawings (freehand, shapes, text, fill/stroke)
- ⬜ Measured templates (circle, cone, ray, rectangle)
- ⬜ Notes (map pins linked to journal entries/pages)
- ⬜ Regions + region behaviors (teleport, damage, pause, etc.)
- ⬜ Levels (v14 multi-level scenes)
- ⬜ Hex and gridless grids

## Phase 5 — Audio  *(audio/*, documents/playlist, playlist-sound, ambient-sound)*
- ⬜ Playlists (sequential/shuffle/simultaneous, fades, repeat), synced playback for all
- ⬜ Ambient sounds on the map (radius, wall occlusion, easing)
- ⬜ Volume controls (music / environment / interface)

## Phase 6 — Content  *(compendium, roll-table, cards, macro, adventure, journal pages, text enrichers)*
- ⬜ Compendium packs (create, browse, import), import OP system packs
- ⬜ Roll tables (draw, results to chat)
- ⬜ Cards (decks, hands, piles)
- ⬜ Macros (chat + script) and hotbar
- ⬜ Journal: multiple pages (text, image, PDF, video, markdown), categories, show-to-players, share image
- ⬜ Text enrichment: document links, inline rolls `[[/r 1d20]]`, embeds, secret blocks
- ⬜ Adventure export/import
- ⬜ Full dice grammar (parenthetical, functions, pools, exploding/reroll, fate, coins), roll resolver, dice config

## Phase 7 — UX and administration  *(applications/ui, settings, sidebar, helpers)*
- ⬜ Settings framework (world/client/user scope), configure settings UI
- ⬜ Keybindings, scene controls toolbar, scene navigation bar, pause, notifications, chat bubbles, context menus
- ⬜ User config (avatar, colour, character), permission config, invitation links
- ⬜ File picker / browser, image & video popouts, share image
- ⬜ Setup screen (multiple worlds), world config, backups
- ⬜ Localization (pt-PT first, en)
- ⬜ Tours / help

## Phase 8 — Extensibility  *(helpers/hooks, packages)*
- ⬜ Hooks API, module/system package format, enable/disable modules, hot reload
- ⬜ Port Tiago's own modules (toolkit, cinema-sync, rituals) to Mesa's API

## Phase 9 — Audio/video chat  *(av/*)*
- ⬜ WebRTC A/V between players, camera dock

## Phase 10 — Deployment
- ⬜ Hosting, HTTPS, persistent sessions, S3/asset storage
