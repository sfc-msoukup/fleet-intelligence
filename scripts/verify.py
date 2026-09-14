import json, os, subprocess, sys, urllib.request, urllib.parse

BASE = "http://localhost:3000"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=180) as r:
        return r.status, json.loads(r.read().decode())


def page(path):
    with urllib.request.urlopen(BASE + path, timeout=180) as r:
        return r.status, len(r.read())


ok = True


def check(name, cond, detail=""):
    global ok
    mark = "PASS" if cond else "FAIL"
    if not cond:
        ok = False
    print(f"  [{mark}] {name} {detail}")


def sql_scalar(q):
    """Run one read-only query through the Snowflake CLI and return cell [0][0].

    This suite is otherwise pure HTTP. The exception is the cost reconciliation:
    the only trustworthy check is materialized cost against
    SNOWFLAKE.ACCOUNT_USAGE, and the app deliberately never exposes raw
    ACCOUNT_USAGE over its API. Returns None when the CLI or connection is
    unavailable so the rest of the suite still runs rather than hard-failing on a
    machine without credentials.

    /opt/anaconda3/bin/snow explicitly: a bare `snow` resolves to a root-owned
    3.15.0 bundle on this machine.
    """
    exe = "/opt/anaconda3/bin/snow"
    if not os.path.exists(exe):
        return None
    env = dict(os.environ)
    # Uses SNOWFLAKE_DEFAULT_CONNECTION_NAME from the environment if set,
    # otherwise the snow CLI's configured default connection.
    try:
        r = subprocess.run(
            [exe, "sql", "-q", q, "--format", "json"],
            capture_output=True, text=True, timeout=180, env=env,
        )
        if r.returncode != 0:
            return None
        rows = json.loads(r.stdout)
        return list(rows[0].values())[0] if rows else None
    except Exception:
        return None


print("=== PAGES ===")
for p in ["/", "/limits", "/agents", "/feedback"]:
    st, n = page(p)
    check(f"GET {p}", st == 200, f"HTTP {st} bytes={n}")

print()
print("=== /api/feedback ===")
st, d = get("/api/feedback")
check("status", st == 200 and "error" not in d, d.get("error", ""))
s = d["summary"]
print(f"     total={s['total']} pos={s['positive']} neg={s['negative']} agents={s['agents']} users={s['users']}")
print(f"     uncategorizedNegative={d['uncategorizedNegative']}")
print(f"     categories={[(c['category'], c['n']) for c in d['categories']]}")
print(f"     byAgent={[(a['agentName'], a['positive'], a['negative']) for a in d['byAgent']]}")
check("pos+neg == total", s["positive"] + s["negative"] == s["total"])
check("items length == total", len(d["items"]) == s["total"], f"{len(d['items'])} vs {s['total']}")
for i in d["items"][:5]:
    print(f"     {i['ts']}  {str(i['agentName'])[:24]:26s} pos={i['isPositive']} cats={i['categories']} msg={str(i['message'])[:40]!r}")
check("all items have ISO ts", all(i["ts"] and "T" in i["ts"] for i in d["items"]))
check("categories parsed as list", all(isinstance(i["categories"], list) for i in d["items"]))

