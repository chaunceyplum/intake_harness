# Dylan's handover — Comcast/Xfinity creative intake

Dylan — this is yours. It is everything needed to run this demo, ship a change
to it, and know what state it is in, so you can drive it independently rather
than through anyone else.

If something in here turns out to be wrong, that is a bug in the document —
correct it and push. The next person reading it will be you in three weeks.

Read it in order once. After that, section 5 (health check) and section 4
(deploy) are the two you will come back to.

---

## 1. What the demo is

A marketer at Comcast writes a creative brief in plain English. They give it to
Claude Desktop. Four agents then do what a person used to do by hand:

| Agent | What it does |
|---|---|
| **Morpheus** — Brief Agent | Reads the brief, works out what is missing, files the Workfront request |
| **The Architect** — Validation Agent | Checks the request against existing audiences, turns it into a project |
| **Tank** — Segmentation Agent | Builds the audience in Adobe Experience Platform and gets a count |
| **The Keymaker** — Reconciliation Agent | Only runs when something fails. Classifies the failure |

Between Morpheus and The Architect there is **a human approval inside
Workfront**. That is deliberate and it is the one load-bearing human decision
in the process. Nothing downstream — the project, the audience, the spend —
happens without it.

Two services make that work:

- **the harness** — the four agents and the orchestrator that runs them
- **Agent Manager** — the record of every run, and the MCP gateway Claude
  Desktop actually connects to

---

## 2. Why the Dylan role exists, and what you own

This project has had, at various points, five or six AI agents working on it at
once: a marketer persona writing briefs, a friction auditor reading the flow
from the marketer's side, Josh tracking the demo narrative, a Gitkeeper
watching another team's repo, a reviewer merging PRs. Plus Bharat. Plus me.

That is a lot of parallel work with one deliverable, and the failure mode is
not that anything gets forgotten. It is **duplication and drift**: two agents
solving the same defect differently, a fix that never reaches the box, a
"verified" claim about code that was replaced an hour earlier.

That already happened. A second agent was spun up to review another team's pull
request when an agent with exactly that job already existed and had already
done it. Bharat's words at the time, which are worth keeping:

> *"chauncey gitkeeper had exactly same purpose n it did, also dylans job is to
> manage work better, he should have made sure this goes to chauncey existing
> agent, optimize ur workflow man, stop becoming a mess"*

**So the Dylan role is the one that stops it becoming a mess.** Concretely, you
own three things:

1. **Routing.** When work appears, it goes to the agent that already has that
   job. You do not create a new agent for a job that has an owner. If you are
   not sure who owns it, that is itself the finding — write it down.
2. **Priority.** There is one organising goal at any time, and everything is
   ranked against it. Right now it is: *the intake flow works end to end from
   Claude Desktop, in time for the demo.* Anything that does not move that is
   parked, not done quietly.
3. **The worklog.** [`WORKLOG.md`](WORKLOG.md) in this folder. It is rewritten
   in full each working session, and every claim in it carries its evidence —
   a commit, an API response, a line number. A claim without evidence is a
   guess, and this project has been burned by confident guesses more than by
   anything else.

The worklog's own methodological notes are worth reading before you write one.
The most important is this: **run-history aggregates span code versions.** "The
agent asks two questions" was true of one build and false of the next. Always
say which version a number is about.

---

## 3. The Dylan agent, and how to use it from your own machine

`.claude/agents/dylan.md` in this repo is an agent definition. When you clone
this branch and open Claude Code in it, you get a `dylan` agent that already
knows everything in this document — the box, the deploy process, the routing
rules, the branch story, and what is still broken.

It is there to save you a chore, not to hold the role. Without it, every
session starts with you re-explaining this document to a fresh Claude and
getting a slightly different answer depending on what you happened to
emphasise. The definition makes that briefing identical every time, and it
lives in git, so a fact that changes changes in one place.

