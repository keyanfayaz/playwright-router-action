'use strict';
/*
 * Smokes build-html-report.js across the three modes it has to support:
 *   1. failure-analysis success
 *   2. failure-analysis failure with AI verdict + screenshots
 *   3. test-plan with one automated / one failed / one skipped item
 *
 * Each case runs the script as a subprocess inside a temp cwd, then asserts on
 * the generated playwright-ai-router-report.html: stable data-* hooks, item
 * titles, badge counts, and pill labels.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'build-html-report.js');
const REPORT_NAME = 'playwright-ai-router-report.html';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'html-report-'));
}

function writeJson(dir, name, obj) {
  fs.mkdirSync(path.join(dir, '.playwright-ai-router'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.playwright-ai-router', name), JSON.stringify(obj));
}

function run(dir, env) {
  execFileSync('node', [SCRIPT], { cwd: dir, env: { ...process.env, ...env } });
  return fs.readFileSync(path.join(dir, REPORT_NAME), 'utf8');
}

test('failure-analysis success: verdict pill + AI summary render', () => {
  const dir = tmp();
  writeJson(dir, 'evidence.json', {
    mode: 'failure-analysis', passed: true, exit_code: 0,
    failed_tests: [], failed_count_reported: 0,
    artifact_counts: { screenshots: 0, videos: 0, traces: 0, report_files: 1, result_files: 0 },
    sample_artifacts: { screenshots: [], videos: [], traces: [] },
    log_tail: 'all good',
  });
  writeJson(dir, 'ai-response.json', {
    called: true, model_used: 'qwen/qwen3-coder', escalated: false,
    parsed: { verdict: 'pass', confidence: 0.92, summary: 'Tests look healthy.', failures: [] },
  });
  const html = run(dir, { MODE: 'failure-analysis' });
  assert.match(html, /data-status="success"/);
  assert.match(html, /data-verdict="success"/);
  assert.match(html, /Tests look healthy\./);
  assert.match(html, /qwen\/qwen3-coder/);
  assert.match(html, /92% confidence/);
});

test('failure-analysis failure: failure pill + AI failure card', () => {
  const dir = tmp();
  writeJson(dir, 'evidence.json', {
    mode: 'failure-analysis', passed: false, exit_code: 1,
    failed_tests: ['specs/login.spec.ts > sign in'], failed_count_reported: 1,
    artifact_counts: { screenshots: 2, videos: 0, traces: 1, report_files: 3, result_files: 5 },
    sample_artifacts: { screenshots: [], videos: [], traces: [] },
    log_tail: 'FAIL specs/login.spec.ts',
  });
  writeJson(dir, 'ai-response.json', {
    called: true, model_used: 'moonshotai/kimi-k2.6', escalated: true, escalation_reason: 'low confidence',
    parsed: {
      verdict: 'fail', confidence: 0.86, summary: 'Login button selector changed.',
      failures: [{ test: 'sign in', likely_cause: 'Button text updated.', suggested_fix: 'Update locator.' }],
    },
  });
  const html = run(dir, { MODE: 'failure-analysis' });
  assert.match(html, /data-status="failure"/);
  assert.match(html, /data-verdict="failure"/);
  assert.match(html, /data-ai-verdict="fail"/);
  assert.match(html, /Login button selector changed\./);
  assert.match(html, /Button text updated\./);
  assert.match(html, /escalated.*low confidence/);
  assert.match(html, /specs\/login\.spec\.ts/);
});

test('test-plan: renders automated/failed/skipped groups with counts', () => {
  const dir = tmp();
  writeJson(dir, 'test-plan-result.json', {
    fork: false,
    section_found: true,
    branch_moved: false,
    commit_sha: 'abc1234deadbeef',
    totals: { total: 3, automated: 1, failed: 1, skipped: 1 },
    items: [
      { title: 'home page returns 200', status: 'automated', spec_path: 'e2e/specs/generated/home.spec.ts', screenshots: [], iterations: 2 },
      { title: 'checkout flow', status: 'failed', screenshots: [], iterations: 20, last_failure_excerpt: 'Timeout exceeded.' },
      { title: 'manually verify with PM', status: 'skipped', skip_reason: 'matches skip-pattern' },
    ],
  });
  writeJson(dir, 'pr-meta.json', { owner: 'me', repo: 'app', number: 42, head_ref: 'feat/x', body: '' });
  const html = run(dir, { MODE: 'test-plan' });
  assert.match(html, /data-group="automated"/);
  assert.match(html, /data-group="failed"/);
  assert.match(html, /data-group="skipped"/);
  assert.match(html, /home page returns 200/);
  assert.match(html, /checkout flow/);
  assert.match(html, /manually verify with PM/);
  assert.match(html, /e2e\/specs\/generated\/home\.spec\.ts/);
  assert.match(html, /Timeout exceeded\./);
  assert.match(html, /matches skip-pattern/);
  // Spec link goes to the bot commit SHA.
  assert.match(html, /blob\/abc1234deadbeef\/e2e\/specs\/generated\/home\.spec\.ts/);
  // PR footer link.
  assert.match(html, /pull\/42/);
});

test('test-plan: with no inputs at all, still writes a valid HTML doc', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.playwright-ai-router'), { recursive: true });
  const html = run(dir, { MODE: 'test-plan' });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Playwright AI Router/);
});
