#!/usr/bin/env node
/*
 * Routes evidence to an LLM via an OpenAI-compatible chat endpoint.
 *
 * Routing rules:
 *   mode=off                       → no call
 *   mode=failure-analysis, passed  → no call
 *   mode=failure-analysis, failed  → fast model; escalate to smart if uncertain
 *   mode=review, passed            → fast model only
 *   mode=review, failed            → fast model; escalate to smart if uncertain
 *
 * Escalation triggers: invalid JSON, confidence < 0.7, needs_visual_review,
 * verdict === "ambiguous", or (failed && screenshots/traces present && fast
 * model returned no concrete failure analysis).
 */
const fs = require('fs');
const path = require('path');
const { chat, tryParseJson, PROVIDER_DEFAULTS, setOutput } = require('./lib/llm.js');

const OUT_DIR = '.playwright-ai-router';
const EVIDENCE_PATH = path.join(OUT_DIR, 'evidence.json');
const AI_PATH = path.join(OUT_DIR, 'ai-response.json');

function writeResult(obj) {
  fs.writeFileSync(AI_PATH, JSON.stringify(obj, null, 2));
}

function buildPrompt(evidence, taskKind) {
  const sys = [
    'You are a Playwright test triage assistant.',
    'Respond ONLY with a single JSON object, no prose, no code fences.',
    'Schema: {',
    '  "summary": string (concise markdown, <= 1500 chars),',
    '  "verdict": "pass" | "fail" | "ambiguous",',
    '  "confidence": number between 0 and 1,',
    '  "needs_visual_review": boolean,',
    '  "failures": [{ "test": string, "likely_cause": string, "suggested_fix": string }]',
    '}',
    'Set needs_visual_review=true if screenshots/traces matter for diagnosis.',
    'Set confidence<0.7 if evidence is thin or contradictory.',
  ].join('\n');

  const taskLine = taskKind === 'review'
    ? 'Task: produce a short PR review note about the Playwright run.'
    : 'Task: diagnose the test failures and suggest fixes.';

  const user = [
    taskLine,
    evidence.app_url ? `App under test: ${evidence.app_url}` : '',
    `Playwright exit code: ${evidence.exit_code} (passed=${evidence.passed})`,
    `Reported failed count: ${evidence.failed_count_reported}`,
    `Failed tests (parsed): ${JSON.stringify(evidence.failed_tests)}`,
    `Artifact counts: ${JSON.stringify(evidence.artifact_counts)}`,
    `Sample artifacts: ${JSON.stringify(evidence.sample_artifacts)}`,
    '',
    'Log tail:',
    '```',
    evidence.log_tail,
    '```',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

function shouldEscalate(parsed, evidence) {
  if (!parsed) return { yes: true, why: 'invalid-json' };
  if (typeof parsed.confidence === 'number' && parsed.confidence < 0.7) {
    return { yes: true, why: `low-confidence(${parsed.confidence})` };
  }
  if (parsed.needs_visual_review === true) {
    return { yes: true, why: 'visual-review-requested' };
  }
  if (parsed.verdict === 'ambiguous') {
    return { yes: true, why: 'ambiguous-verdict' };
  }
  const hasVisual = evidence.artifact_counts.screenshots > 0 || evidence.artifact_counts.traces > 0;
  if (!evidence.passed && hasVisual && (!Array.isArray(parsed.failures) || parsed.failures.length === 0)) {
    return { yes: true, why: 'failure-with-visual-but-no-analysis' };
  }
  return { yes: false, why: '' };
}

async function main() {
  const mode = process.env.MODE || 'failure-analysis';
  const provider = (process.env.PROVIDER || 'openrouter').toLowerCase();
  const fastModel = process.env.FAST_MODEL;
  const smartModel = process.env.SMART_MODEL;
  const apiKey = process.env.API_KEY || '';
  const baseUrl = (process.env.BASE_URL || PROVIDER_DEFAULTS[provider] || '').trim();

  const evidence = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));

  // Decide whether to call.
  if (mode === 'off') {
    writeResult({ called: false, reason: 'mode=off' });
    setOutput('ai-called', 'false');
    setOutput('model-used', '');
    return;
  }
  if (mode === 'failure-analysis' && evidence.passed) {
    writeResult({ called: false, reason: 'tests-passed-failure-analysis-mode' });
    setOutput('ai-called', 'false');
    setOutput('model-used', '');
    return;
  }
  if (!apiKey) {
    writeResult({ called: false, reason: 'missing-api-key', error: 'api-key input not provided' });
    setOutput('ai-called', 'false');
    setOutput('model-used', '');
    console.log('::warning::Playwright AI Router: api-key not provided; skipping AI call.');
    return;
  }
  if (!baseUrl) {
    writeResult({ called: false, reason: 'missing-base-url' });
    setOutput('ai-called', 'false');
    setOutput('model-used', '');
    console.log(`::warning::Playwright AI Router: no base-url for provider="${provider}"; skipping AI call.`);
    return;
  }

  const messages = buildPrompt(evidence, mode);

  // Fast pass.
  let usedModel = fastModel;
  let raw = '';
  let parsed = null;
  let error = null;
  try {
    raw = await chat({ baseUrl, apiKey, model: fastModel, messages });
    parsed = tryParseJson(raw);
  } catch (e) {
    error = String(e && e.message || e);
  }

  let escalation = shouldEscalate(parsed, evidence);
  if (error) escalation = { yes: true, why: `fast-error:${error.slice(0, 80)}` };

  let smartRaw = '';
  let smartParsed = null;
  let smartError = null;
  if (escalation.yes && smartModel && smartModel !== fastModel) {
    try {
      // On escalation, append a note so smart model knows why it was called.
      const escMsgs = messages.concat([
        { role: 'user', content: `Escalation reason from fast model: ${escalation.why}. Re-analyze carefully and return the same JSON schema.` },
      ]);
      smartRaw = await chat({ baseUrl, apiKey, model: smartModel, messages: escMsgs });
      smartParsed = tryParseJson(smartRaw);
      if (smartParsed) {
        usedModel = smartModel;
        parsed = smartParsed;
      }
    } catch (e) {
      smartError = String(e && e.message || e);
    }
  }

  writeResult({
    called: true,
    fast_model: fastModel,
    smart_model: smartModel,
    model_used: usedModel,
    escalated: escalation.yes && smartParsed != null,
    escalation_reason: escalation.yes ? escalation.why : '',
    fast_error: error,
    smart_error: smartError,
    parsed,
    raw_fast: raw,
    raw_smart: smartRaw,
  });
  setOutput('ai-called', 'true');
  setOutput('model-used', usedModel || '');
}

main().catch((e) => {
  const msg = String(e && e.message || e);
  console.log(`::warning::Playwright AI Router: ${msg}`);
  writeResult({ called: false, reason: 'fatal-error', error: msg });
  setOutput('ai-called', 'false');
  setOutput('model-used', '');
});