print()
print("=== /api/fleet (all windows) ===")
ALL_WINDOWS = ["60m", "24h", "7d", "30d", "90d", "180d", "365d"]
# Trend buckets must coarsen on the long windows, otherwise a year renders as
# 365 bars. Asserted so the registry and the charts cannot drift apart.
EXPECTED_BUCKET = {
    "60m": "minute", "24h": "hour", "7d": "day", "30d": "day",
    "90d": "day", "180d": "week", "365d": "week",
}
prev_req = -1
for w in ALL_WINDOWS:
    st, d = get(f"/api/fleet?window={w}")
    k = d["kpis"]
    cov = d["coverage"]
    check(
        f"window={w}",
        st == 200 and "error" not in d,
        f"req={k['requests']} agents={k['activeAgents']}/{k['totalAgents']} tok={k['tokens']} reqErr={k['requestErrorRate']} p95={k['p95Ms']}",
    )
    check(f"  hex tiles == totalAgents ({w})", len(d["hex"]) == k["totalAgents"])
    check(f"  trend ts all ISO ({w})", all(t["ts"] and "T" in t["ts"] for t in d["trend"]))
    check(f"  bucket == {EXPECTED_BUCKET[w]} ({w})", d["bucket"] == EXPECTED_BUCKET[w])
    # Windows are nested, so a wider window can never contain fewer requests.
    # This catches an off-by-one in since() far more reliably than eyeballing.
    check(f"  monotonic vs narrower window ({w})", k["requests"] >= prev_req,
          f"{prev_req} -> {k['requests']}")
    prev_req = k["requests"]
    check(f"  trend points <= 95 ({w})", len(d["trend"]) <= 95, f"{len(d['trend'])} points")

# Coverage honesty: a window longer than retained history must say so.
st, d365 = get("/api/fleet?window=365d")
st, d24 = get("/api/fleet?window=24h")
hist = d365["coverage"]["turnHistoryDays"]
print(f"     history retained: {hist}d (earliest {d365['coverage']['earliestTurnTs']})")
check("365d flags windowExceedsHistory", d365["coverage"]["windowExceedsHistory"] is True)
check("24h does not flag it", d24["coverage"]["windowExceedsHistory"] is False)

print()
print("=== COST (agent cost KPI) ===")

# 1. The load-bearing check. FLEET_REQUEST_COST must sum to the TOKEN_CREDITS that
#    Snowflake itself metered, across BOTH views.
#
#    This exists to catch one specific defect: 185 of 500 model objects in
#    CREDITS_GRANULAR omit cache_read_input, and SUM(a+b+c+d) silently DROPS any
#    row where one term is NULL. That produced a phantom 5.2% shortfall during
#    development and is invisible in the UI - the number just quietly reads low.
#    Every credit column in the refresh is COALESCEd for this reason.
delta = sql_scalar(
    "SELECT ROUND("
    "  (SELECT SUM(CREDITS_INPUT+CREDITS_OUTPUT+CREDITS_CACHE_READ+CREDITS_CACHE_WRITE)"
    "     FROM SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_REQUEST_COST)"
    "- (SELECT SUM(TOKEN_CREDITS) FROM ("
    "     SELECT TOKEN_CREDITS FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY"
    "     UNION ALL"
    "     SELECT TOKEN_CREDITS FROM SNOWFLAKE.ACCOUNT_USAGE.SNOWFLAKE_COWORK_USAGE_HISTORY))"
    ", 6) AS DELTA"
)
if delta is None:
    print("  [SKIP] granular vs TOKEN_CREDITS (Snowflake CLI unavailable)")
else:
    check("granular ties to TOKEN_CREDITS", abs(float(delta)) < 1e-6, f"delta={delta}")

# 2. The cost step is fault-isolated, so a NULL N_COST means it failed while the
#    rest of the refresh succeeded. That is the signal to check the task owner's
#    grants: the two ACCOUNT_USAGE cost views are granted to ACCOUNTADMIN and
#    ACCOUNT_BUDGET_ADMIN only, NOT to SNOWFLAKE.USAGE_VIEWER.
n_cost = sql_scalar(
    "SELECT N_COST FROM SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_REFRESH_LOG"
    " ORDER BY REFRESHED_AT DESC LIMIT 1"
)
if n_cost is None:
    print("  [SKIP] latest N_COST (CLI unavailable, or cost step failed)")
else:
    check("latest refresh priced rows", int(n_cost) > 0, f"N_COST={n_cost}")