Use it, ignore it, or point your own Claude at this document instead —
whichever is faster for you on the day. The agent is a convenience; the
judgement is yours.

```bash
git clone https://github.com/chaunceyplum/intake_harness.git
cd intake_harness
git checkout dylan
claude          # then: /agents, or just ask for the dylan agent
```

**What to ask it.** It is a routing and bookkeeping agent, not a coding agent.
Good: *"what is the state of the demo right now"*, *"who owns this defect"*,
*"is the box healthy"*, *"what is not merged and why"*, *"write this session's
worklog entry"*. It will run the health check and read the repo before
answering, rather than telling you what was true last week.

**What not to ask it.** Do not ask it to merge anything. Merges are
human-gated on this project on purpose — see section 6.

---

## 4. Deploying on the box

### What you need first

1. **AWS credentials** for the account that owns the box. Ask Bharat. They are
   not in this repo and must never be.
2. **An SSH key you have generated** — any keypair. You do not need a key that
   is already registered on the instance, because access goes through EC2
   Instance Connect, which pushes your public key for 60 seconds.
3. **Python 3** locally. No packages needed anywhere in this workflow.

### The box

| Thing | Value |
|---|---|
| Public IP | `34.203.238.63` |
| Instance | `i-04f73eb92d7b28bbc`, `us-east-1d` |
| SSH user | `ubuntu` |
| Docker | needs `sudo` |
| Database | one RDS Postgres, **shared with another deployment** — see section 7 |

**The 60-second trap.** An Instance Connect key expires after about a minute.
Push the key and run your command **in the same shell invocation**. A key you
pushed in a previous step is always dead by the next one, and the error you get
is the unhelpful `Permission denied (publickey)`.

### What runs where

| Service | Port | Container | Image | Checkout | Restart with |
|---|---|---|---|---|---|
| harness | 3100 | `harness` | `intake-harness:latest` | `/home/ubuntu/h` | `/home/ubuntu/up-harness.sh` |
| Agent Manager | 8080 | `agent-manager` | `agent-manager:latest` | `/home/ubuntu/am` | `/home/ubuntu/up-manager.sh` |

Claude Desktop connects to **`http://34.203.238.63:8080/mcp`**.

Both checkouts fetch from **`chaunceyplum/intake_harness`**. Agent Manager is
*mirrored inside* that repo at `services/agent-manager/app`, because the
standalone `bharatdudeja-dotcom/agent-manager` repo is private and the box has
no credentials for it. **A branch that exists only on a personal fork cannot be
deployed.** Push to `chaunceyplum/intake_harness` or the box cannot see it.

### The process

Deploying is four steps, and three of them have a trap.

```bash
# 1. fetch the branch you want, on the box
git -C /home/ubuntu/h fetch origin fix/brief-fidelity
git -C /home/ubuntu/h checkout FETCH_HEAD

# 2. build - MIND THE TAG
sudo docker build -t intake-harness:latest /home/ubuntu/h

# 3. restart WITH its configuration
bash /home/ubuntu/up-harness.sh

# 4. prove it, from the outside
curl -s http://34.203.238.63:3100/api/tasks
```

**Trap 1 — the image tag.** `up-harness.sh` runs `intake-harness:latest`. A
build tagged `harness:latest` deploys **nothing** and reports success. There
has also been a stray container found running on that other tag alongside the
real one. If a deploy appears to change nothing, check the tag first.

**Trap 2 — always use the `up-*.sh` scripts.** A bare `docker run` gives the
harness no `DATABASE_URL` and no `PORT`, so it serves on 3000 while published
on 3100, and no `--network cx`, so Agent Manager cannot resolve the hostname
`harness` at all. Both failures leave a container that **passes its health
check**, because the check runs inside the container.

**Trap 3 — `docker rename` does not stop a container.** Renaming the old one
and immediately starting the new one fails with "port is already allocated" and
leaves you a Created container with no port bindings. Stop the old one first.
`up-*.sh` already does this correctly.

