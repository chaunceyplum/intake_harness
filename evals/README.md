# Evals

Separate from `src/**/*.test.ts` (`npm test`) on purpose. Unit tests use a
stubbed `LlmClient` to test this app's own code paths deterministically -
validation, fallback, provenance-threading - and stay fast, free, and in CI.
These call the **real, configured** LLM provider against **hand-reviewed
fixtures**, to measure something unit tests structurally can't: whether the
model's output is actually *good*, not just correctly *handled*.

They are a manual step, not a CI gate, until the suite is stable enough to
trust on every PR.

## Running

Requires `LLM_PROVIDER` set in `.env.local` (bedrock/anthropic/ollama) - an
eval file with no provider configured skips itself with a clear message
rather than failing.

```bash
npm run eval:intake     # extractIntake / extractFromAnswer
npm run eval:review     # detectRejectionLlm / triageRejectionLlm
npm run eval:audience   # synthesizePql
npm run eval:all        # all three
```

Each run prints a per-fixture pass/fail table with why, plus an overall
score, in addition to vitest's own summary.

## Adding a fixture

Drop a new `*.json` file in the right `fixtures/<dir>` - see any existing
fixture for the shape, and each `.eval.ts` file's own top for exactly which
fields it reads. A fixture needs an `id` (or the filename is used), the
input the real function takes, and an `expected`/`rubric` describing what a
correct answer looks like. No code change needed to pick it up.

**Where fixtures come from**: prefer real run history first -
`task_runs.input`/`output`/`metadata` in Postgres already has real briefs,
rejections, and PQL syntheses from real usage. Pull a candidate, read what
the app actually produced, correct it by hand if it's wrong (a fixture
records what SHOULD happen, not what happened), and check it in. A few
current fixtures (see their `note` field) exist specifically because a real
run got something wrong - `line_of_business` extracted as "Business (SMB)"
for an entirely residential/Xfinity brief, a stated field mislabeled as
"stated" - and are there to catch that exact regression. `review-rejection`/
`review-triage` fixtures are synthetic today (no real run has hit an actual
Workfront rejection yet) - swap in real ones as they happen.

## Grading philosophy

- **Structural first, judge only where structural genuinely can't tell.**
  Field-value matches, provenance (`stated` vs `derived`/`inferred`),
  `mustContain`/`mustNotContain` substring checks, and PQL's own
  fields-used-are-verified-present gate are all plain comparisons - no LLM
  judge is more reliable than an exact match when an exact match is possible.
- **The judge (`lib/judge.ts`) is reserved for genuine quality questions**:
  is this PQL expression's logic actually right, is this correction's
  explanation clear and correctly targeted. It costs a real LLM call per
  judged fixture - don't reach for it when a string comparison would do.
- **A hard structural gate can override a would-be judge call.** The PQL
  eval never asks the judge to grade an expression that referenced an
  unverified field or that the model should have declined to write - that's
  the app's own safety gate working (or failing), not a style question.
