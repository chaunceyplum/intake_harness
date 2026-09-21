# WORKLOG — Comcast Xfinity creative intake (harness + Agent Manager)

Maintained by Dylan: worklog, priority, routing. Rewritten in full each run.
Run 5: **20 Sep 2026**. **Organising goal: the intake brief is ready to test when the user
returns.** Merges are human-gated (W-32), so this window produces a merge-ready queue.

---

## Changed since last run (run 4 → run 5, 20 Sep 2026)

| # | Change | Evidence — verified |
|---|---|---|
| **G1** | **PR #31 is now 16 commits, 6 files, +647/−40, `clean`, 0 reviews.** All eleven claimed fixes present as commits | GitHub API; commit list below |
| **G2** | **W-33 closed — `mt.txt` stripped and gitignored** | `mt.txt` absent from PR #31's file list; `.gitignore +3-0` |
| **G3** | **M-03 closed — the script prints its own scope**, repeated in `HANDOVER.md` | `verify-intake.sh` 116→**159** lines |
| **G4** | **W-34a closed — internal vocabulary gone from the four question strings** (profile store, build path, segmentation job, rework cycles), with the *reason* kept in plain words | `campaign-brief.ts +4-4`, commit `aa5dfe8` *"The questions were written for us, not for the marketer"* |
| **G5** | **Acceptance test now 9 cases, 9 passed 0 failed** | coordinator; `verify-intake.sh` grew 43 lines |
| **G6** | **Six further defects shipped from Dana's second run** — changed offer vanishing beside a caught date (`b382366`), offer truncated at the first number, agency named in all six briefs and read in none (`f8cb372`, `aca4248`, `5aee31c`), an invented `push` channel, and the preview now distinguishing *"nothing will be written"* from *"I could not read the form"* (`057ce4c`) | commit list |
| **G7** | **A regression was introduced and fixed twice** — collecting every date made *"legal sign-off by 1 October, in market 20 November"* read as a launch conflict, then filed "October" and lost the real deadline. First fix used a fixed lookback that read across the comma | `949abb3`, then `e33febb` *"The qualifier has to belong to the date's own clause"* |
| **G8** | **W-34b IS STILL OPEN — verified, not assumed.** The vocabulary half shipped; the *asks-what-it-already-knows* half did not. `parse.ts:119` is **unchanged**: `\badd (a )?(mobile\|line)\b` still cannot match *"add an Xfinity Mobile line"* (`an` ≠ `a`), and the `don't have` window is still `[^.]{0,30}` against a clause the friction audit measured at 31 | fetched `parse.ts` from `fix/brief-fidelity` |
| **G9** | **PR #29 MOVED** — now **28 commits, +7859/−2810** (was 27, +7805/−2801), pushed 14:15:59Z. Still `dirty`, still 0 reviews. **Gitkeeper is reviewing a target that moved under it** | GitHub API |
| **G10** | **M-04 recorded** (below). **M-02 vindicated twice** — both regressions were caught by a marketer, not a test, because the existing tests asserted the old behaviour | coordinator |
| **G11** | **Still open and honestly unfinished:** a named regional market (Boise / Treasure Valley) is dropped for "National" when a brief mixes the two, with no conflict raised. Logged as **W-35** | coordinator |

---

## Methodological notes

**M-01 — Run-history aggregates span code versions.** State the version a figure spans or it is not evidence about today.

**M-02 — A test that pins user-facing copy will eventually be satisfied by leaving the wrong words in.** **Now vindicated twice over:** both of this run's regressions were found by a marketer, not by a test, because the tests that existed asserted the old behaviour. Assert that the gate fired, not what it said. **Still unapplied to W-13, W-16, W-17, W-18** — all copy fixes with tests yet to write.

**M-03 — State the scope of a green result.** Closed: the script prints its own scope (G3). "9 passed, 0 failed" still means *reading* the brief; writing to the form remains untested until W-00 clears.

**M-04 — Silence reads as success when skimming.** A script that wrote Python from Python broke on escaping, and the deploy afterwards **printed nothing rather than failing**. The embedded Python is now syntax-checked before commit. The general form: *any step whose failure mode is empty output is a step that will be believed.* Worth auditing the deploy path for other silent exits.

