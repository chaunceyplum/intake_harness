#!/usr/bin/env python3
"""Is the CX demo going to work right now?

Run this before a demo, or any time something looks wrong, and it answers that
question in about ten seconds without anyone having to SSH anywhere.

    python tools/system-check/check.py            # terminal checklist + open the report
    python tools/system-check/check.py --no-open  # terminal only
    python tools/system-check/check.py --json     # machine readable

WHAT IT CHECKS, AND WHY EACH ONE EARNS ITS PLACE

Every check here is one that has actually broken and taken a demo with it. The
order is the order things fail in: the box, then the two services, then the
things they depend on, then whether the code running is the code we think.

The one that matters most is the gateway. `list_gateway_tools` reports a tool
count per MCP server, and a count only comes back if the server was reached and
its tools listed - which for Adobe means the OAuth token was accepted. An
expired Adobe token is the single most common way this demo dies quietly, and it
shows up here as a server with an error and no tools, rather than as a confusing
failure twenty minutes later in front of a client.

CREDENTIALS

The deep checks need a dashboard login. It is NOT stored in this file. Set it in
the environment:

    AM_USER=admin  AM_PASS=...  python tools/system-check/check.py

Without it the shallow checks still run and the deep ones report SKIPPED with
that instruction, rather than passing silently and telling you nothing.

Standard library only, so it runs anywhere Python does with nothing installed.
"""

import argparse
import json
import os
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone

HOST = os.environ.get("AM_HOST", "34.203.238.63")
HARNESS = "http://%s:3100" % HOST
MANAGER = "http://%s:8080" % HOST
PROXY = MANAGER + "/dashboard-api"
REPO = os.environ.get("AM_REPO", "chaunceyplum/intake_harness")

# What the gateway should be carrying. A server that drops to zero tools has
# lost its connection or its token; a count that merely drifts is fine, because
# Adobe add tools without telling us.
EXPECTED_SERVERS = {"workfront-adobe": 90, "adobe-aec": 200}

OK, WARN, FAIL, SKIP = "ok", "warn", "fail", "skip"


class Check:
    """One line of the checklist."""

    def __init__(self, key, title, why):
        self.key, self.title, self.why = key, title, why
        self.state, self.detail, self.evidence, self.fix = SKIP, "", "", ""
        self.ms = 0

    def as_dict(self):
        return {
            "key": self.key, "title": self.title, "why": self.why,
            "state": self.state, "detail": self.detail,
            "evidence": self.evidence, "fix": self.fix, "ms": self.ms,
        }


def http(url, method="GET", body=None, headers=None, timeout=10):
    """Returns (status, text). Never raises - a check decides what a failure means.

    The timeout is short deliberately. When the box is DOWN every check waits
    out its own timeout, so a generous one turns "is it up?" into a two-minute
    answer at the exact moment you need a ten-second one. The box answers in
    under two seconds when healthy; anything slower is itself a fault.
    """
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, str(e)


def login_headers():
    user, pw = os.environ.get("AM_USER"), os.environ.get("AM_PASS")
    if user and pw:
        return {"x-cookbook-user-id": user, "x-cookbook-password": pw}
    return None


def proxy_tool(name, args=None, timeout=30):
    """Call an MCP tool through the dashboard proxy, which holds the service key
    server-side. Returns (parsed, error_string)."""
    h = login_headers()
    if not h:
        return None, "no credential"
    status, text = http(
        PROXY, "POST",
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
         "params": {"name": name, "arguments": args or {}}},
        h, timeout,
    )
    if status != 200:
        return None, "HTTP %s %s" % (status, (text or "")[:160])
    try:
        d = json.loads(text)
        if d.get("error"):
            return None, str(d["error"].get("message"))[:200]
        inner = (((d.get("result") or {}).get("content") or [{}])[0]).get("text", "")
        return json.loads(inner), None
    except Exception as e:
        return None, "unreadable answer: %s" % str(e)[:120]


# --------------------------------------------------------------- the checks

def check_ports(c):
    open_ports, shut = [], []
    for port in (3100, 8080):
        s = socket.socket()
        s.settimeout(4)
        try:
            s.connect((HOST, port))
            open_ports.append(port)
        except Exception:
            shut.append(port)
        finally:
            s.close()
    c.evidence = "open: %s" % (open_ports or "none")
    if shut:
        c.state, c.detail = FAIL, "Port(s) %s not answering on %s." % (shut, HOST)
        c.fix = ("The box or a container is down. SSH in and run "
                 "`sudo docker ps` - if a container is missing, "
                 "`/home/ubuntu/up-harness.sh` / `up-manager.sh` restart them.")
    else:
        c.state, c.detail = OK, "Both service ports are answering on %s." % HOST


