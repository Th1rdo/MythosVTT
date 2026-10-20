# MythosVTT

A self-hosted virtual tabletop, made for **Ordem Paranormal** games. One Node server on your computer; everyone
plays in the browser. The interface is in Portuguese (pt-PT), with English available in Settings.

Written from scratch. Foundry VTT was studied as a reference for what a VTT needs (see [docs/parity.md](docs/parity.md)),
and Foundry worlds can be imported one-way. No Foundry code, CSS or art is included.

## Quick start

You need [Node.js](https://nodejs.org) **24 or newer** (`node --version`).

```bash
git clone https://github.com/Th1rdo/MythosVTT.git
```

```bash
cd MythosVTT && npm install && npm run build
```

```bash
npm start
```

Then open **http://localhost:30100** on that computer:

1. The first time there's no world, so the **setup screen** opens. Create a world (an id like `minha-campanha`, a title).
2. Click **Lançar**, then **Entrar**, and log in as **Mestre** (the GM; no password yet).
3. In the sidebar → **Definições** → *Jogadores* add your players, and give each one a password in their user settings.
4. Players open `http://<your computer's IP>:30100` in their browser (same network), or through whatever you use to
   reach your computer from outside (a tunnel, port forwarding…).

Before letting anyone in from outside your network, set an **admin password** on the setup screen
(`http://localhost:30100/setup`): without one, only the computer running the server can open it.

Your worlds live in `data/` (one folder per world: `world.db`, `assets/`, backups). Back up that folder, or use
**Cópia de segurança** on the setup screen.

### Coming from Foundry

The setup screen can import a Foundry world from a folder on the same computer (scenes, actors, items, journals,
playlists, tables, macros…), optionally with the Ordem Paranormal system's compendia. From the command line:

```bash
npm run import -- "$HOME/Library/Application Support/FoundryVTT/Data/worlds/<world>"
```

## What it does

- **Scenes and map**: backgrounds, levels/floors, square/hex/gridless grids, tokens, walls and doors, vision and fog of
  war, lights, tiles, drawings, notes, regions with behaviours, measured templates, ruler, pings.
- **Ordem Paranormal sheet** (PV/SAN/PE/PD, NEX, attributes, skills, rolls), items, effects and conditions, token HUD.
- **Combat tracker**, **chat** with server-side dice (`/r 3d20kh+5 # Luta`, `/gr`, `/br`, `[[1d6]]` inline rolls), whispers.
- **Journal** with pages and secrets, **roll tables**, **cards**, **macros** and hotbar, **compendia**, **playlists** (in sync
  for everyone) and ambient sounds.
- **Settings**, rebindable keys, pause, file browser, guided tours, the setup screen with backups.
- **Modules** (Settings → Gerir módulos): packages in `data/modules/`, with a JavaScript API — see
  [docs/packages.md](docs/packages.md). Some of Tiago's Toolkit modules come bundled (off by default): Contagem, Trilha, Handouts.

Full feature list and what's still missing: [docs/parity.md](docs/parity.md).

## Options

Environment variables: `MESA_PORT` (default 30100), `MESA_DATA` (data folder, default `./data`), `MESA_WORLD` (world to open
on start), `MESA_ADMIN_PASSWORD` (sets the setup screen's admin password).

## Development

```bash
npm run dev
```

Server on :30100 (restarts on changes), Vite on :5173 (open that one). Checks:

```bash
npm test
```

```bash
npm run typecheck
```

```
shared/    protocol, document types, dice, permissions, settings (both sides)
server/    express + socket.io, worlds (in memory + SQLite), auth, setup, CLI tools, Foundry importer
client/    Vite + PIXI v8 canvas, plain-DOM interface
packages/  bundled modules
docs/      parity checklist, package guide, notes
```

## Credits

- Icons: [Font Awesome Free](https://fontawesome.com) — icons CC BY 4.0, fonts SIL OFL 1.1, code MIT.
- Font: [Signika](https://fonts.google.com/specimen/Signika) via Fontsource — SIL OFL 1.1.
- Ordem Paranormal is a game by Jambô Editora / Cellbit; this project is a fan-made tool and is not affiliated with them.