**Agent Manager is the same shape**, with one difference — it builds from a
subdirectory:

```bash
git -C /home/ubuntu/am fetch origin fix/log-shows-the-link
git -C /home/ubuntu/am checkout FETCH_HEAD
sudo docker build -t agent-manager:latest /home/ubuntu/am/services/agent-manager/app
bash /home/ubuntu/up-manager.sh
```

### After any harness deploy, run the acceptance test

```bash
bash /home/ubuntu/h/scripts/verify-intake.sh
```

Nine briefs, preview only, nothing is created. It should say `9 passed, 0
failed`. It covers **reading** a brief, not writing to the Workfront form —
writing needs the Workfront MCP signed in, and the script says so itself rather
than quietly passing.

---

## 5. Demo-readiness health check

This is the thing to run before a demo, or the moment anything looks wrong. It
answers "is this going to work right now" in about ten seconds, without
anyone SSH-ing anywhere.

```bash
# from the agent-manager tree
AM_USER=admin AM_PASS=<ask Bharat> python tools/system-check/check.py
```

It writes an HTML report and opens it. `--no-open` for terminal only, `--json`
for something you can pipe.

Eight checks, in the order things actually fail in: the box, then the two
services, then what they depend on, then whether the code running is the code
you think. Two of them matter more than the rest:

- **The gateway check.** It asks Agent Manager for a tool count per MCP server.
  A count only comes back if the server was reached *and* its tools listed,
  which for Adobe means the OAuth token was accepted. **An expired Adobe token
  is the single most common way this demo dies quietly**, and here it shows up
  as a server with zero tools rather than as a baffling failure twenty minutes
  later in front of the client.
- **`/mcp` answering 200 without a credential is an alarm, not a pass.** That
  endpoint is supposed to refuse an anonymous caller.

Without `AM_USER`/`AM_PASS` the shallow checks still run and the deep ones
report **SKIP** with that instruction. `SKIP` never renders as `PASS` — that
was deliberate, because a health check that goes green by not checking is worse
than no health check.

---

## 6. The GitHub story

Everything lives in **`chaunceyplum/intake_harness`**. `main` is another team's
branch and moves independently of us.

| Branch | Carries | State |
|---|---|---|
| `fix/brief-fidelity` | the harness — all the brief-reading and audience work | ahead of `main`, deployed on `:3100` |
| `fix/log-shows-the-link` | Agent Manager — the MCP gateway, the dashboard, the run record | ahead of `main`, deployed on `:8080` |
| `dylan` | this document and the Dylan agent | docs only, branched from `main`, merges cleanly |
| `main` | the other team's work, including a large open PR | **do not merge into ours before the demo** |

**Why nothing is merged to `main`.** `main` currently contains a very large
open change from the other team — tens of thousands of lines, including a
rewrite of the LLM call sites and a UI teardown that cut the sidebar from eight
items to four. It has had no review. Merging it before the demo would replace
the surface the demo is built on, days before the demo.

Four commits from it were checked individually and found conflict-free, and
cherry-picking those is the safe path if any of it is actually needed. Merging
the whole thing is not.

**Merges are human-gated on this project.** Not because review is slow, but
because two regressions were shipped here that every test passed — the tests
asserted the old behaviour. Both were caught by a marketer persona reading the
output, not by CI. So a green suite is necessary and it is not sufficient, and
somebody looks before anything lands.

---

## 7. What is still broken, honestly

Do not discover these in front of a client.

1. **The audience build has never been proven end to end.** The last real run
   built the **inverse** of what the brief asked for — it targeted customers
   *without* internet and dropped the "exclude TV subscribers" condition
   entirely — and reported `completed`. A fix for the direction detection is
   deployed but has **not yet run against a real segment build**. This is the
   single biggest open risk.
2. **A stage can report `completed` while the tool it called failed.** This is
   the known structural failure and it is why escalation has never fired. When
   you read a run, say "reported completed, actually faulted" — do not repeat
   the status field.
