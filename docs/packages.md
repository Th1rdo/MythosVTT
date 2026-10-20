# Writing a Mesa package

A package (Foundry calls them modules) is a folder in `data/modules/<id>/` with a `module.json`. Mesa reads the same file
and the same core fields as Foundry, so one repository can ship both versions. A full example lives in
`examples/modules/ola-mesa/` — copy it into `data/modules/` to try it.

## module.json

```json
{
  "id": "my-package",
  "title": "My package",
  "description": "What it does.",
  "version": "0.1.0",
  "authors": [{ "name": "Me" }],
  "socket": true,
  "relationships": { "requires": [{ "id": "other-package" }] },
  "mesa": {
    "compatibility": { "minimum": "0.1.0" },
    "esmodules": ["mesa/main.js"],
    "styles": ["styles/main.css"],
    "languages": [{ "lang": "pt-PT", "name": "Português", "path": "lang/pt-PT.json" }]
  }
}
```

- The `mesa` block is what makes a package runnable in Mesa. Without it the package is listed as "made for Foundry" and
  can't be switched on (Foundry scripts use Foundry's API). `esmodules`, `styles` and `languages` inside `mesa`
  replace the top-level ones, so the Foundry files can stay where they are.
- `id` must match the folder name (lowercase letters, digits, `-`, `_`). Paths are relative to the folder.
- `socket: true` lets the package use its own socket channel.
- `relationships.requires`: packages that must be on too; they load first.
- The GM switches packages on per world; the change applies after a reload.

## Loading

Styles are added, then the language file for the browser's language (exact match → same language → `en` → first), then
every script is imported in dependency order — all **before** the `init` hook. Scripts are plain ES modules that use the
global `mesa`. A script that throws shows a notice and the table still opens.

## The `mesa` API

| | |
|---|---|
| `mesa.hooks` | `on(name, fn)`, `once`, `off`, `call`, `callAll` — events listed in `client/src/hooks.ts` |
| `mesa.game` | the world: `get(type, id)`, `all(type)`, `children(type, parentId)`, `create/update/delete`, `user`, `isGM`, `socket` |
| `mesa.board` | the map once it exists (`canvasReady`): `scene`, `tokens`, `selected`, `eventToWorld`, `panTo`… |
| `mesa.settings` | `register(pkg, name, {name, hint, scope: "world"\|"user"\|"client", type, choices, range, default, config, onChange})`, `get("pkg.name")`, `set`, `onChange` |
| `mesa.keybindings` | `register(pkg, id, {name, bindings: [{key: "KeyG", modifiers: ["Shift"]}], onDown, onUp, gm, repeat, precedence})` |
| `mesa.socket` | `emit(pkg, data, users?)` to everyone else (or those users), `on(pkg, (data, userId) => …)` |
| `mesa.flags` | `get(doc, pkg, key)`, `set(type, doc, pkg, key, value)`, `unset(…)` — data under `flags.<pkg>` on any document |
| `mesa.i18n` | `localize(key)`, `format(key, {name})`, `has`, `lang` — the package's own language file (nested keys flatten to `A.B`) |
| `mesa.t` | Mesa's own strings |
| `mesa.notify`, `mesa.toast` | notices (`info`, `warning`, `error`, `success`) |
| `mesa.dialogs` | `confirm(message, label)`, `prompt(title, fields)` |
| `mesa.files` | `browse(kind, current)` — the file picker |
| `mesa.ui` | `openWindow(key, title, {width, onClose})` (returns the body to fill), `closeWindow`, `isOpen`, `openSheet`, `openJournal`, `openImagePopout` |
| `mesa.chat(text)` | post to the chat (or `/r 1d20`) as the current speaker |
| `mesa.time.serverNow()` | the server's clock (ms), the same instant on every client |
| `mesa.audio` | `volume(channel)` (this browser's 0–1), `playOnce(src, {volume, channel, loop})` |
| `mesa.playlists.action(action, {noHook})` | playlist actions as the buttons send them (`prePlaylistAction` hook first) |
| `mesa.utils` | `randomId`, `getProperty`, `escapeHtml`, `debounce` |

Useful hooks for packages: `init` (register settings and keys), `ready`, `canvasReady`, `getSceneControlButtons(groups)`
(push `{name, icon, title, gm, tools: [{name, icon, title, button, run}]}`), `getSidebarTabs(tabs)`, `renderChatMessage`,
`renderActorSheet`, `renderWindow`, and the document hooks `create/update/delete<Type>`.

## Rules the server enforces

- World settings are the GM's; package setting values must be JSON under 100 kB.
- Socket messages are relayed only for packages that are on and declare `"socket": true`.
- `flags` must be an object (under 100 kB).
