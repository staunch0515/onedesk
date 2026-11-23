#!/usr/bin/env python3
"""Builds test-results/screenshots/parity/rows.md from test-results/screenshots/parity/results.json (run: python3 e2e/parity/make-report.py)."""
import json, re, sys
root = __file__.rsplit("/e2e/", 1)[0]
res = json.load(open(f"{root}/test-results/screenshots/parity/results.json"))
sp = open(f"{root}/docs/redesign/sqlpool-parity.md").read()
rows = []
for line in sp.splitlines():
    m = re.match(r"\| ([A-L]\d+) \| (.+?) \| .+ \| .+ \|$", line)
    if m: rows.append((m.group(1), m.group(2)))
assert len(rows) == 90, len(rows)
clean = lambda s: re.sub(r"\x1b\[[0-9;]*m", "", s).replace("|", "¦").replace("\n", " ")
out = []
cnt = {}
for r, title in rows:
    v = res.get(r)
    if not v: out.append(f"| {r} | {title} | 未验证 | 没有跑到这一行 | |"); cnt["未验证"] = cnt.get("未验证", 0) + 1; continue
    cnt[v["verdict"]] = cnt.get(v["verdict"], 0) + 1
    ev = v.get("evidence") or ""
    out.append(f"| {r} | {title} | **{v['verdict']}** | {clean(v['note'])[:520]} | {ev} |")
open(f"{root}/test-results/screenshots/parity/rows.md", "w").write("\n".join(out) + "\n")
print(cnt, "of", len(rows))
