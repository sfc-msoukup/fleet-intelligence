import json, urllib.request, urllib.parse

BASE = "http://localhost:3000"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=180) as r:
        return json.loads(r.read().decode())


ok = True


def check(name, cond, detail=""):
    global ok
    if not cond:
        ok = False
    print(f"  [{'PASS' if cond else 'FAIL'}] {name} {detail}")


print("=== token arithmetic reconciles per bucket ===")
agents = get("/api/agent?window=30d")["agents"]
for ag in agents:
    d = get("/api/agent?window=30d&agent=" + urllib.parse.quote(ag["agentFqn"]))
    if not d["tokens"]:
        continue
    for t in d["tokens"]:
        stack = t["cacheReadInput"] + t["cacheWriteInput"] + t["freshInput"] + t["output"]
        check(
            f"{ag['displayName'][:24]:26s} {t['ts'][:16]} stack==total",
            stack == t["total"],
            f"stack={stack} total={t['total']}",
        )
        check(
            f"{ag['displayName'][:24]:26s} {t['ts'][:16]} caches<=input",
            t["cacheReadInput"] + t["cacheWriteInput"] <= t["input"],
        )

print()
print("=== cache hit rate now uses input as denominator ===")
f = get("/api/fleet?window=30d")["kpis"]
print(f"     cacheRead={f['cacheReadTokens']} input={f['inputTokens']} hitPct={f['cacheHitPct']}")
expected = f["cacheReadTokens"] / f["inputTokens"] * 100 if f["inputTokens"] else None
check("hitPct == cacheRead/input", abs((f["cacheHitPct"] or 0) - (expected or 0)) < 1e-6)
check("hitPct <= 100", (f["cacheHitPct"] or 0) <= 100)

print()
print("=== RESULT:", "ALL PASS" if ok else "FAILURES PRESENT", "===")