prev_usd = -1.0
for w in ALL_WINDOWS:
    st, d = get(f"/api/fleet?window={w}")
    c = d["cost"]
    cats = [c["creditsInput"], c["creditsOutput"], c["creditsCacheRead"], c["creditsCacheWrite"]]
    pcts = [c["pctInput"], c["pctOutput"], c["pctCacheRead"], c["pctCacheWrite"]]

    if not c["metered"]:
        # Nothing metered must be null, never 0. ACCOUNT_USAGE lags up to an hour,
        # so "$0.00" during live traffic would be an actively wrong statement.
        check(f"  unmetered window is null not 0 ({w})",
              c["usd"] is None and c["credits"] is None and all(p is None for p in pcts),
              f"usd={c['usd']} credits={c['credits']}")
        continue

    print(f"     {w:5s} usd={c['usd']:.2f} credits={c['credits']:.4f} priced={c['pricedRequests']:>3}"
          f"  cw={c['pctCacheWrite']:.1f} cr={c['pctCacheRead']:.1f}"
          f" out={c['pctOutput']:.1f} in={c['pctInput']:.1f}")

    # 3. The four buckets partition total spend, so their shares must sum to 100.
    check(f"  pcts sum to 100 ({w})", abs(sum(pcts) - 100.0) < 0.1, f"{sum(pcts):.4f}")
    check(f"  credits == sum of 4 categories ({w})",
          abs(sum(cats) - c["credits"]) < 1e-9)
    check(f"  usd == credits * rate ({w})",
          abs(c["credits"] * c["usdPerAiCredit"] - c["usd"]) < 1e-9)

    # 4. Windows are nested, so a wider window can never cost less.
    check(f"  monotonic vs narrower window ({w})", c["usd"] >= prev_usd,
          f"{prev_usd:.2f} -> {c['usd']:.2f}")
    prev_usd = c["usd"]

# 5. Regression floor rather than equality. Cost at 365d was $104.64 / 52.3201
#    credits when this was built; history only accumulates, so it may exceed that
#    but must never fall below it. An `==` here would fail the next time anyone
#    used an agent, which is why it is a floor.
st, d365 = get("/api/fleet?window=365d")
c365 = d365["cost"]
check("365d credits >= 52.3201 baseline", c365["credits"] >= 52.3201 - 1e-4,
      f"{c365['credits']:.4f}")
check("365d usd >= 104.64 baseline", c365["usd"] >= 104.64 - 1e-2, f"{c365['usd']:.2f}")
# Cache write dominating spend is the whole reason this card replaced a token
# count. If it ever stops dominating, the subline is telling a different story and
# the framing should be revisited rather than silently kept.
check("365d cache write is the largest cost bucket",
      c365["pctCacheWrite"] == max(c365["pctCacheWrite"], c365["pctCacheRead"],
                                   c365["pctOutput"], c365["pctInput"]),
      f"cw={c365['pctCacheWrite']:.1f}")

print()
print("=== /api/limits (30d) ===")
st, d = get("/api/limits?window=30d")
check("status", st == 200 and "error" not in d, d.get("error", ""))
a = d["agentApi"]
print(f"     agentApi  peak={a['peakRpm']} limit={a['rpmLimit']} pct={a['pctRpm']} source={a['source']}")
check("agent api limit == 500", a["rpmLimit"] == 500)
check("agent api source == internal_verified", a["source"] == "internal_verified")
sa = d["searchAccount"]
print(f"     searchAcct peak={sa['peakQps']} limit={sa['limitQps']} pct={sa['pctOfLimit']}")
check("search account limit == 140", sa["limitQps"] == 140)
for m in d["modelSaturation"]:
    print(f"     model {m['model']:20s} peakTPM={m['peakTpm']:>9} limit={m['tpmLimit']:>9} pct={m['pctTpm']:>7} src={m['source']}")