def check_harness(c):
    status, text = http(HARNESS + "/api/runs")
    if status != 200:
        c.state = FAIL
        c.detail = "The harness did not answer /api/runs (%s)." % status
        c.evidence = (text or "")[:200]
        c.fix = "Restart it: `/home/ubuntu/up-harness.sh`, then re-run this check."
        return
    try:
        runs = json.loads(text).get("runs") or []
    except Exception:
        c.state, c.detail = WARN, "The harness answered, but not with run JSON."
        c.evidence = (text or "")[:200]
        return
    c.state = OK
    c.detail = "The harness is serving %d run(s)." % len(runs)
    if runs:
        newest = runs[0]
        c.evidence = "latest: %s  status=%s" % (
            str(newest.get("run_id"))[:8], newest.get("status"))


def check_dashboard(c):
    status, text = http(MANAGER + "/")
    if status != 200:
        c.state, c.detail = FAIL, "The dashboard did not load (%s)." % status
        c.fix = "Restart it: `/home/ubuntu/up-manager.sh`."
        return
    if "CX Agent Manager" not in (text or ""):
        c.state, c.detail = WARN, "Something is serving on 8080, but it is not the dashboard."
        c.evidence = (text or "")[:160]
        return
    c.state, c.detail = OK, "The dashboard is being served."
    c.evidence = "%s/" % MANAGER


def check_mcp_auth(c):
    """An unauthenticated MCP call MUST be refused.

    This is the one check where a 200 is the bad answer: it would mean anyone
    who can reach the box can drive the agents. 401 is the healthy result.
    """
    status, text = http(MANAGER + "/mcp", "POST",
                        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                        {"accept": "application/json, text/event-stream"})
    if status == 200:
        c.state = FAIL
        c.detail = "THE MCP ENDPOINT ANSWERED WITHOUT A CREDENTIAL."
        c.evidence = (text or "")[:200]
        c.fix = ("Treat as urgent: anyone who can reach this box can drive the "
                 "agents. Check the auth configuration before demoing.")
    elif status in (401, 403):
        c.state = OK
        c.detail = "The MCP endpoint is up and refusing anonymous calls (%s)." % status
    elif status is None:
        c.state, c.detail = FAIL, "The MCP endpoint is unreachable."
        c.evidence = (text or "")[:160]
        c.fix = "Restart Agent Manager: `/home/ubuntu/up-manager.sh`."
    else:
        c.state, c.detail = WARN, "Unexpected answer from /mcp (%s)." % status
        c.evidence = (text or "")[:160]


def check_oauth_discovery(c):
    status, text = http(MANAGER + "/.well-known/oauth-protected-resource")
    if status != 200:
        c.state, c.detail = FAIL, "OAuth discovery is not being served (%s)." % status
        c.fix = "Claude Desktop cannot connect without this. Restart Agent Manager."
        return
    try:
        d = json.loads(text)
        c.state, c.detail = OK, "Claude Desktop can discover how to sign in."
        c.evidence = "resource: %s" % d.get("resource")
    except Exception:
        c.state, c.detail = WARN, "Discovery answered with something unreadable."
        c.evidence = (text or "")[:160]


