'use strict';
/*
 * End-to-end exercise of the bounded agent loop with a MOCK OpenAI-compatible
 * server (no network, no real model, no deps). Verifies:
 *   - generate -> fail -> feedback -> fix -> green across iterations
 *   - reuse of run-tests.sh + collect-evidence.js to judge pass/fail
 *   - command allowlist: a model-proposed `rm -rf .` is rejected and NOT run
 *     (a sentinel file survives) yet the loop still reaches green
 *   - screenshots are capped to screenshots-per-item
 *   - DRY_RUN performs no git mutation; result JSON reports items-automated
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const REPO = path.resolve(__dirname, '..');

function mockServer(responsesByCall) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      const content = responsesByCall(calls);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return server;
}

test('agent loop: fail -> fix -> green, allowlist enforced, screenshots capped, DRY_RUN', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  // Sample project: a fake "playwright" runner that passes iff the spec
  // contains the PASS marker.
  fs.writeFileSync(path.join(dir, '__faketest.sh'), 'grep -q PASS "$1" && exit 0 || exit 1\n');
  fs.writeFileSync(path.join(dir, 'SENTINEL'), 'do-not-delete');
  fs.mkdirSync(path.join(dir, '.playwright-ai-router'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.playwright-ai-router', 'pr-meta.json'),
    JSON.stringify({ owner: 'o', repo: 'r', number: 1, head_ref: 'feat', head_repo_fork: false, body: 'x' }));
  fs.writeFileSync(path.join(dir, '.playwright-ai-router', 'test-plan-items.json'),
    JSON.stringify({ section_found: true, items: [
      { id: 'deadbeef', title: 'home returns 200', raw_line: '- [ ] home returns 200', line_index: 1, manual_hint: false, skip: false, skip_reason: '' },
    ] }));

  const SPEC = 'e2e/specs/generated/home-returns-200-deadbeef.spec.ts';
  const shots = (n) => Array.from({ length: 5 }, (_, i) =>
    ({ path: `.playwright-ai-router/screenshots/shot-${i + 1}.png`, content: `png${n}` }));

  const server = mockServer((call) => {
    if (call === 1) {
      // Failing spec + a DISALLOWED command that must never execute.
      return JSON.stringify({
        reasoning: 'first attempt', non_automatable: false, confidence: 0.9,
        file_writes: [{ path: SPEC, content: '// first attempt, no marker\n' }, ...shots(1)],
        commands: ['rm -rf .', `bash __faketest.sh ${SPEC}`],
        screenshots_expected: [],
      });
    }
    // Fixed spec -> fake runner passes.
    return JSON.stringify({
      reasoning: 'fixed', non_automatable: false, confidence: 0.95,
      file_writes: [{ path: SPEC, content: '// PASS now\n' }, ...shots(2)],
      commands: [`bash __faketest.sh ${SPEC}`],
      screenshots_expected: [],
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const env = {
    ...process.env,
    OUT_DIR: '.playwright-ai-router',
    PR_META_PATH: '.playwright-ai-router/pr-meta.json',
    PROVIDER: 'openai',
    BASE_URL: `http://127.0.0.1:${port}`,
    API_KEY: 'test-key',
    FAST_MODEL: 'fast',
    SMART_MODEL: 'smart',
    SPEC_OUTPUT_DIR: 'e2e/specs/generated',
    SCREENSHOT_DIR: '.playwright-ai-router/screenshots',
    SCREENSHOTS_PER_ITEM: '3',
    TEST_COMMAND_SINGLE: 'bash __faketest.sh',
    MAX_ITERATIONS: '5',
    WALL_CLOCK_SECONDS: '120',
    DRY_RUN: '1',
  };

  const r = await run('node', [path.join(REPO, 'scripts/generate-spec.js')], {
    cwd: dir, env,
  });
  server.close();

  assert.equal(r.status, 0, `generate-spec should exit 0\n${r.stdout}\n${r.stderr}`);

  const result = JSON.parse(fs.readFileSync(path.join(dir, '.playwright-ai-router', 'test-plan-result.json'), 'utf8'));
  assert.equal(result.totals.automated, 1, 'item should be automated');
  assert.equal(result.totals.total, 1);
  assert.equal(result.commit_sha, '', 'DRY_RUN must not push/commit');

  // Spec was written under the spec output dir and reached green.
  assert.ok(fs.existsSync(path.join(dir, SPEC)), 'spec file should exist');
  assert.match(fs.readFileSync(path.join(dir, SPEC), 'utf8'), /PASS/);

  // Allowlist: `rm -rf .` must have been rejected — sentinel + spec survive.
  assert.ok(fs.existsSync(path.join(dir, 'SENTINEL')), 'rm must have been blocked');

  // Screenshots capped to SCREENSHOTS_PER_ITEM (3) — 2 extras deleted.
  const pngs = fs.readdirSync(path.join(dir, '.playwright-ai-router', 'screenshots')).filter((f) => f.endsWith('.png'));
  assert.equal(pngs.length, 3, `expected 3 screenshots, got ${pngs.length}`);
  const rec = result.items.find((i) => i.status === 'automated');
  assert.equal(rec.screenshots.length, 3);

  // No git repo / no commit happened in DRY_RUN.
  assert.ok(!fs.existsSync(path.join(dir, '.git')), 'no repo mutation expected');
});