---

## The roster

**Resume with a message, never respawn.**

| Role | Owns | Must never be asked to | Last ran |
|---|---|---|---|
| **Chauncey Gitkeeper** | The shared repo; collisions; merge recommendations; re-test lists | **Push, commit, merge, rebase or force anything** | 20 Sep. **Holds #29 — which has since moved (G9); its report is now one commit stale** |
| **Josh** | Demo narrative, beat by beat | Fix code or decide product direction | 19 Sep. Held on W-00. **Carries a stale G3 (M-01)** |
| **Flow-friction auditor** | The marketer-facing surface | Judge the demo script or review git state | 19 Sep. Held on W-00 |
| **Dana Whitfield** | Living the journey, reporting honestly | Read source or propose fixes | **20 Sep, second run — produced six of this run's fixes.** The highest-yield role on the roster |
| **Dylan (me)** | Worklog, priority, routing, drift | Write product code | 20 Sep, run 5 |

**Accepted constraint — one fixer, by design.** Holding well.

**Burn-down: second consecutive positive run.**

| Measure | Run 3 | Run 4 | Run 5 |
|---|---|---|---|
| Open items requiring code | 16 | 12 | **9** |
| Net movement | −3 | +4 | **+3** |

Dana's second run added items *and* cleared more than it added. **Note for the record: the two
highest-yield activities this programme has are (a) the marketer persona and (b) the acceptance
script — not the audits.** Both are cheap and neither needs Workfront.

---

## Live state, verified 20 Sep 2026 (run 5)

`main` = **53c23ca**. **Three PRs open, zero reviews on all three, two clean and mergeable.**

| PR | Title | Mergeable | Size | Reviews |
|---|---|---|---|---|
| #31 | Read the brief properly: amendments, contradictions, offer, agency | `true` / **clean** | **16c, 6f, +647/−40** | 0 |
| #30 | Withhold destructive tools; graph names; system-check; viewer preview | `true` / **clean** | 3c, 13f, +967/−35 | 0 |
| #29 | Post agent update comments to Workfront — *chaunceyplum* | `false` / **dirty** | **28c, 98f, +7859/−2810** | 0 |

---

## The queue, re-ranked

### Tier A — harm and the merge gate

| id | title | state | owner | note |
|---|---|---|---|---|
| **W-32** | **Merges require the user** — permission classifier refused the God agent | **blocked on permission** | user | The window produces merge-ready PRs, not merges |
| **W-01** | 41 destructive tools withheld; graph names; system-check; viewer preview fix | **in-flight** | coordinator | PR **#30**, clean, 0 reviews, **fifth run at the top of this log** |
| **W-02** | Harness host has no authentication on any route | **deferred, assigned** | user | Correctly deferred while unattended |

### Tier B — the goal: the intake brief is testable on return

| id | title | state | owner | note |
|---|---|---|---|---|
| **W-03 / W-34a / W-35-family** | Amendments, contradictions, budget-vs-offer, changed offer, truncated offer, agency, invented channel, date qualifiers, form-unreadable message | **in-flight** | coordinator | PR **#31**, 16 commits, 9-case acceptance test green |
| **W-34b** | **The brief is asked what it already answered** | **OPEN — verified still open (G8)** | coordinator | `parse.ts:119`. `\badd (a )?(mobile\|line)\b` misses *"add an Xfinity Mobile line"*; `[^.]{0,30}` misses a 31-char clause. **Dana hit this on 5 of 6 briefs.** Two-character fix. **Now costlier than it was: with questions capped at two and contradictions outranking gaps, a false question evicts a real one from the budget** |
| **W-35** | **A named regional market is dropped for "National"** when a brief mixes the two, no conflict raised | **OPEN** | coordinator | Boise / Treasure Valley. Same silent-loss class as the invented channel. **See the ranking note below — this is worth more than its size** |
| **W-12** | `Product Name` dead mapping — every brief resolves to `Residential (RES)` | **open** | coordinator | No `product` key in `campaign-brief.ts`. **Extraction half is testable now**; the write half needs the form |
| **W-16** | Broken English in a structured field | **open** | coordinator | `"exclusion": "Customers without anyone who already has Xfinity Internet"`. Parser-side, no Workfront |
| **W-20** | Mojibake: `"agent": "Agent 1 ? Intake"` | **open** | coordinator | Encoding one-liner, on screen in the demo |
| **W-13b** | **Real Workfront requests shown as `experimental` with `expires_at`** | **open** | coordinator | Friction §8. **No Workfront needed — it is a projection in Agent Manager.** Hits *every* row when a marketer asks "what have I filed?" Chef-role half already done |
| **W-18** | `"awaiting_approval"` beside `"waiting_on_a_human": false` | **open** | coordinator | Agent Manager `describeRunState`. No Workfront. Dana: *"I genuinely do not know which is true of my own request"* |
| **W-31** | `AEP_ACCOUNT_ID_FIELD` unset — one side of the demo's central comparison missing | **open, unfinished** | coordinator | `query_get_results` 404s, PSQL listing hung twice. **Not done** |

