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

## Phase 2 — Combat  *(documents/combat, combatant, combatant-group; sidebar/combat-tracker — REA `ev_dc722773…`)*
- ✅ Encounters per scene (several per scene, selector), add/remove tokens with `C` (players: own tokens), created on demand
- ✅ Initiative rolled on the server and posted to chat (OP: Iniciativa skill test; others 1d20), roll all / threats only, GM edits values, reset
- ✅ Turns and rounds: start, next/previous turn, next/previous round, end; defeated skipped; current turn tracked by combatant id
- ✅ Players: roll own initiative, end their own turn, mark own combatant defeated; hidden combatants hidden from players (and roll privately)
- ✅ Cascades: token deleted → leaves combat (turn passes on), scene deleted → encounters deleted
- ✅ Tracker tab, click row → pan to token, pulsing turn marker on the canvas
- ✅ Importer brings Foundry combats (turn index → current combatant)
- ⬜ Combatant groups, combat sounds, turn/round hooks, combat settings UI, multi-select tokens (Phase 3/7)

## Phase 3 — Actors, items, effects  *(documents/actor, actor-delta, item, active-effect, token, folder; hud/token-hud — REA `ev_c306a076…`)*
- ✅ World items (Items tab, GM; share with ownership) and actor items; OP item sheets per type (arma, proteção, equipamento, ritual, habilidade); drag items onto sheets; weapon attack/damage rolls; rituals/abilities posted to chat; spaces used
- ✅ Linked vs unlinked tokens: unlinked tokens edit a delta (name, image, system, effects) over the base actor, like Foundry's synthetic actors
- ✅ Prototype token settings per actor (size, link, disposition, name/bar display, bars, vision, light); dropped tokens use them
- ✅ Token HUD (right-click): bars with absolute/relative input, elevation, conditions, combat toggle, visibility, sheet, config
- ✅ Resource bars (bar1/bar2 attributes, display modes), name display modes, elevation label, status icons, dead overlay
- ✅ Active effects: changes (add/multiply/override/upgrade/downgrade, Foundry order), conditions (32 OP conditions), duration in combat rounds with automatic expiry, effect editor; derived values shown on the sheet and used for rolls and initiative
- ✅ Folders for Actors, Items, Journal, Scenes (nesting, colour, drag in/out, collapse remembered, delete moves contents up)
- ✅ Multi-select: Shift+click, box select, Ctrl/⌘+A, group drag/arrow moves, group hide/delete/combat; right-drag or Space+drag pans
- ✅ Importer: folders, world items, actor effects, prototype tokens, token link/delta/bars/display/elevation (nested LevelDB embeds resolved)
- ⬜ Items on unlinked tokens (currently shared with the base actor), item effects that transfer to the actor
- ⬜ Targeting (T), directory search/filter, folder sort modes, duplicate/context menus, token image wildcards

## Phase 4 — More placeables  *(placeables/*, layers/*, levels, regions, grid — REA `ev_0449de80…`)*
- ✅ Levels (v14 floors): per-level background/foreground art and elevation bands; tokens on one level; walls/lights/tiles/drawings/notes/regions list theirs; level tabs in navigation; HUD level picker; players follow their token; wall collisions per level
- ✅ Tiles (image/video), background vs foreground (roofs), occlusion fade under controlled tokens, z-order, GM tool + config
- ✅ Drawings (rectangle, ellipse, polygon, freehand, text) for everyone, author-owned editing
- ✅ Measured templates (circle, cone, rectangle, line) — as regions, like v14 — for everyone, with measurements
- ✅ Notes (map pins linked to journal entries, drop an entry on the map; visible to who can see the entry)
- ✅ Regions + behaviours on the server: teleport (incl. other scenes), change level (asks the player), apply/remove effect, scrolling text, toggle behaviours; adjust darkness drawn by clients
- ✅ Hex (odd/even rows/columns) and gridless grids: drawing, snapping, token placement, measurement
- ✅ Importer: levels, tiles, drawings, notes, regions + behaviours, grid types
- ⬜ Ring/emanation/token region shapes; turn/round region events; pause-game, macro, movement-cost, surface behaviours; region-driven elevation; tile video controls

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

## Phase 7 — UX and administration  *(applications/ui, settings, sidebar, helpers — shell REA `ev_9483b78d…`)*
- ✅ Foundry-like shell: two-column scene controls (layer groups + tools), scene navigation pill with user pips, players list with latency/FPS, hotbar (10 slots × 5 pages, drop items/actors/journal, keys 1–0, lock/clear), collapsible sidebar icon strip with floating chat dock + notifications, directory headers (create, folder, search, sort, collapse all), scene banners
- ✅ GUI size per browser: left bar, right sidebar, hotbar (60–160%)
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
