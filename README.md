# Playwright AI Router

A composite GitHub Action that runs Playwright, collects failure evidence, and
routes optional AI analysis between two models on an OpenAI-compatible endpoint.
The resulting summary and HTML report help reviewers inspect what happened.

- **Failure analysis:** analyze failed tests, with escalation when the first model
  returns uncertain or invalid output.
- **Review:** request a summary even when the tests pass.
- **Test plan:** turn unchecked PR test-plan items into specs and push passing
  results back to the PR; this mode needs explicit repository write permissions.

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
permissions, and tests. The [consumer workflow](examples/example.yml) and
[test-plan workflow](examples/test-plan.yml) show complete setups, including
guards for generated commits. [MIT license](LICENSE).
