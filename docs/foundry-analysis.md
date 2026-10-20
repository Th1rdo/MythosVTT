# Foundry VTT — analysis notes

What we learned from the locally installed Foundry VTT, and how it shaped Mesa.
Mesa is an original implementation: Foundry was used as a reference for behaviour and data
formats only. No Foundry code or assets are copied into this repository.

## Target

| | |
|---|---|
| App | `/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app` |
| Version | generation 14, stable, build 368 (`package.json` → `release`) |
| Runtime | Electron shell + Node ≥ 24 server (`main.mjs`) |
| User data | `~/Library/Application Support/FoundryVTT/{Config,Data,Logs}` |

Layout of the app bundle:

- `client/` (~650 files, ~181k lines) and `common/` (~130 files, ~35k lines): readable ES modules —
  browser client (PIXI canvas, applications/sheets, dice, hooks) and the shared document/data model.
- `dist/` (93 files, ~400 KB): the server, shipped minified (one line per file).
- `templates/`, `public/`: Handlebars templates, CSS, fonts, icons, sounds, lang.

## Method

`rea analyze-javascript-application` (REA 6.7.0, via `npx rea-agents`) over a copy of the server code only
(`dist/`, `main.mjs`, `package.json`, `common/server.mjs`). Running it over the whole app walks
`node_modules` (11k files) and runs out of result memory.

- Evidence: `ev_a90ceefdd51e1ce74a4c96ffa27f35561d02e9f1044ce298a9d908b239dc6b6c`
  (artifact sha256 `dd4fd842…d271c`; 95 modules, 925 graph nodes, 48,831 semantic nodes, 152 events, 73 listeners)
- Static analysis only: no claim below was observed at runtime unless marked *(observed on disk)*.

Findings were then confirmed by reading the relevant minified modules and by dumping a **copy** of a real
world's databases.

## Findings

### Storage *(observed on disk)*
- Each world collection is its own LevelDB (`classic-level`) at `worlds/<id>/data/<collection>/`,
  `keyEncoding: utf8`, `valueEncoding: json` (`dist/database/backend/level-database.mjs`).
- Keys are sublevel-prefixed: `!actors!<id>`.
- Embedded documents live in their own sublevel, keyed `parentId.childId`:
  `!scenes.tokens!<sceneId>.<tokenId>`, `!actors.items!<actorId>.<itemId>`, `!journal.pages!<entryId>.<pageId>`.
  The parent document stores only the array of child ids.
- Deleting an embedded doc that lives in a delta writes a tombstone (`embedded-delta.mjs`).
- Older worlds (≤ v10) used NeDB: `data/<collection>.db`, one JSON doc per line, embedded docs inline.
- IDs are 16-char random alphanumerics.
- User records hold `password` + `passwordSalt` hashes → the importer never copies them.

### Real-time protocol (socket.io)
- Socket auth comes from the `session` cookie, resolved to a user for the current world (`server/sockets.mjs`).
- All document CRUD goes through one event, `modifyDocument {action, type, operation}`, plus
  `modifyDocumentBatch` (dry-run every op first, then apply). The server returns a response to the
  caller and broadcasts it to everyone else (`database/backend/server-backend.mjs`).
- Side channels found by REA: `chatBubble`, `av` (relayed to recipients), `userActivity`, `pause`,
  `pullToScene`, `preloadScene`, `shareImage`, `showEntry`, `playAudio`, `syncFog`/`resetFog`/`shareFog`,
  `regionEvent`, `requestTokenImages`, `manageCompendium`, `hotReload`, and `pm.*` for collaborative
  ProseMirror editing.
- Dice are rolled **on the client** and sent as a finished roll.

### Scene geometry
- Scenes carry `padding` (default 0.25). The canvas is padded on each side by `width × padding`,
  rounded up to whole grid squares, and token `x/y` include that offset. The importer subtracts it.

## What Mesa does differently (design choices, not observations)

| Area | Foundry | Mesa |
|---|---|---|
| Storage | LevelDB per collection | One SQLite file per world (`node:sqlite`), one row per document; whole world in memory |
| Embedded docs | Sublevel + id arrays on the parent | Separate rows with `_parent`; no id arrays to keep in sync |
| Protocol | `modifyDocument` with a rich `operation` object | `doc {op, type, parent, data/updates/ids}` |
| Visibility | Mostly filtered on the client | Server sends each user only what they may see; a doc that becomes visible arrives as a create, one that becomes hidden as a delete |
| Dice | Rolled client-side | Rolled server-side with `crypto.randomInt`, so players can't forge results |
| Systems | Full plugin system/module API | Ordem Paranormal sheet built in; other systems get a JSON sheet |
