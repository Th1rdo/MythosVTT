# Mesa

Tiago's own virtual tabletop, aiming at full Foundry VTT parity. Original code; Foundry is studied with REA.

## Before doing anything
The project memory lives in the Obsidian vault `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/mesa`.
Read, in order: `wiki/hot.md` → `wiki/meta/Handoff.md` → `wiki/meta/Working Agreements.md` → `wiki/index.md` → the page you need.

## Rules (short version — details in the vault)
- Every feature starts with a REA pass over the matching Foundry modules: `python3 tools/rea-pass.py <name> <regex>...`,
  then record the evidence id in the vault's REA Evidence Ledger and findings in `wiki/foundry/`.
- Never copy Foundry code, CSS or art. Study behaviour/data formats, write original code.
- UI language pt-PT; code and comments in English; match the surrounding style (TypeScript, erasable syntax only, `.ts` imports).
- Verify in the browser (preview `mesa-dev`, dev data in `./data`, `window.mesa` debug handle) and with `npm test` + `npm run typecheck`.
- Commit per phase/part with the Co-Authored-By trailer. Deploying is the very last phase.
- After any work: update the touched vault pages, `wiki/hot.md`, `wiki/log.md`, and `docs/parity.md`.