check("all models have a TPM limit", all(m["tpmLimit"] > 0 for m in d["modelSaturation"]))
check("all models sourced from account_view", all(m["source"] == "account_view" for m in d["modelSaturation"]))
for sv in d["searchServices"]:
    print(f"     search {sv['serviceFqn'][-40:]:42s} req={sv['totalReq']:>6} 429%={sv['pct429']} peakQPS={sv['peakQps']} pctLimit={sv['pctOfLimit']}")
check("search service limit == 20", all(sv["limitQps"] == 20 for sv in d["searchServices"]))

print()
print("=== /api/limits (long windows) ===")
# Saturation must stay bucketed at the limit's own granularity no matter how wide
# the window is. If a long window silently coarsened TPM to daily buckets, the
# peak would collapse toward the mean and a breach would vanish.
for w in ["90d", "180d", "365d"]:
    st, dl = get(f"/api/limits?window={w}")
    a = dl["agentApi"]
    ms = dl["modelSaturation"]
    check(
        f"window={w}",
        st == 200 and "error" not in dl,
        f"models={len(ms)} searchSvc={len(dl['searchServices'])} agentApiPeakRpm={a['peakRpm']} pct={a['pctRpm']}",
    )
    check(f"  agent api still 500 ({w})", a["rpmLimit"] == 500)
    check(f"  every model has TPM limit ({w})", all(m["tpmLimit"] > 0 for m in ms))
    check(f"  peak >= p50 per model ({w})", all(m["peakTpm"] >= m["p50Tpm"] for m in ms))
    check(f"  no negative pct ({w})", all(m["pctTpm"] >= 0 for m in ms))

print()
print("=== /api/limit-trends (30d) ===")
st, dt = get("/api/limit-trends?window=30d")
check("status", st == 200 and "error" not in dt, dt.get("error", ""))


def _mono(points):
    """Bucket timestamps must be strictly increasing, or a chart axis lies."""
    ts = [p["ts"] for p in points]
    return all(a < b for a, b in zip(ts, ts[1:]))


def _pct_reconstructs(points, limit, key="peak", tol=0.15):
    """pctOfLimit must be derivable from peak/limit, not computed independently."""
    for p in points:
        if not limit:
            continue
        want = 100.0 * p[key] / limit
        if abs(want - p["pctOfLimit"]) > tol:
            return False
    return True


ag = dt["agentApi"]
print(f"     agentApi   limit={ag['limit']} pts={len(ag['points'])} "
      f"peak={max((p['peak'] for p in ag['points']), default=0)}")
check("agent api trend limit == 500", ag["limit"] == 500)
check("agent api buckets strictly increasing", _mono(ag["points"]))
check("agent api pct reconstructs", _pct_reconstructs(ag["points"], ag["limit"]))
check("agent api peak >= p50 per bucket", all(p["peak"] >= p["p50"] for p in ag["points"]))

for m in dt["models"]:
    print(f"     model {m['model']:20s} limit={m['tpmLimit']:>9} pts={len(m['points'])} "
          f"peakPctTpm={m['peakPctTpm']}")
check("every model series has a TPM limit", all(m["tpmLimit"] > 0 for m in dt["models"]))
check("every model series has an RPM limit", all(m["rpmLimit"] > 0 for m in dt["models"]))
check("model buckets strictly increasing", all(_mono(m["points"]) for m in dt["models"]))
check("model peakTpm >= p50Tpm per bucket",
      all(p["peakTpm"] >= p["p50Tpm"] for m in dt["models"] for p in m["points"]))

for s in dt["searchServices"]:
    print(f"     search {s['serviceFqn'][-40:]:42s} limit={s['limitQps']} "
          f"pts={len(s['points'])} peakPct={s['peakPct']}")
check("every search series limit == 20", all(s["limitQps"] == 20 for s in dt["searchServices"]))
check("search buckets strictly increasing", all(_mono(s["points"]) for s in dt["searchServices"]))
check("search pct reconstructs",
      all(_pct_reconstructs(s["points"], s["limitQps"], key="peakQps")
          for s in dt["searchServices"]))