def check_gateway(c):
    """The big one: are the upstream MCP servers connected and their tokens good?

    A tool count only comes back if the server was reached AND its tools listed,
    which for Adobe means the OAuth token was accepted. This is where an expired
    token shows up - as an error here, rather than as a baffling failure in the
    middle of a demo.
    """
    data, err = proxy_tool("list_gateway_tools")
    if err == "no credential":
        c.state = SKIP
        c.detail = "Skipped: no dashboard login available."
        c.fix = "Set AM_USER and AM_PASS in the environment to enable this check."
        return
    if err:
        c.state, c.detail = FAIL, "Could not read gateway status."
        c.evidence = err
        c.fix = "If this says 401, the login is wrong. Otherwise Agent Manager is unhealthy."
        return

    servers = data.get("servers") or []

    # A SERVER THE DEMO DOES NOT USE MUST NOT BE ABLE TO FAIL THE DEMO.
    #
    # This failed the whole verdict on ANY registered server with no tools.
    # `workfront-inhouse` is registered and its route has never been deployed
    # at that gateway - it has answered 404 every time it has been asked - so
    # "is the demo ready" came back NOT READY on a perfectly good day. That is
    # the fastest possible way to teach somebody to stop reading this output,
    # and then the one real red goes past unnoticed too.
    #
    # EXPECTED_SERVERS is the set the demo actually depends on. Those still
    # FAIL, on an error, on zero tools, on a count that has collapsed, and on
    # being absent altogether. Anything else WARNS and is named, because a dead
    # registration is worth removing and is not worth stopping for.
    lines, bad, stale = [], [], []
    for s in servers:
        sid, n, e = s.get("id"), s.get("tool_count") or 0, s.get("error")
        lines.append("%s: %s tools%s" % (sid, n, " - %s" % e if e else ""))
        expected = sid in EXPECTED_SERVERS
        floor = EXPECTED_SERVERS.get(sid)
        if e or n == 0:
            (bad if expected else stale).append("%s (%s)" % (sid, e or "no tools"))
        elif floor and n < floor:
            bad.append("%s only %d tools, expected about %d" % (sid, n, floor))
    for sid in EXPECTED_SERVERS:
        if not any(s.get("id") == sid for s in servers):
            bad.append("%s is not registered at all" % sid)

    c.evidence = " | ".join(lines) or "no servers"
    live = [s for s in servers if (s.get("tool_count") or 0) > 0]
    if bad:
        c.state, c.detail = FAIL, "Gateway problem: " + "; ".join(bad)
        c.fix = ("Usually an expired Adobe token. Open Settings in the dashboard "
                 "and re-authenticate the affected server, then re-run this.")
    elif stale:
        c.state = WARN
        c.detail = ("The servers the demo needs are connected. Dead registration: "
                    + "; ".join(stale))
        c.fix = ("Nothing here blocks a demo - no agent calls these. Either deploy "
                 "the route or remove the server in Settings, so this line stops "
                 "appearing and a real failure stands out.")
    else:
        c.state = OK
        c.detail = ("All %d MCP server(s) connected, tools listing - so the Adobe tokens are live."
                    % len(live))


def check_runs_health(c):
    status, text = http(HARNESS + "/api/runs")
    if status != 200:
        c.state, c.detail = SKIP, "Skipped: the harness is not answering."
        return
    try:
        runs = json.loads(text).get("runs") or []
    except Exception:
        c.state, c.detail = SKIP, "Skipped: could not read the run list."
        return
    if not runs:
        c.state, c.detail = WARN, "No runs on the box yet."
        return
    counts = {}
    for r in runs:
        counts[r.get("status")] = counts.get(r.get("status"), 0) + 1
    c.evidence = ", ".join("%s: %d" % kv for kv in sorted(counts.items()))
    failed = counts.get("failed", 0)
    waiting = counts.get("awaiting_approval", 0) + counts.get("needs_input", 0)
    if failed:
        c.state = WARN
        c.detail = "%d run(s) failed. Not necessarily broken now, but worth a look." % failed
        c.fix = "Open the dashboard and read the failed run's stages."
    elif waiting:
        c.state = OK
        c.detail = "%d run(s) waiting on a person - that is the process working, not a fault." % waiting
    else:
        c.state, c.detail = OK, "%d run(s), none failed." % len(runs)


def check_deployed_version(c):
    """Is the box running the code we merged?

    Drift here is how a fix gets merged, celebrated, and then not demoed.
    """
    token = None
    try:
        p = subprocess.run(["git", "credential", "fill"],
                           input="protocol=https\nhost=github.com\n\n",
                           capture_output=True, text=True, timeout=25)
        for line in p.stdout.splitlines():
            if line.startswith("password="):
                token = line.split("=", 1)[1]
    except Exception:
        pass
    if not token:
        c.state = SKIP
        c.detail = "Skipped: no GitHub credential on this machine."
        c.fix = "This check compares the deployed commit with origin/main."
        return

    req = urllib.request.Request("https://api.github.com/repos/%s/branches/main" % REPO)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            b = json.load(r)
    except Exception as e:
        c.state, c.detail = SKIP, "Skipped: could not read GitHub (%s)." % str(e)[:80]
        return

    sha = b["commit"]["sha"][:8]
    subject = b["commit"]["commit"]["message"].split("\n")[0]
    c.state = OK
    c.detail = "main is at %s." % sha
    c.evidence = subject[:110]
    c.fix = ("This reports what SHOULD be deployed. To confirm what IS, ask for a "
             "deploy check - the box reports its own commit over SSH.")


