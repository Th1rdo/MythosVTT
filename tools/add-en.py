#!/usr/bin/env python3
"""
Add English entries to client/src/lang/en.ts without duplicates.

    python3 tools/add-en.py "Section title" < pairs.json      # {"pt-PT source": "English", ...}
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "client", "src", "lang", "en.ts")

pairs = json.load(sys.stdin)
src = open(PATH, encoding="utf8").read().rstrip()
have = {json.loads(m.group(1)) for m in re.finditer(r'^\s*("(?:[^"\\]|\\.)*")\s*:', src, re.M)}
new = [(k, v) for k, v in pairs.items() if k not in have]
if new:
    assert src.endswith("};")
    body = src[:-2].rstrip()
    title = sys.argv[1] if len(sys.argv) > 1 else "More"
    body += f",\n\n  // {title}\n" + ",\n".join(f"  {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}" for k, v in new) + "\n};\n"
    open(PATH, "w", encoding="utf8").write(body)
print(f"{len(new)} added, {len(pairs) - len(new)} already there")