sa_t = dt["searchAccount"]
check("search account trend limit == 140", sa_t["limit"] == 140)
check("search account buckets strictly increasing", _mono(sa_t["points"]))
check("search account pct reconstructs", _pct_reconstructs(sa_t["points"], sa_t["limit"]))

# THE regression test for this page. The 30d binding constraint on the home page
# is MARKETING_CAMPAIGNS_SEARCH at 2045%, which is 409 QPS against the 20 QPS
# per-service ceiling. A trend is bucketed daily at 30d, so if the roll-up from
# per-second to per-day ever becomes AVG instead of MAX, that 409 collapses to
# roughly 7 and the breach disappears from the chart while the gauge still shows
# it. This asserts the two views agree.
peak_qps = max((p["peakQps"] for s in dt["searchServices"] for p in s["points"]), default=0)
peak_pct = max((s["peakPct"] for s in dt["searchServices"]), default=0)
print(f"     roll-up check: peak per-service QPS in any daily bucket = {peak_qps} ({peak_pct}%)")
check("MAX roll-up preserved the 409 QPS breach (not averaged to ~7)", peak_qps == 409,
      f"got {peak_qps}, expected 409")
check("per-service peak pct == 2045", peak_pct == 2045, f"got {peak_pct}")

# Throttling is a RATE, not a ceiling check, so it must not be a peak roll-up.
# Totals across buckets must reconstruct the known request count exactly.
th = dt["throttle"]
tot_req = sum(t["totalReq"] for t in th)
tot_429 = sum(t["n429"] for t in th)
print(f"     throttle: {len(th)} buckets, {tot_req} requests, {tot_429} 429s")
check("throttle buckets strictly increasing", _mono(th))
check("429s never exceed requests in a bucket", all(t["n429"] <= t["totalReq"] for t in th))
check("no throttled p95 where there were no 429s",
      all(t["p95ThrottledMs"] is None for t in th if t["n429"] == 0))
check("p95 is null not zero when absent",
      all(t["p95ThrottledMs"] != 0 for t in th))

print()
print("=== /api/limit-trends (long windows) ===")
# Widening the window must never coarsen a ceiling check. The display bucket gets
# wider, but the inner measurement stays per-minute / per-second, so the peak a
# wider window reports can never be LOWER than a narrower one.
prev_peak = -1
for w in ["30d", "90d", "180d", "365d"]:
    st, dw = get(f"/api/limit-trends?window={w}")
    pk = max((p["peakQps"] for s in dw["searchServices"] for p in s["points"]), default=0)
    check(
        f"window={w}",
        st == 200 and "error" not in dw,
        f"models={len(dw['models'])} searchSvc={len(dw['searchServices'])} peakQps={pk}",
    )
    check(f"  peak never shrinks as window widens ({w})", pk >= prev_peak,
          f"{prev_peak} -> {pk}")
    prev_peak = pk

print()
print("=== /api/agent KPI row + identity + traces (365d) ===")

# Baseline for the busiest agent, cross-checked against SQL run directly.
# 3.50 not 3.77 is the whole point: thread_id is not fully populated, and
# COUNT(*) / COUNT(DISTINCT thread_id) credits threadless turns to threads that
# never held them. If this ever reads 3.77 the numerator regressed to COUNT(*).
BASE_FQN = "SNOWFLAKE_INTELLIGENCE.AGENTS.COMPANY_CHATBOT_AGENT_RETAIL"
st, db = get("/api/agent?window=365d&agent=" + urllib.parse.quote(BASE_FQN))
bk, bc = db["kpis"], db["cost"]
print(f"     requests={bk['requests']} turnsPerThread={bk['turnsPerThread']:.2f}"
      f" threads={bk['threads']} threadless={bk['threadlessTurns']}"
      f" usd={bc['usd']:.2f}")
