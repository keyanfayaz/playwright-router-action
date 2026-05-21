# Playwright AI Router

A reusable **composite GitHub Action** that runs your Playwright suite, gathers
compact evidence (failures, console tail, screenshot/trace counts), and routes
optional AI failure-analysis or PR review tasks between a **fast** model and a
**smart** model — keeping cost low while still escalating when the cheap model
isn't confident.

It works against any **OpenAI-compatible** chat endpoint
(OpenRouter, Together, Groq, DeepSeek, OpenAI itself, …).

---

## Usage

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: '20', cache: npm }
- run: npm ci
- run: npx playwright install --with-deps

- uses: your-org/playwright-router-action@v1
  with:
    test-command: npx playwright test --reporter=list
    mode: failure-analysis           # off | failure-analysis | review
    provider: openrouter
    fast-model: qwen/qwen3-coder
    smart-model: moonshotai/kimi-k2.6
    api-key: ${{ secrets.OPENROUTER_API_KEY }}
    app-url: ${{ vars.APP_URL }}     # optional, passed to the model as context
```

A full example (label-driven review, nightly cron, PR comment) lives in
[`examples/example.yml`](examples/example.yml). A complete
`mode: test-plan` workflow (permissions, `paths-ignore`, bot-actor guard,
concurrency) lives in [`examples/test-plan.yml`](examples/test-plan.yml).

---

## Inputs

| Name           | Default                          | Description |
|----------------|----------------------------------|-------------|
| `test-command` | `npx playwright test`            | Command used to run Playwright. The action captures stdout/stderr and the exit code. |
| `mode`         | `failure-analysis`               | `off`, `failure-analysis`, `review`, or `test-plan`. |
| `provider`     | `openrouter`                     | Selects a default `base-url` if you don't pass one. |
| `fast-model`   | `qwen/qwen3-coder`               | Cheap/fast model id, used for the first pass. |
| `smart-model`  | `moonshotai/kimi-k2.6`           | Smart model id, used only on escalation. |
| `api-key`      | _(empty)_                        | LLM provider API key. Required unless `mode: off`. |
| `base-url`     | _(provider default)_             | OpenAI-compatible base URL (e.g. `https://openrouter.ai/api/v1`). |
| `app-url`      | _(empty)_                        | Optional URL of the app under test, passed to the model for context. |

### `mode: test-plan` inputs

| Name                   | Default                                  | Description |
|------------------------|------------------------------------------|-------------|
| `github-token`         | _(empty)_                                | **Required for `test-plan`.** Used to read/edit the PR, comment, and push generated specs. Needs `contents: write` + `pull-requests: write`. |
| `spec-output-dir`      | `e2e/specs/generated`                    | Where generated specs are written and committed. |
| `test-command-single`  | `npx playwright test`                    | Command to run a single generated spec; the spec path is appended. |
| `max-iterations`       | `20`                                     | Max generate→run→fix iterations per item. |
| `wall-clock-seconds`   | `480`                                    | Max wall-clock seconds per item. |
| `screenshot-dir`       | `.playwright-ai-router/screenshots`      | Where the model writes screenshots; committed alongside passing specs. |
| `screenshots-per-item` | `8`                                      | Max screenshots committed per automated item. |
| `skip-patterns`        | `ask ,PM ,design review,manually verify with` | Comma-separated, case-insensitive substrings; matching items are reported skipped (not attempted) unless they carry a `Manual:` hint. Trailing spaces are significant. |
| `bot-name`             | `playwright-ai-router[bot]`              | git author/committer name for bot commits. |
| `bot-email`            | `playwright-ai-router[bot]@users.noreply.github.com` | git author/committer email for bot commits. |

## Outputs

| Name              | Description |
|-------------------|-------------|
| `summary-path`    | Path to the rendered markdown summary (`playwright-ai-router-summary.md`). |
| `ai-called`       | `'true'` if an LLM was called, `'false'` otherwise. |
| `model-used`      | Final model id used (fast or smart) or empty. |
| `conclusion`      | `success`, `failure`, or `ai-flagged` (passed run that the AI flagged as failing/ambiguous). |
| `items-total`     | _(test-plan)_ Total Test plan items found. |
| `items-automated` | _(test-plan)_ Items turned into committed, passing specs. |
| `items-failed`    | _(test-plan)_ Items that never produced a green spec. |
| `items-skipped`   | _(test-plan)_ Items reported as skipped. |
| `commit-sha`      | _(test-plan)_ Bot commit SHA pushed to the PR head, or empty. |
| `report-path`     | Path to the generated self-contained HTML report. |

