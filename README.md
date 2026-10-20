# Mesa

A lean, self-hosted virtual tabletop for our Ordem Paranormal games. One Node server; players join in the browser.

Written from scratch. Foundry VTT was studied as a reference (see [docs/foundry-analysis.md](docs/foundry-analysis.md)),
and Foundry worlds can be imported one-way.

## What it does (v0.1)

- **Scenes**: background image, square grid, pan/zoom, GM can preview any scene, activate one for everyone,
  or pull players to the one being viewed.
- **Tokens**: drag to move (snaps to grid), arrow keys, hidden tokens (`H`), delete (`Del`), drop actors from the sidebar onto the map.
  Players can move only tokens of actors they own.
- **Chat and dice**: `/r 3d20kh+5 # Luta`, `/gr …` for GM-only rolls; rolls happen on the server.
- **Ordem Paranormal sheet**: PV/SAN/PE/PD, NEX, Defesa, attributes and skills. Clicking one rolls it
  (attribute dice, keep highest; 0 → 2d20 keep lowest; + training bonus).
- **Journal**: rich text, shared with everyone or per player.
- **Permissions**: per-actor / per-entry ownership (Nenhum / Limitado / Observador / Dono). The server only sends each
  player what they're allowed to see.
- **Pings**: double-click on the map.

## Running

Requires Node ≥ 24 (uses built-in TypeScript stripping and `node:sqlite`).

```bash
npm install
```

Create a world, or import one from Foundry:

```bash
npm run world -- create minha-campanha "A Minha Campanha" --password segredo
```

```bash
npm run import -- "$HOME/Library/Application Support/FoundryVTT/Data/worlds/<world>"
```

Imported users have no password until you set one:

```bash
npm run world -- passwd <world> "<user name>" <password>
```

Development (server on :30100 with auto-restart, Vite on :5173):

```bash
npm run dev
```

Production (single port, default 30100):

```bash
npm run build && npm start -- --world <world>
```

Environment: `MESA_DATA` (data folder, default `./data`), `MESA_WORLD`, `MESA_PORT`.

## Layout

```
shared/   protocol + document types, dice, permission rules (used by both sides)
server/   express + socket.io, World (in-memory + SQLite), auth, CLI tools, Foundry importer
client/   Vite + PIXI v8 canvas, plain-DOM UI
docs/     Foundry analysis notes
```

Data lives in `data/worlds/<id>/` (`world.json`, `world.db`, `assets/`).

## Tests

```bash
npm test
```

```bash
npm run typecheck
```