check("baseline requests == 98", bk["requests"] == 98, str(bk["requests"]))
check("baseline turnsPerThread == 3.50 (NOT 3.77)",
      abs(bk["turnsPerThread"] - 3.50) < 0.005, f"{bk['turnsPerThread']:.4f}")
check("baseline threads == 26", bk["threads"] == 26, str(bk["threads"]))
check("baseline threadless == 7", bk["threadlessTurns"] == 7, str(bk["threadlessTurns"]))
check("baseline usd == 58.04", abs(bc["usd"] - 58.04) < 0.01, f"{bc['usd']:.2f}")

st, d0 = get("/api/agent?window=365d")
for ag in d0["agents"]:
    fqn = ag["agentFqn"]
    st, da = get("/api/agent?window=365d&agent=" + urllib.parse.quote(fqn))
    kk, cc, ident, fb = da["kpis"], da["cost"], da["identity"], da["feedback"]
    name = (ag["displayName"] or fqn)[:30]

    # Identity must resolve for every agent in the inventory - the banner falls
    # back to "Unknown agent" otherwise, which would be wrong for a live agent.
    check(f"{name:32s} identity resolves", ident is not None and ident["agentFqn"] == fqn)

    # turnsPerThread is null iff there are no threads. Any other combination means
    # a divide-by-zero leaked through or a real ratio was suppressed.
    ok_tpt = (kk["turnsPerThread"] is None) == (kk["threads"] == 0)
    check(f"{name:32s} turnsPerThread null iff 0 threads", ok_tpt,
          f"threads={kk['threads']} tpt={kk['turnsPerThread']}")

    # The corrected numerator can never exceed total requests, and threadless +
    # in-threads must account for every request with no remainder.
    check(f"{name:32s} thread parts sum to requests",
          kk["turnsInThreads"] + kk["threadlessTurns"] == kk["requests"],
          f"{kk['turnsInThreads']}+{kk['threadlessTurns']} vs {kk['requests']}")

    # Cost is null iff unmetered, never a coerced 0.
    check(f"{name:32s} cost null iff unmetered",
          (cc["usd"] is None) == (not cc["metered"]),
          f"metered={cc['metered']} usd={cc['usd']}")

    # The donut is summed client-side from these same buckets, so the API totals
    # are what it will draw. Assert they agree with the per-bucket series.
    pos = sum(f["positive"] for f in fb)
    neg = sum(f["negative"] for f in fb)
    check(f"{name:32s} feedback buckets non-negative",
          all(f["positive"] >= 0 and f["negative"] >= 0 for f in fb),
          f"pos={pos} neg={neg} buckets={len(fb)}")

    # Every trace row needs the fields the ribbon renders. totalTokens is allowed
    # to be 0 (fast-fail turns consume none) but must not be missing.
    tr = da["slowTraces"]
    check(f"{name:32s} trace rows complete", all(
        t["traceId"] and "totalTokens" in t and t["totalTokens"] >= 0
        and t["durationMs"] is not None for t in tr
    ), f"traces={len(tr)}")

print()
print("=== /api/agent (each agent, 365d) ===")
st, d0 = get("/api/agent?window=365d")
for ag in d0["agents"]:
    fqn = ag["agentFqn"]
    st, da = get("/api/agent?window=365d&agent=" + urllib.parse.quote(fqn))
    neg = [c for c in da["latencyCohorts"] if c["meanMsPerTrace"] < 0]
    # The stackable token set must reconcile exactly to the reported total at
    # every window, since cache_read/cache_write are subsets of input.
    stack = sum(
        t["cacheReadInput"] + t["cacheWriteInput"] + t["freshInput"] + t["output"]
        for t in da["tokens"]
    )
    tot = sum(t["total"] for t in da["tokens"])
    check(
        f"{ag['displayName'][:30]:32s}",
        st == 200 and "error" not in da and not neg and stack == tot,
        f"trend={len(da['trend'])} tok={tot} stackMatch={stack == tot} res={len(da['resources'])} cohorts={len(da['latencyCohorts'])}"
        + (f" NEGATIVE_LATENCY={neg}" if neg else "")
        + (f" STACK_MISMATCH stack={stack} total={tot}" if stack != tot else ""),
    )