The action **always fails the job when Playwright failed** — but only after the
AI summary has been generated and uploaded to `$GITHUB_STEP_SUMMARY`.

### Visual HTML report

On every run (any `mode` other than `off`), the action renders a self-contained
`playwright-ai-router-report.html` and uploads it as the
**`playwright-ai-router-report`** workflow artifact. It includes the verdict,
stat cards, the AI summary/failures (or per-item Automated / Failed / Skipped
groups for `mode=test-plan`) with an inlined screenshot gallery — no external
dependencies, viewable offline. The markdown summary and PR comment both point
at it.

---

## Required secrets / variables

| Kind     | Name                  | Purpose |
|----------|-----------------------|---------|
| secret   | `OPENROUTER_API_KEY`  | Or whichever provider you configured. Wired into `with.api-key`. |
| variable | `APP_URL` _(opt.)_    | The deployed/preview URL of the app under test, surfaced to the model. |

The API key is masked via `::add-mask::` before any other step runs and is
never echoed back to logs.

---

## Modes

| Mode               | Tests pass                         | Tests fail                                              |
|--------------------|-------------------------------------|---------------------------------------------------------|
| `off`              | no AI call                          | no AI call                                              |
| `failure-analysis` | no AI call                          | fast model triage; escalates to smart on low signal     |
| `review`           | fast model writes a short PR review | fast model triage; escalates to smart on low signal     |
| `test-plan`        | turns the PR's `## Test plan` into committed, passing specs (see below) | same                       |

---

## Mode: test-plan

Turns a pull request's prose **`## Test plan`** into committed, passing
Playwright specs.

**Selection.** Every **unchecked** `- [ ]` item under the `## Test plan`
heading is attempted — selection is **not** gated on any marker (relying on
authors or coding agents to tag items is unreliable and silently loses
coverage). Filtering is handled two ways instead:

- `skip-patterns` (substring match) reports clearly human-only items as
  *skipped* without attempting them, and
- the model itself can declare an item `non_automatable`.

An optional leading **`Manual:`** (case-insensitive) is just a strong
"definitely automate" hint that **bypasses `skip-patterns`** — its absence
costs nothing.

**Loop.** For each attemptable item the action runs a bounded
generate→run→fix loop: the model returns, via a strict JSON protocol, the spec
file(s) to write and the command(s) to run; trusted code applies sandboxed
writes, runs only allowlisted commands, reuses the existing
`run-tests.sh` + `collect-evidence.js` to evaluate the spec, and feeds compact
failure evidence back. It stops on green, or at `max-iterations` /
`wall-clock-seconds` per item.

**Write-back.** Specs that end green (plus their screenshots, capped at
`screenshots-per-item`) are committed to the PR head branch by a dedicated bot
identity with `[skip ci]`. Each newly-covered checkbox is ticked
(`- [ ]` → `- [x]`) after re-fetching the live PR body so concurrent edits are
never clobbered. One idempotent comment summarises automated / failed /
skipped, with screenshots inlined via
`https://github.com/<owner>/<repo>/raw/<head-branch>/<path>`.

When nothing is automated (or there is no `## Test plan` section) the action
posts the comment, emits a GitHub `::warning::` annotation that the PR shipped
without generated coverage, and **exits 0** — it never blocks the check.

### Security model

- **Command allowlist.** Model-proposed shell strings are regex-checked: only
  the configured `test-command-single` (+ at most one in-`spec-output-dir`
  `.spec` path), `git status`, `ls`, and `cat` ever run. `rm`, `curl`, `npm i`,
  `git commit`/`push`, `bash -c`, and any chained/piped/redirected command are
  rejected and surfaced back to the model.
- **Sandboxed writes.** Model writes are confined to `spec-output-dir` /
  `screenshot-dir`, with no absolute paths or `..`, and size/count caps.
- **The model never runs git.** Commits and the single push are done by trusted
  action code only, after a spec passes.
- **Fork PRs are skipped** (no secret/token access): the action exits 0 with an
  explanatory comment.

### Required permissions & consumer guards

```yaml
permissions:
  contents: write          # push generated specs to the PR branch
  pull-requests: write     # edit the PR body + comment

concurrency:               # recommended: avoid racing pushes on the same PR
  group: test-plan-${{ github.event.pull_request.number }}
  cancel-in-progress: false
```

Because the bot pushes back to the PR branch, consumers **must** add both of
the following or the workflow will retrigger itself:

1. A `paths-ignore` on the PR-triggered workflow for the generated dirs:

   ```yaml
   on:
     pull_request:
       paths-ignore:
         - 'e2e/specs/generated/**'
         - '.playwright-ai-router/screenshots/**'
   ```

2. A job-level guard skipping the bot actor:

   ```yaml
   jobs:
     test-plan:
       if: github.actor != 'playwright-ai-router[bot]'
   ```

The bot commits include `[skip ci]` as a second line of defence.

## Model routing

1. **Evidence is compacted** before any model sees it: ANSI stripped, log tailed
   to ~8 KB, only artifact counts + a handful of sample paths sent (no raw
   traces, videos, or full reports).
2. **Fast model first.** Every AI call starts on `fast-model`.
3. **Escalate to `smart-model`** when:
   - the fast response isn't valid JSON,
   - `confidence < 0.7`,
   - `needs_visual_review === true`,
   - `verdict === "ambiguous"`, or
   - the run failed, visual artifacts exist, **and** the fast model returned no
     concrete failure analysis.
4. **JSON-only contract.** Models are asked to return a fixed JSON schema
   (`summary`, `verdict`, `confidence`, `needs_visual_review`, `failures[]`).
   Invalid JSON triggers escalation; a still-invalid smart response is
   surfaced in the summary rather than silently dropped.

This keeps the cheap model on the happy path and reserves the expensive model
for runs where the extra spend is justified.

---

## Recommended usage patterns

- **PRs — failure-analysis (default).** Tokens are only spent when Playwright
  goes red. Combine with a sticky PR comment (see the example workflow) so
  reviewers see the AI's triage inline.
- **PRs — opt-in review via label.** Add a `ai-review` label to a PR and the
  example workflow switches to `mode: review`, getting a short AI review even
  for passing runs. Cheaper than running review on every PR.
- **Nightly cron — review.** A scheduled run of the full suite plus an AI
  review is a low-noise way to catch flake patterns or slow regressions.
- **Release branches — failure-analysis with explicit smart model.** Point
  `smart-model` at your strongest available model so escalations on red builds
  get the best possible diagnosis.

---

## What gets sent to the model

A single JSON-like message that includes:

- `exit_code`, `passed`, `failed_count_reported`
- Parsed list of failed test names (≤ 25)
- Artifact counts + up to 10 screenshot paths, 5 video paths, 5 trace paths
- The last ~8 KB of the Playwright log (ANSI-stripped)

What does **not** get sent: raw trace files, full HTML reports, video bytes,
source code, environment variables, or your repo contents. If you need richer
visual analysis you'd hook that in separately — this action is deliberately
conservative on tokens.

---

## Files this action creates

- `playwright-ai-router-summary.md` — the human-readable summary; also appended
  to `$GITHUB_STEP_SUMMARY`.
- `.playwright-ai-router/` — scratch dir with `evidence.json`, `ai-response.json`,
  `test-output.log`, `exit-code`. Safe to upload as an artifact for debugging.

## Local development

The scripts under `scripts/` are plain Node 20 / bash and can be invoked
directly:

```bash
TEST_COMMAND='npx playwright test' bash scripts/run-tests.sh
MODE=failure-analysis node scripts/collect-evidence.js
MODE=failure-analysis PROVIDER=openrouter \
  FAST_MODEL=qwen/qwen3-coder SMART_MODEL=moonshotai/kimi-k2.6 \
  API_KEY=$OPENROUTER_API_KEY \
  node scripts/route-ai.js
node scripts/build-summary.js
```

For `mode: test-plan`, every script honours `DRY_RUN=1` (no commit / push /
PR-body edit / comment — would-be body and comment are dumped to
`.playwright-ai-router/`):

```bash
GITHUB_EVENT_PATH=event.json node scripts/read-pr-meta.js
SKIP_PATTERNS='ask ,PM ' PR_META_PATH=.playwright-ai-router/pr-meta.json \
  node scripts/parse-test-plan.js
DRY_RUN=1 PR_META_PATH=.playwright-ai-router/pr-meta.json \
  API_KEY=$OPENROUTER_API_KEY FAST_MODEL=qwen/qwen3-coder SMART_MODEL=moonshotai/kimi-k2.6 \
  node scripts/generate-spec.js
DRY_RUN=1 PR_META_PATH=.playwright-ai-router/pr-meta.json node scripts/pr-writeback.js
```

Unit tests (no dependencies, Node's built-in runner):

```bash
node --test test/*.test.js
```
