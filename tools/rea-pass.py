#!/usr/bin/env python3
"""
One REA pass over a slice of Foundry VTT, the way every Mesa phase starts.

    python3 tools/rea-pass.py <name> <pattern> [<pattern> ...]

Patterns are regular expressions matched against paths relative to the Foundry app folder, e.g.

    python3 tools/rea-pass.py phase5-audio 'documents/(playlist|playlist-sound|ambient-sound)\\.mjs$' \\
        '^client/audio/' 'layers/sounds\\.mjs$' 'placeables/sound\\.mjs$' 'tabs/playlist-directory\\.mjs$'

It copies only the matching .mjs files (plus package.json) into a temporary folder — analysing the
whole app walks node_modules and runs out of memory — runs `npx rea-agents analyze-javascript-application`,
saves the evidence to .rea/<name>.<evidence-prefix>.json and prints the evidence id, coverage and the
function inventory per module. Record the id in the vault's REA Evidence Ledger.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict

APP = os.environ.get("FOUNDRY_APP", "/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    name, patterns = sys.argv[1], [re.compile(p) for p in sys.argv[2:]]
    picked = []
    for base in ("client", "common", "dist"):
        for root, _, files in os.walk(os.path.join(APP, base)):
            for f in files:
                rel = os.path.relpath(os.path.join(root, f), APP)
                if f.endswith(".mjs") and any(p.search(rel) for p in patterns):
                    picked.append(rel)
    if not picked:
        sys.exit("No files matched.")
    work = tempfile.mkdtemp(prefix=f"rea-{name}-")
    target = os.path.join(work, "app")
    for rel in picked + ["package.json"]:
        os.makedirs(os.path.dirname(os.path.join(target, rel)), exist_ok=True)
        shutil.copy(os.path.join(APP, rel), os.path.join(target, rel))
    print(f"{len(picked)} files copied to {target}")

    out_tmp = os.path.join(work, "evidence.json")
    with open(out_tmp, "w") as out, open(os.path.join(work, "progress.log"), "w") as err:
        code = subprocess.call(
            ["npx", "-y", "rea-agents@latest", "analyze-javascript-application", target,
             "--artifact-format", "directory", "--max-heap-mb", "4096", "--format", "json"],
            stdout=out, stderr=err, cwd=work)
    data = json.load(open(out_tmp))
    if code != 0 or "evidence_id" not in data:
        sys.exit(f"REA failed (exit {code}): {json.dumps(data)[:500]}")

    ev = data["evidence_id"]
    nr = data["normalized_result"]
    sg = nr["semantic_graph"]
    os.makedirs(os.path.join(ROOT, ".rea"), exist_ok=True)
    dest = os.path.join(ROOT, ".rea", f"foundry-{name}.{ev[3:11]}.json")
    shutil.copy(out_tmp, dest)
    print(f"evidence  {ev}")
    print(f"coverage  truncated={sg['coverage']['truncated']} parsed={nr['statistics']['parsed_javascript_files']} "
          f"parse_failures={nr['statistics']['parse_failures']}")
    print(f"saved     {dest}\n")

    functions = defaultdict(list)
    events = set()
    for n in sg["nodes"]:
        path = n["identity"]["module_path"]
        if n["kind"] == "function" and n.get("label"):
            functions[path].append(n["label"])
        if n["kind"] == "event" and n.get("properties", {}).get("event_name"):
            events.add((path, n["properties"]["event_name"]))
    for path in sorted(functions):
        names = ", ".join(dict.fromkeys(functions[path]))
        print(f"{path}\n  {names[:900]}\n")
    if events:
        print("socket/emitter events:")
        for path, ev_name in sorted(events):
            print(f"  {ev_name:28} {path}")
    shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