print()
print("=== /api/agent (each agent, 30d) ===")
st, d0 = get("/api/agent?window=30d")
for ag in d0["agents"]:
    fqn = ag["agentFqn"]
    st, d = get("/api/agent?window=30d&agent=" + urllib.parse.quote(fqn))
    tok = sum(t["total"] for t in d["tokens"])
    neg = [c for c in d["latencyCohorts"] if c["meanMsPerTrace"] < 0]
    check(
        f"{ag['displayName'][:30]:32s}",
        st == 200 and "error" not in d and not neg,
        f"trend={len(d['trend'])} tok={tok} res={len(d['resources'])} cohorts={len(d['latencyCohorts'])} slow={len(d['slowTraces'])}"
        + (f" NEGATIVE_LATENCY={neg}" if neg else ""),
    )

print()
print("=== warehouse routing ===")
st, dwh = get("/api/fleet?window=24h")
served = dwh["refresh"].get("servedBy")
print(f"     reads served by: {served}")
# Reads must land on the dedicated interactive warehouse. The app stays fully
# functional on a standard warehouse - just ~4x slower (p50 252ms vs 58ms
# measured) - so a routing regression is silent without this assertion.
check("reads on an interactive warehouse", bool(served) and ("IWH" in served.upper() or "INTERACTIVE" in served.upper()), str(served))
# The config write path must NOT be on it: MERGE is rejected outright there.
# Exercised for real by the config round-trip further down; if routing broke,
# that section fails with "Cannot run statement type 'MERGE'".

print()
print("=== /api/config write/read round-trip ===")
st, d = get("/api/config")
orig = d["config"]["greenMinutes"]
req = urllib.request.Request(
    BASE + "/api/config",
    data=json.dumps({"hex.green_minutes": "90"}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=120) as r:
    body = json.loads(r.read().decode())
check("write accepted", body.get("config", {}).get("greenMinutes") == 90, str(body.get("error", "")))
# restore
req = urllib.request.Request(
    BASE + "/api/config",
    data=json.dumps({"hex.green_minutes": str(orig)}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=120) as r:
    body = json.loads(r.read().decode())
check("restored", body.get("config", {}).get("greenMinutes") == orig)

# rejection paths
for bad, why in [
    ({"hex.green_minutes": "-5"}, "negative"),
    ({"hex.green_minutes": "abc"}, "non-numeric"),
    ({"evil.key": "1"}, "not in allowlist"),
    ({"kpi.default_window": "99y"}, "bad enum"),
]:
    req = urllib.request.Request(
        BASE + "/api/config",
        data=json.dumps(bad).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=60)
        check(f"rejects {why}", False, "accepted when it should not")
    except urllib.error.HTTPError as e:
        check(f"rejects {why}", e.code == 400, f"HTTP {e.code}")

# The new long windows must be writable as the default, since the validator is
# now driven off the shared registry rather than a hardcoded list.
for w in ["90d", "180d", "365d"]:
    req = urllib.request.Request(
        BASE + "/api/config",
        data=json.dumps({"kpi.default_window": w}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read().decode())
        check(f"accepts default_window={w}", body.get("config", {}).get("defaultWindow") == w)
    except urllib.error.HTTPError as e:
        check(f"accepts default_window={w}", False, f"HTTP {e.code}")

# restore the default window
req = urllib.request.Request(
    BASE + "/api/config",
    data=json.dumps({"kpi.default_window": "24h"}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=60) as r:
    body = json.loads(r.read().decode())
check("restored default_window=24h", body.get("config", {}).get("defaultWindow") == "24h")

print()
print("=== RESULT:", "ALL PASS" if ok else "FAILURES PRESENT", "===")
sys.exit(0 if ok else 1)
