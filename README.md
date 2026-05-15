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
[`.github/workflows/example.yml`](.github/workflows/example.yml).

---

## Inputs

| Name           | Default                          | Description |
|----------------|----------------------------------|-------------|
| `test-command` | `npx playwright test`            | Command used to run Playwright. The action captures stdout/stderr and the exit code. |
| `mode`         | `failure-analysis`               | `off`, `failure-analysis`, or `review`. |
| `provider`     | `openrouter`                     | Selects a default `base-url` if you don't pass one. |
| `fast-model`   | `qwen/qwen3-coder`               | Cheap/fast model id, used for the first pass. |
| `smart-model`  | `moonshotai/kimi-k2.6`           | Smart model id, used only on escalation. |
| `api-key`      | _(empty)_                        | LLM provider API key. Required unless `mode: off`. |
| `base-url`     | _(provider default)_             | OpenAI-compatible base URL (e.g. `https://openrouter.ai/api/v1`). |
| `app-url`      | _(empty)_                        | Optional URL of the app under test, passed to the model for context. |

## Outputs

| Name           | Description |
|----------------|-------------|
| `summary-path` | Path to the rendered markdown summary (`playwright-ai-router-summary.md`). |
| `ai-called`    | `'true'` if an LLM was called, `'false'` otherwise. |
| `model-used`   | Final model id used (fast or smart) or empty. |
| `conclusion`   | `success`, `failure`, or `ai-flagged` (passed run that the AI flagged as failing/ambiguous). |

The action **always fails the job when Playwright failed** — but only after the
AI summary has been generated and uploaded to `$GITHUB_STEP_SUMMARY`.

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
