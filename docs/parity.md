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

## Phase 5 — Audio  *(audio/*, documents/playlist, playlist-sound, ambient-sound, layers/sounds — REA `ev_729487d9…`)*
- ✅ Playlists + tracks (folders, sequential/shuffle/simultaneous/disabled, alphabetical/manual order, fades, repeat, per-track volume and channel)
- ✅ Server-authoritative playback: the server picks tracks and stamps starts with its clock; everyone (late joiners too) hears the same position; pause/resume keeps the position; seeded shuffle; first "ended" report advances
- ✅ Playlists sidebar tab: volume sliders, "now playing", play/pause/stop/skip/mode, add/import tracks, configs; players see only what's playing (or playlists they own)
- ✅ Playlist ownership: players with owner rights control a playlist
- ✅ Ambient sounds on the map (sounds tool): radius, volume, cosine easing, elevation, levels, darkness range, walls block or muffle, base/muffled effects (low-pass, high-pass, reverb), hidden/locked; heard from controlled tokens, or owned tokens for players; GM previews with the mouse
- ✅ Per-browser volumes (music / environment / interface, perceptual curve) and hotbar mute; audio waits for the first click (browser rule) then syncs
- ✅ One-off sounds (`playAudio`, `preloadAudio` socket events) — UI comes with macros (Phase 6)
- ✅ Importer: playlists, tracks, ambient sounds (untested against real Foundry data — claude-tests has none)
- ⬜ Drag a track onto the map to make an ambient sound; sound-effect previews in the config; playlist bulk-import dialog filters; auto-preload of the next track; audio analyser (band levels for modules)

## Phase 6 — Content  *(compendium, roll-table, cards, macro, adventure, journal pages, text enrichers — macros REA `ev_fb5a9b64…`, dice `ev_b3b33516…`, tables `ev_9d6d3877…`, journal `ev_91567e39…`, compendia `ev_4223fd20…`, cards `ev_396f15f9…`)*
- ✅ Compendium packs (REA `ev_4223fd20…`): stored apart (SQLite table, fetched on demand), Compêndios tab, pack window (search, folders, preview), GM import one/all (into a new folder), drop world documents in to store them, lock, player visibility; players drag items onto their own sheets
- ✅ `npm run import-packs` — Foundry system/module/world packs (Actor, Item, JournalEntry, RollTable, Macro, Playlist, Adventure); the OP system's 238 entries (weapons, gear, abilities, powers, paths, mission tables) import as locked packs
- ✅ Roll tables (REA `ev_9d6d3877…`): Tables tab + sheet (edit in place, paste a list, weights → ranges via Normalizar, formula or 1dN), text or document results (drag a document onto a result), nested tables, with/without replacement + reset, draw N at once, roll modes; server-side draws posted as a chat card with links; hotbar + `mesa.drawTable`; importer
- ⬜ Roll tables: result images per row in the sheet, compendium tables, "draw from table" region behaviour
- ✅ Cards (REA `ev_396f15f9…`): decks/hands/piles, deal (round-robin, top/bottom/random, face down), draw, pass/play/discard, shuffle, recall (deck gathers everything; hand/pile returns home), flip faces; hands private, deck order secret, face-down cards sent without faces; counts visible; chat notes; standard 52+2 deck generator (CSS-drawn); card editor (faces, back, suit, value); importer
- ⬜ Cards on the canvas (drag to the map), card presets with art, hand dock in the UI
- ✅ Macros (chat + script): Macros tab, config window (icon, command, sharing none/run/edit), author always owns; players make their own
- ✅ Hotbar macros: click an empty slot to write one, drop from the directory, keys 1–0, right-click menu (edit/remove/delete), drag between slots
- ✅ Script API for macros (`speaker, actor, token, character, scope, mesa`); GM confirms before running a player's script; `mesa.playAudio` = one-off sounds UI
- ✅ Region behaviour "Executar macro" (mover if allowed, else highest-ranked online user; or everyone); importer: macros + users' hotbars
- ⬜ Script-macro permission setting (Foundry MACRO_SCRIPT, Phase 7); macro compendia; Foundry script macros need porting to Mesa's API
- ✅ Journal pages (REA `ev_91567e39…`): text (HTML editor or Markdown), image, PDF, video (files or YouTube/Vimeo); categories; per-page ownership (inherit/none/limited/observer/owner); page list + one/all pages; reorder; old entries migrate to a first page; importer keeps Foundry pages
- ✅ Show to players (optionally granting read access) and share an image with everyone; notes open a page
- ✅ Text enrichment: `@UUID[…]{…}` / `@Actor[…]` links (pages too, drag documents into the editor), `[[…]]` / `[[/gr …]]` roll buttons, URLs; secret blocks stripped server-side for non-owners, reveal toggle for owners
- ⬜ `@Embed[…]`, journal page search, page-level "show image" for limited users, ProseMirror-grade editor, PDF page jumps
- ✅ Adventures: bundle world folders (+ contents, children) and scenes into one entry; import keeps ids, asks before overwriting
- ⬜ Scenes in Foundry packs/adventures (converter), compendium folders editing, per-role pack ownership, pack search across packs, compendium art mapping
- ✅ Full dice grammar (own parser, REA `ev_b3b33516…`): + − * / % and parentheses, (N)d(M), functions (floor, max, …), pools `{…}kh`, fate `dF`, coins `dc`, flavour `[…]`; modifiers r rr x xo k kh kl d dh dl min max even odd cs cf df sf ms, coin call `c`
- ✅ Roll modes /r /gr /br (blind: only GMs see the result) /sr (self); `[[formula]]` inline rolls rolled by the server; `@campo` from the speaker's actor data
- ✅ Roll card: per-group dice with discarded/rerolled/exploded/success/failure styling; importer keeps Foundry dice results
- ⬜ Roll resolver (manual/physical dice entry), dice config (fulfilment methods), deferred inline rolls `[[/r …]]` as buttons, Dice So Nice-style 3D

