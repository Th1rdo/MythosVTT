#!/usr/bin/env python3
"""
Translation coverage for the client.

    python3 tools/i18n-check.py            # summary: missing English entries, unwrapped strings per file
    python3 tools/i18n-check.py --keys     # every t("…") key, one per line
    python3 tools/i18n-check.py --missing  # keys with no English entry
    python3 tools/i18n-check.py --todo     # Portuguese-looking literals not yet wrapped in t(), by file

Keys are the Portuguese source strings (see client/src/i18n.ts). Literals that already have an English
entry count as covered: they are data translated when shown, e.g. t(step.title) in tours.ts.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "client", "src")
KEY = re.compile(r'(?<![\w.$])t\("((?:[^"\\]|\\.)*)"')
LIT = re.compile(r'(?<![\w$.])"((?:[^"\\\n]|\\.)*)"')
PT = re.compile(r"[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔ]| (de|do|da|para|com|não|uma|um|os|as|ao|à) ")


def files():
    for root, _, names in os.walk(SRC):
        for n in names:
            if n.endswith(".ts") and "/lang/" not in os.path.join(root, n):
                yield os.path.join(root, n)


def keys():
    out = set()
    for f in files():
        out.update(KEY.findall(open(f, encoding="utf8").read()))
    return sorted(out)


def english():
    path = os.path.join(SRC, "lang", "en.ts")
    if not os.path.exists(path):
        return set()
    return set(re.findall(r'^\s*"((?:[^"\\]|\\.)*)":', open(path, encoding="utf8").read(), re.M))


def todo():
    en = english()
    report = {}
    for f in files():
        found = []
        for line in open(f, encoding="utf8"):
            if line.strip().startswith(("import ", "//", "*")):
                continue
            wrapped = set(KEY.findall(line))
            for lit in LIT.findall(line):
                if lit not in wrapped and lit not in en and PT.search(lit) and not lit.startswith(("core.", "/", ".")):
                    found.append(lit)
        if found:
            report[os.path.relpath(f, ROOT)] = found
    return report


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--keys":
        print("\n".join(keys()))
    elif arg == "--missing":
        en = english()
        print("\n".join(k for k in keys() if k not in en))
    elif arg == "--todo":
        for f, lits in sorted(todo().items()):
            print(f"{f} ({len(lits)})")
            for l in lits:
                print(f"    {l}")
    else:
        k, en, t = keys(), english(), todo()
        print(f"{len(k)} wrapped strings, {len([x for x in k if x not in en])} without English")
        print(f"{sum(len(v) for v in t.values())} Portuguese literals not wrapped yet, in {len(t)} files:")
        for f, lits in sorted(t.items(), key=lambda kv: -len(kv[1])):
            print(f"  {len(lits):4}  {f}")