3. **Four of eight Workfront field writes are refused** with "not on a custom
   form attached to this OPTASK". The tenant has the field; the form attached
   to that object does not. That is a Workfront configuration gap, not a code
   bug.
4. **The harness gets killed by a half-finished deploy.** It has gone down
   three times, always as `Exited (137)`, and it is worth knowing exactly what
   that is because the obvious reading is wrong.

   `Exited (137)` usually means the kernel's OOM killer. Here it is not:

   ```
   OOMKilled=false   ExitCode=137   2.8 GB available
   kernel OOM log:   nothing
   harness log:      clean startup, then silence - no error, no crash trace
   ```

   137 with `OOMKilled=false` and no kernel OOM entry is **SIGKILL from
   outside the container**, and the only thing here that sends it is
   `docker rm -f harness` — the first line of `up-harness.sh`. Each time, what
   came up afterwards was a container on the *other* image tag with no port
   mapping and no env file. That is Trap 1 and Trap 2 above, happening for
   real: a deploy kills the named container, starts a replacement the wrong
   way, and leaves nothing serving `:3100` while passing its own health check.

   So when `:3100` refuses connections while `:8080` serves a stale-looking
   screen, this is nearly always it. `sudo docker ps -a` first, then
   `bash /home/ubuntu/up-harness.sh`, then check
   `sudo docker ps --filter ancestor=harness:latest` for a stray on the wrong
   tag. Do not go looking for a memory leak; there isn't one.

   **The underlying fault is in `up-harness.sh`**, which kills the running
   container before it knows the new one will start, and which lives only on
   the box rather than in this repo. Making it verify the image and the port
   first, and put the old container back if the run fails, would remove the
   trap rather than documenting it. Not yet done.
5. **The database is shared with the other team's deployment**, and
   `db/schema.sql` seeds the `tasks` catalog with `ON CONFLICT DO UPDATE`. So
   when they apply their schema, our agent names revert to their build-plan
   names — "Agent 1 — Intake" owned by "Dev 1". Anything a customer reads is
   now overlaid from code that ships in our image, so this is contained, but
   **do not "fix" a shared table by hand**: it will not hold.

### Security, flagged and deliberately not changed

These are known and were left alone rather than changed unattended. They must
be dealt with before any of this is reachable by anyone outside the demo:

- RDS is publicly accessible; the EC2 security group allows all traffic from
  `0.0.0.0/0`
- the harness on `:3100` has **no authentication** and is reachable from
  anywhere
- the dashboard admin password is documented in the setup guide and must change
  before a public URL exists
- one AWS access key needs deleting in IAM by a human

---

## 8. Things not to do

- **Do not approve a Workfront request on a marketer's behalf**, or offer to.
  A named person clicks Approve in Workfront. `approve_intake` only *records*
  that it happened, and it refuses unless Workfront itself confirms it.
- **Do not delete runs to tidy up.** Retries are the measurement: agent health
  is judged by how many rounds a brief takes, so deleted failed attempts report
  a success that did not happen. `delete_job` refuses agent runs for this
  reason; `force` is for when a human has explicitly asked.
- **Do not put credentials in an agent prompt.** The friction auditor refused a
  plaintext admin credential that had been handed to it, and it was right to.
- **Do not change anything in the company cookbook.** It is a shared store and
  the standing instruction on this project is to reuse it, not edit it.
- **Do not start a new agent for a job that already has an owner.** See
  section 2.

---

## Where to look next

| You want | Go to |
|---|---|
| Is it working right now | section 5, then run the check |
| Ship a change to the box | section 4 |
| Who should do this | section 2, then ask the `dylan` agent |
| What happened last session | [`WORKLOG.md`](WORKLOG.md) |
| The last state that was known to work, with SHAs | [`STATE-2026-09-21.md`](STATE-2026-09-21.md) |
| Connect Claude Desktop | the setup guide in the Agent Manager tree |