## Phase 7 — UX and administration  *(applications/ui, settings, sidebar, helpers — shell REA `ev_9483b78d…`, settings `ev_e0b8ff40…`, keys `ev_2d5e38e7…`, user/pause `ev_6b3ceeb4…`, files `ev_324ad5da…`, setup `ev_59d3fb59…`)*
- ✅ Foundry-like shell: two-column scene controls (layer groups + tools), scene navigation pill with user pips, players list with latency/FPS, hotbar (10 slots × 5 pages, drop items/actors/journal, keys 1–0, lock/clear), collapsible sidebar icon strip with floating chat dock + notifications, directory headers (create, folder, search, sort, collapse all), scene banners
- ✅ GUI size per browser: left bar, right sidebar, hotbar (60–160%)
- ✅ Settings framework: one shared registry (world / user / client scope), world values as Setting docs validated and enforced by the server, user values on the User, client in localStorage; Definições window (categories, save, reset) with Som and Tamanho da interface inside
- ✅ First settings: square-grid diagonal rule (1-1-1, 1-2-1, exact, rectilinear), player permissions (drawings, templates, script macros, uploads, pings, ruler, whispers), default roll mode (per user), chat notifications, light animation, max FPS, reduce motion; `/w` whispers
- ✅ Keybindings (REA `ev_2d5e38e7…`): registry with editable + fixed bindings by physical key, modifiers, repeat, precedence (shared keys fall through: C = combat with a selection, else your sheet); Definições → Teclas (rebind, add, remove, conflicts, reset); core set: Esc, Delete/Backspace, Ctrl+A, H, C, WASD/arrows/numpad moves, PgUp/PgDn zoom, Enter → chat, 1–0 hotbar (+ page keys)
- ✅ Pause (REA `ev_6b3ceeb4…`): GM Space (released without dragging the view) or main menu; banner for everyone; the server refuses players' token moves while paused; chat announces it; region behaviour "Pôr o jogo em pausa"
- ✅ Main menu on Esc (account, settings, keys, pause, reload, log out); notifications queue (max 3, info/warning/error/success, permanent, progress, click to dismiss, duplicates merge)
- ⬜ Chat bubbles, sendToBack/bringToFront, target (T), ruler key
- ✅ User config: colour, avatar, pronouns, character (players: their own actors), GM: name + password; open from the players list
- ⬜ Invitation links
- ✅ Image popout + share image with everyone (Phase 6.4)
- ✅ File picker (REA `ev_324ad5da…`): browse world assets by folder with kinds (image, audio, video, PDF), thumbnails/list, search, upload into the current folder, new folder (GM), type a URL; used by every image/audio/document field; players need "ver os ficheiros" (else plain upload); PDF and more audio types uploadable
- ⬜ Video popouts, favourite folders, S3/external sources
- ✅ Setup screen (REA `ev_59d3fb59…`): /setup with admin password (none = this computer only; `MESA_ADMIN_PASSWORD`), worlds list (launch, close, enter, edit title/description, delete with typed id), create world, import a Foundry world from a folder (+ system compendia), backups (consistent DB snapshot + assets) and restore (keeps the replaced state); server starts without a world and switches worlds live
- ⬜ Packages (systems/modules install), world thumbnails, invitation links, update checks
- ✅ Localization (REA `ev_70c23fcb…`): gettext-style `t("texto em pt-PT", {params})` (the Portuguese source is the key, so a missing translation still reads correctly), English table, language per browser in Definições → Interface (reloads), `tools/i18n-check.py` coverage report; the shell, settings, keys, main menu, pause and setup screen are wrapped
- ⬜ Localization, rest: sheets, windows, canvas configs, chat and journal strings (≈270 literals, see `python3 tools/i18n-check.py`); per-system/module language files; list formatting and sorting by locale
- ✅ Tours (REA `ev_70c23fcb…`): guided tours that highlight a part of the screen (cut-out + card beside it), GM-only tours/steps, open the right sidebar tab first, progress per browser (new / in progress / seen, resume or restart), Esc leaves; offered once on first entry; Definições → Visitas guiadas; three tours (first steps, the map, preparing a session)
- ⬜ Tours registered by systems/modules, canvas-placed steps

