# Playwright AI Router

A composite GitHub Action that runs Playwright, collects failure evidence, and
routes optional AI analysis between two models on an OpenAI-compatible endpoint.
The resulting summary and HTML report help reviewers inspect what happened.

- **Failure analysis:** analyze failed tests, with escalation when the first model
  returns uncertain or invalid output.
- **Review:** request a summary even when the tests pass.
- **Test plan:** temporarily disabled. Model-authored code must not execute on
  the same runner as provider credentials or repository write credentials.
  Selecting this mode fails clearly rather than running or pushing generated code.

Test failures still fail the job after the report is produced. `mode: off` runs
the tests without calling an AI provider.

## Use it

In a workflow that has already checked out the project, installed dependencies,
and installed Playwright browsers:

```yaml
- uses: keyanfayaz/playwright-router-action@8162b485615eef11a0f19a888288adc128a51515
  with:
    test-command: npx playwright test --reporter=list
    mode: failure-analysis
    provider: openrouter
    api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

This example pins an existing commit. No `v1` tag or branch is published.
Choose and review the provider, endpoint, and model inputs for your project.
AI modes send test evidence to that provider; keep secrets and private data out
of collected test output.

See the [full reference](GUIDE.md) for inputs, outputs, reports, escalation,
permissions, and tests. The [consumer workflow](examples/example.yml) shows a
complete analysis setup. [MIT license](LICENSE).

## Verification and limits

Run `npm ci --ignore-scripts`, `npm test`, `npx playwright install chromium`,
and `npm run test:browser`. CI runs the same checks with no provider secrets.
The browser test runs an actual Chromium assertion failure, collects evidence,
rejects a malformed mock model response, escalates to a second mock response,
builds the report, then verifies a corrected assertion passes. It is not a live
model benchmark or evidence that AI can reliably repair arbitrary tests.

Model calls have a 30-second deadline and validated response fields. Screenshots
and traces are listed as evidence, but image pixels are not sent to the model.
The router analyzes text; a stronger model does not add visual access.

Before autonomous generation returns, it needs a separate disposable execution
boundary without provider/write credentials or credential-bearing checkout state,
plus reviewed artifact transfer and trusted writeback. Filtering environment
variables or allowing only certain shell commands is not a sandbox.
