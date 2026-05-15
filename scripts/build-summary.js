#!/usr/bin/env node
/*
 * Renders playwright-ai-router-summary.md from evidence + ai-response.
 * Sets the `summary-path` and `conclusion` step outputs.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = '.playwright-ai-router';
const SUMMARY_PATH = 'playwright-ai-router-summary.md';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${key}=${value}\n`);
}

const evidence = readJson(path.join(OUT_DIR, 'evidence.json')) || {};
const ai = readJson(path.join(OUT_DIR, 'ai-response.json')) || { called: false };

const passed = !!evidence.passed;
const mode = process.env.MODE || 'failure-analysis';
const appUrl = process.env.APP_URL || evidence.app_url || '';

let conclusion;
if (passed && !(ai.called && ai.parsed && ai.parsed.verdict === 'fail')) {
  conclusion = 'success';
} else if (!passed) {
  conclusion = 'failure';
} else {
  conclusion = 'ai-flagged';
}

const lines = [];
lines.push('# Playwright AI Router');
lines.push('');
lines.push(`- **Mode:** \`${mode}\``);
lines.push(`- **Playwright:** ${passed ? '✅ passed' : '❌ failed'} (exit ${evidence.exit_code})`);
if (appUrl) lines.push(`- **App URL:** ${appUrl}`);
if (Array.isArray(evidence.failed_tests) && evidence.failed_tests.length > 0) {
  lines.push(`- **Failed tests (parsed):** ${evidence.failed_tests.length}`);
}
const counts = evidence.artifact_counts || {};
lines.push(`- **Artifacts:** screenshots=${counts.screenshots || 0}, videos=${counts.videos || 0}, traces=${counts.traces || 0}`);
lines.push('');

if (!ai.called) {
  lines.push('## AI');
  lines.push(`_No AI call was made (${ai.reason || 'n/a'})._`);
} else {
  lines.push('## AI');
  lines.push(`- **Model used:** \`${ai.model_used || '(unknown)'}\``);
  lines.push(`- **Escalated to smart model:** ${ai.escalated ? 'yes' : 'no'}${ai.escalation_reason ? ` (${ai.escalation_reason})` : ''}`);
  if (ai.parsed) {
    const p = ai.parsed;
    if (p.verdict) lines.push(`- **Verdict:** \`${p.verdict}\``);
    if (typeof p.confidence === 'number') lines.push(`- **Confidence:** ${p.confidence}`);
    if (p.needs_visual_review) lines.push('- **Needs visual review:** yes');
    lines.push('');
    if (p.summary) {
      lines.push('### Summary');
      lines.push(String(p.summary));
      lines.push('');
    }
    if (Array.isArray(p.failures) && p.failures.length) {
      lines.push('### Failures');
      for (const f of p.failures) {
        lines.push(`- **${f.test || '(unnamed)'}**`);
        if (f.likely_cause) lines.push(`  - Likely cause: ${f.likely_cause}`);
        if (f.suggested_fix) lines.push(`  - Suggested fix: ${f.suggested_fix}`);
      }
      lines.push('');
    }
  } else {
    lines.push('');
    lines.push('_AI response could not be parsed as JSON._');
    if (ai.fast_error) lines.push(`- fast model error: \`${String(ai.fast_error).slice(0, 200)}\``);
    if (ai.smart_error) lines.push(`- smart model error: \`${String(ai.smart_error).slice(0, 200)}\``);
  }
}

if (Array.isArray(evidence.failed_tests) && evidence.failed_tests.length > 0) {
  lines.push('');
  lines.push('<details><summary>Parsed failed test list</summary>');
  lines.push('');
  for (const t of evidence.failed_tests) lines.push(`- \`${t}\``);
  lines.push('');
  lines.push('</details>');
}

fs.writeFileSync(SUMMARY_PATH, lines.join('\n') + '\n');

setOutput('summary-path', SUMMARY_PATH);
setOutput('conclusion', conclusion);
console.log(`summary written: ${SUMMARY_PATH} conclusion=${conclusion}`);