### Tier C — blocked on Workfront, do not start

**W-00** (credential absent, search exhausted — needs a human at a loopback tunnel; gates everything below) · **W-04** deployment check · **W-05** fresh-run count · **W-09** preview declaring what it cannot carry · **W-11** channel collapse · **W-21** Workfront mastery gaps · the three held audits.

### Tier D — demo, decisions, parked

**W-06** CX graph = 1 job · **W-07** script names fields that do not exist · **W-08** counts beat on the wrong agent · **W-05b** the count is `5` (untouched by the W-05 correction) · **W-10** no approval process attached · **W-15** codenames, **CONTESTED**, do not build · **W-17** no ticket number + self-duplicate warning · **W-19** 411 tools · **W-22** PR #29, **now moved (G9)** · **W-23** per-user MCP auth, **park lapsed 19 Sep, fifth run unre-decided** · **W-24/25** correctly parked · **W-26** container watch, unowned.

---

## Is anything left, without Workfront, worth more than Boise/National?

**Yes — one thing, and it is smaller than Boise: W-34b.** Everything else is worth less.

**1. W-34b beats it.** Verified still open at `parse.ts:119` (G8). It is the same no-Workfront class
and a two-character regex, but it fires on **5 of 6** of Dana's briefs versus one, and it has
become *more* expensive since it was logged: now that questions are capped at two and
contradictions outrank gaps, a question the brief already answered **evicts a real question from
the budget**. It is also the defect Dana named as the moment she would stop typing.

**2. Then W-35 (Boise), and it is worth more than its size — finish the family.** The last three
fixes taught the brief to raise a conflict on dates, offers, channels and contradictions. **The
value of a conflict detector is that its silence means something.** A marketer who has just learned
that this system flags disagreements will read a silent region resolution as agreement. Leaving one
member of the family silent is worse than never having started it, because it converts earned trust
into a trap — and region is one of the few fields that actually reaches Workfront.

**3. Then W-13b and W-18** — both marketer-facing, both pure Agent Manager projection logic, both
needing no Workfront, and W-13b hits every row a marketer ever sees. These are the two no-Workfront
items I think are currently under-ranked.

**Worth less than Boise:** W-12 (half-fixable only), W-16, W-20 — real, cheap, and not what breaks
a ten-minute test.

---

## At risk of being dropped

1. **Three PRs, zero reviews, two mergeable, and the only person who can merge is asleep.** #30 is on its fifth run at the top.
2. **Gitkeeper's #29 report is stale** — the branch gained a commit at 14:15Z (G9). Re-message before acting on its recommendation.
3. **W-23's park lapsed on the 19th. Fifth run unre-decided.**
4. **M-02 is still unapplied to W-13, W-16, W-17, W-18** — all copy fixes, all with tests yet to write. This is the run to apply it, not after.
5. **M-04 suggests an audit of the deploy path** for other steps whose failure mode is empty output.
6. **Josh's stale G3** (M-01) will be re-derived on resume unless he is told.
7. **W-31 reads as done because it is one env var.** It is not — two probes failed.
