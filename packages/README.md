# Bundled packages

Ports of Tiago's Toolkit (github.com/Th1rdo) to Mesa's package API (`docs/packages.md`). They ship with Mesa and are
**off** until the GM switches them on in Gerir módulos. A copy with the same id in `data/modules/` replaces the bundled one.

Each keeps the original's id, language files, CSS and pure logic (with its tests in `test/`); only the Foundry glue
(settings, windows, controls, sockets, canvas) is rewritten on the `mesa` API. The Foundry originals stay untouched in
their own repositories.

| Package | Original | Port |
|---|---|---|
| `tiagos-toolkit-contagem` | 0.1.0 | 0.1.0-mesa.1 — countdown for the table, same look and behaviour |
| `tiagos-toolkit-trilha` | 0.2.0 | 0.2.0-mesa.1 — picking another track lets the previous fade out first (prePlaylistAction instead of libWrapper) |