CHECKS = [
    ("ports", "The box is reachable",
     "Nothing else can be true if the ports are shut.", check_ports),
    ("harness", "The harness is answering",
     "It runs the agents. If it is down, no intake can be filed.", check_harness),
    ("dashboard", "The dashboard is being served",
     "This is what you and the client actually look at.", check_dashboard),
    ("mcp", "The MCP endpoint is up and locked",
     "Claude Desktop connects here. A 200 without a credential would be an alarm.", check_mcp_auth),
    ("oauth", "Claude Desktop can discover sign-in",
     "Without this, connecting Claude Desktop fails before it starts.", check_oauth_discovery),
    ("gateway", "Workfront and AEP are connected",
     "A tool count only returns if the Adobe token was accepted. This is the usual demo killer.", check_gateway),
    ("runs", "Recent runs look healthy",
     "Tells you whether the pipeline has been working, not just whether it is up.", check_runs_health),
    ("version", "What main is at",
     "A fix that is merged but not deployed is not a fix.", check_deployed_version),
]

SYMBOL = {OK: "PASS", WARN: "WARN", FAIL: "FAIL", SKIP: "SKIP"}
COLOUR = {OK: "\033[32m", WARN: "\033[33m", FAIL: "\033[31m", SKIP: "\033[90m"}


def run_all():
    results = []
    for key, title, why, fn in CHECKS:
        c = Check(key, title, why)
        t0 = time.time()
        try:
            fn(c)
        except Exception as e:  # a broken check must not hide the others
            c.state, c.detail = FAIL, "The check itself failed: %s" % str(e)[:150]
        c.ms = int((time.time() - t0) * 1000)
        results.append(c)
    return results


def verdict(results):
    if any(c.state == FAIL for c in results):
        return FAIL, "NOT READY - something is broken"
    if any(c.state == WARN for c in results):
        return WARN, "USABLE - with something worth a look"
    if any(c.state == SKIP for c in results):
        return OK, "READY - though some checks were skipped"
    return OK, "READY"


def print_terminal(results):
    state, line = verdict(results)
    use_colour = sys.stdout.isatty()

    def paint(s, text):
        return "%s%s\033[0m" % (COLOUR[s], text) if use_colour else text

    print()
    print("  CX demo system check   %s" % datetime.now().strftime("%d %b %Y, %H:%M"))
    print("  %s" % HOST)
    print("  " + "-" * 62)
    for c in results:
        print("  %s  %-38s %s" % (paint(c.state, SYMBOL[c.state]), c.title, "%dms" % c.ms))
        if c.detail:
            print("        %s" % c.detail)
        if c.evidence:
            print("        %s" % c.evidence[:120])
        if c.fix and c.state in (FAIL, WARN, SKIP):
            print("        -> %s" % c.fix[:160])
    print("  " + "-" * 62)
    print("  %s" % paint(state, line))
    print()


