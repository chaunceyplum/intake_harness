"""Plain-English -> PQL eval against a running app (Demo, draftOnly - creates nothing). Usage: python3 scripts/nl-audience-eval.py [case ...]

Each case lists the conditions the rule MUST contain (regexes over the PQL,
field names without the tenant prefix) and ones it must NOT contain.
"""
import json, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

import os
BASE = os.environ.get("APP_URL", "http://localhost:3100")
T = r"_taplondonptrsd\."
Y = lambda f: rf'{T}{f}\s*=\s*"Y"'
N = lambda f: rf'({T}{f}\s*=\s*"N"|{T}{f}\s*!=\s*"Y"|not\s*\(?\s*{T}{f}\s*=\s*"Y")'
NOT_DNC = N("doNotContact")
EMAIL = rf'({T}emailAddress\.isNotNull\(\)|{T}emailAddress\.exists\(\)|{T}validEmailFlag\s*=\s*"Y")'

CASES = [
    ("cbm_full", "Customers who are Comcast Business Mobile members", [Y("isCBMmember")], []),
    ("cbm_abbrev", "CBM members", [Y("isCBMmember")], []),
    ("cbi_no_sep", "Comcast Business Internet members who don't have Security Edge Preferred", [Y("isCBInternetMember"), N("hasSEP")], []),
    ("sep_upsell", "Businesses eligible for Security Edge Preferred that don't already have it", [Y("SEPeligible"), N("hasSEP")], []),
    ("sep_has", "Security Edge Preferred customers", [Y("hasSEP")], [r"SEPeligible"]),
    ("size_gt_cbm", "Companies with more than 50 employees that have CBM", [rf"{T}companySize\s*>\s*50", Y("isCBMmember")], []),
    ("size_lt_valid", "Small businesses under 10 employees with a valid email address", [rf"{T}companySize\s*<\s*10", Y("validEmailFlag")], []),
    ("size_between", "Companies with between 20 and 200 employees", [rf"{T}companySize\s*>=\s*20", rf"{T}companySize\s*<=\s*200"], []),
    ("size_atleast_contactable", "Companies with at least 100 employees that we are allowed to contact", [rf"{T}companySize\s*>=\s*100", NOT_DNC], []),
    ("email_not_dnc", "Everyone with an email address, excluding anyone marked do not contact", [EMAIL, NOT_DNC], []),
    ("dnc_only", "Anyone flagged as do not contact", [Y("doNotContact")], []),
    ("invalid_email", "Customers whose email address is not valid", [N("validEmailFlag")], []),
    ("both_products", "Customers with both Comcast Business Mobile and Comcast Business Internet", [Y("isCBMmember"), Y("isCBInternetMember")], [r"\bor\b"]),
    ("either_product", "Customers that have either CBM or CB Internet", [Y("isCBMmember"), Y("isCBInternetMember"), r"\bor\b"], []),
    ("typos", "cbm memebrs with sep elegibility", [Y("isCBMmember"), Y("SEPeligible")], []),
    ("complex", "SEP eligible CB Internet customers who are not mobile members, with a valid email and not on the do not contact list",
     [Y("SEPeligible"), Y("isCBInternetMember"), N("isCBMmember"), Y("validEmailFlag"), NOT_DNC], []),
    ("exec_style", "I need an audience of Comcast Business Internet customers without Comcast Business Mobile so we can cross-sell mobile - only people we can email",
     [Y("isCBInternetMember"), N("isCBMmember")], []),
]


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)


def run_case(case):
    name, brief, must, must_not = case
    t0 = time.time()
    try:
        run = call("POST", "/api/runs", {"input": {"brief": brief, "mode": "demo", "draftOnly": True}})["run"]
        detail = call("GET", f"/api/runs/{run['run_id']}")
    except Exception as e:
        return {"name": name, "error": str(e)}
    steps = detail["taskRuns"]
    last = steps[-1]
    ac = next((s for s in steps if s["task_id"] == "audience_creation"), None)
    out = {"name": name, "brief": brief, "run": run["run_id"], "status": detail["run"]["status"],
           "secs": round(time.time() - t0), "pql": None, "paused": None, "reason": None}
    if detail["run"]["status"] == "needs_input":
        out["paused"] = f'{last["task_id"]}: {last.get("message")}'
    if ac:
        aud = (ac.get("output") or {}).get("audience") or {}
        m = re.search(r"Wrote the rule (.+?) \(fields verified", ac.get("message") or "")
        out["pql"] = aud.get("pql") or (m.group(1) if m else None)
        if not out["pql"]:
            out["reason"] = (ac.get("message") or "")[:400]
    pql = out["pql"] or ""
    out["missing"] = [p for p in must if not re.search(p, pql, re.I)]
    out["forbidden"] = [p for p in must_not if re.search(p, pql, re.I)]
    out["pass"] = bool(pql) and not out["missing"] and not out["forbidden"]
    return out


if __name__ == "__main__":
    only = set(sys.argv[1:])
    cases = [c for c in CASES if not only or c[0] in only]
    # One at a time by default: cheaper to stop early, and parallel cold-cache runs once overloaded the gateway.
    with ThreadPoolExecutor(max(1, min(4, int(os.environ.get("EVAL_WORKERS", "1"))))) as ex:
        results = list(ex.map(run_case, cases))
    for r in results:
        mark = "PASS" if r.get("pass") else "FAIL"
        print(f'{mark} {r["name"]} ({r.get("secs")}s) run={r.get("run")}')
        print(f'     brief: {r.get("brief")}')
        print(f'     pql:   {r.get("pql")}')
        for k in ("error", "paused", "reason"):
            if r.get(k):
                print(f"     {k}: {r[k]}")
        if r.get("missing"):
            print(f'     missing: {r["missing"]}')
        if r.get("forbidden"):
            print(f'     forbidden: {r["forbidden"]}')
    print(f'\n{sum(1 for r in results if r.get("pass"))}/{len(results)} passed')
    json.dump(results, open("nl-audience-eval-results.json", "w"), indent=1)