## Phase 8 — Extensibility  *(helpers/hooks, packages)*
- ✅ Hooks (REA `ev_bf37a5b7…`): on/once/off, `call` (false cancels) / `callAll`, failing listeners reported as a notice and skipped, `error` hook; core events: init/setup/ready, pre/create/update/delete<Type> (pre* on the requesting client, can edit or cancel; update gets the changed fields), combatRound/combatTurn, pauseGame, userConnected, canvasReady, controlToken, dropCanvasData, getSceneControlButtons, getSidebarTabs, renderWindow/closeWindow, renderActorSheet, renderChatMessage, chatMessage, hotbarDrop, settingChanged/clientSettingChanged; `mesa.hooks` in script macros
- ⬜ Hooks still missing: per-placeable draw/refresh/hover, render hooks for every window class, targetToken, preMoveToken/moveToken, chat bubbles
- ✅ Packages (REA `ev_8cdc6624…`): `data/modules/<id>/module.json` (Foundry's file and fields; a `mesa` block makes it runnable and may point at Mesa-specific scripts/styles/languages), on per world (`core.modules`), dependencies first (missing ones keep it off), styles + language file + ES modules loaded before `init`; `window.mesa` API (hooks, game, board, settings.register with world/user/client scopes shown in Definições → Módulos, keybindings.register, per-package socket relayed by the server, flags on any document, i18n from the package's files, notices, dialogs, file picker, windows, chat); author guide `docs/packages.md`, example `examples/modules/ola-mesa`
- ✅ Module management (Gerir módulos, GM; sidebar Definições and Esc menu): filter all/on/off, search by name/id/author, version/authors/description, problems (made for Foundry, missing files), switching on offers the missing dependencies, switching off what others need is refused, disable all; saving asks to reload every page (server `reload` broadcast); world settings marked reload ask the same
- ⬜ Systems as packages, package install from a URL/zip/manifest, compendium packs inside packages, hot reload of styles/languages, compatibility ranges
- 🟡 Port Tiago's own modules to Mesa's API (bundled in `packages/`, off by default): ✅ Contagem; ⬜ Trilha, Handouts, Elenco, POI, Stage, Computador, Cinema, Transmissão, Ponte, Andares, Sons, Minijogos, PROJECT GRACE

## Phase 9 — Audio/video chat  *(av/*)*
- ⬜ WebRTC A/V between players, camera dock

## Phase 10 — Deployment
- ⬜ Hosting, HTTPS, persistent sessions, S3/asset storage