def write_html(results, path):
    state, line = verdict(results)
    badge = {OK: "ok", WARN: "warn", FAIL: "fail"}[state]
    rows = []
    for c in results:
        rows.append("""
      <div class="check {s}">
        <div class="tag">{sym}</div>
        <div class="body">
          <h3>{title}</h3>
          <p class="detail">{detail}</p>
          {ev}
          {fix}
          <p class="why">{why}</p>
        </div>
        <div class="ms">{ms}ms</div>
      </div>""".format(
            s=c.state, sym=SYMBOL[c.state], title=esc(c.title),
            detail=esc(c.detail) or "&nbsp;",
            ev='<p class="ev">%s</p>' % esc(c.evidence) if c.evidence else "",
            fix='<p class="fix">%s</p>' % esc(c.fix) if (c.fix and c.state in (FAIL, WARN, SKIP)) else "",
            why=esc(c.why), ms=c.ms))

    html = TEMPLATE.format(
        badge=badge, verdict=esc(line), host=esc(HOST),
        when=datetime.now().strftime("%d %B %Y, %H:%M"),
        rows="".join(rows),
        counts=" &middot; ".join(
            "%d %s" % (sum(1 for c in results if c.state == s), SYMBOL[s].lower())
            for s in (OK, WARN, FAIL, SKIP)
            if sum(1 for c in results if c.state == s)),
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CX System Check</title>
<style>
  :root {{
    --bg:#f6f7f9; --card:#fff; --ink:#15181d; --muted:#666f7a; --line:#e3e6ea;
    --ok:#1a7f45; --ok-soft:#e7f5ed; --warn:#8a6100; --warn-soft:#fdf3e0;
    --fail:#b3261e; --fail-soft:#fdecea; --skip:#6b7280; --skip-soft:#eef0f2;
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{
      --bg:#14161a; --card:#1c1f25; --ink:#e9ecf0; --muted:#98a2ae; --line:#2b2f37;
      --ok:#5cc98d; --ok-soft:#14301f; --warn:#e0b25a; --warn-soft:#332711;
      --fail:#f2857c; --fail-soft:#3a1a17; --skip:#8b94a0; --skip-soft:#23262c;
    }}
  }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }}
  .wrap {{ max-width:860px; margin:0 auto; padding:32px 16px 64px; }}
  header {{ margin-bottom:24px; }}
  h1 {{ font-size:22px; margin:0 0 4px; letter-spacing:-.01em; }}
  .sub {{ color:var(--muted); font-size:13px; }}
  .verdict {{ margin:20px 0 8px; padding:16px 18px; border-radius:12px;
    font-size:17px; font-weight:650; border:1px solid transparent; }}
  .verdict.ok {{ background:var(--ok-soft); color:var(--ok); border-color:var(--ok); }}
  .verdict.warn {{ background:var(--warn-soft); color:var(--warn); border-color:var(--warn); }}
  .verdict.fail {{ background:var(--fail-soft); color:var(--fail); border-color:var(--fail); }}
  .counts {{ color:var(--muted); font-size:13px; margin-bottom:22px; }}
  .check {{ display:grid; grid-template-columns:62px minmax(0,1fr) auto; gap:14px;
    align-items:start; background:var(--card); border:1px solid var(--line);
    border-radius:12px; padding:14px 16px; margin-bottom:10px; }}
  .tag {{ font-size:11px; font-weight:750; letter-spacing:.06em; text-align:center;
    padding:5px 0; border-radius:6px; }}
  .check.ok .tag {{ background:var(--ok-soft); color:var(--ok); }}
  .check.warn .tag {{ background:var(--warn-soft); color:var(--warn); }}
  .check.fail .tag {{ background:var(--fail-soft); color:var(--fail); }}
  .check.skip .tag {{ background:var(--skip-soft); color:var(--skip); }}
  h3 {{ margin:0 0 3px; font-size:15px; font-weight:620; }}
  .detail {{ margin:0 0 6px; }}
  .ev {{ margin:0 0 6px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px; color:var(--muted); word-break:break-word; }}
  .fix {{ margin:0 0 6px; font-size:13.5px; padding:8px 10px; border-radius:8px;
    background:var(--warn-soft); color:var(--warn); }}
  .check.fail .fix {{ background:var(--fail-soft); color:var(--fail); }}
  .check.skip .fix {{ background:var(--skip-soft); color:var(--skip); }}
  .why {{ margin:0; font-size:12.5px; color:var(--muted); font-style:italic; }}
  .ms {{ color:var(--muted); font-size:12px; white-space:nowrap; }}
  footer {{ margin-top:26px; color:var(--muted); font-size:12.5px; }}
  @media (max-width:560px) {{
    .check {{ grid-template-columns:56px minmax(0,1fr); }}
    .ms {{ display:none; }}
  }}
</style></head>
<body><div class="wrap">
  <header>
    <h1>CX demo system check</h1>
    <div class="sub">{host} &middot; {when}</div>
  </header>
  <div class="verdict {badge}">{verdict}</div>
  <div class="counts">{counts}</div>
  {rows}
  <footer>A snapshot, not a live page - re-run the script for a fresh one.</footer>
</div></body></html>
"""


def main():
    ap = argparse.ArgumentParser(description="Check whether the CX demo is ready.")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--no-open", action="store_true", help="do not open the browser")
    ap.add_argument("--out", default=None, help="where to write the HTML report")
    args = ap.parse_args()

    results = run_all()
    state, line = verdict(results)

    if args.json:
        print(json.dumps({
            "host": HOST,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "verdict": line, "state": state,
            "checks": [c.as_dict() for c in results],
        }, indent=2))
    else:
        print_terminal(results)

    out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "status.html")
    write_html(results, out)
    if not args.json:
        print("  report: %s" % out)
        print()
    if not args.no_open:
        webbrowser.open("file:///" + out.replace("\\", "/"))

    return 1 if state == FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
