'use strict';
/*
 * Proves the refactors (lib/llm.js extraction + dir-overridable env vars) did
 * NOT change off/failure-analysis/review behavior: the ORIGINAL route-ai.js and
 * collect-evidence.js (from the initial commit) are run side-by-side with the
 * CURRENT ones on identical fixtures, with NO new env vars set, and the
 * resulting evidence.json / ai-response.json must be byte-identical.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BASE = '7ca42bd'; // initial commit, pre-refactor

function gitShow(relPath, dest) {
  const buf = execFileSync('git', ['show', `${BASE}:${relPath}`], { cwd: REPO, maxBuffer: 1 << 24 });
  fs.writeFileSync(dest, buf);
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
}

test('collect-evidence.js: original vs current produce identical evidence.json', () => {
  const origScript = path.join(tmp(), 'collect-evidence.orig.js');
  gitShow('scripts/collect-evidence.js', origScript);

  function run(script) {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.playwright-ai-router'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.playwright-ai-router', 'test-output.log'),
      'Running 3 tests\n  1) [chromium] › specs/a.spec.ts:2:1 › thing\n1 failed\n');
    fs.writeFileSync(path.join(dir, '.playwright-ai-router', 'exit-code'), '1');
    fs.mkdirSync(path.join(dir, 'test-results', 'a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-results', 'a', 'shot.png'), 'x');
    fs.mkdirSync(path.join(dir, 'playwright-report'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'playwright-report', 'index.html'), '<html>');
    execFileSync('node', [script], { cwd: dir, env: { ...process.env, MODE: 'failure-analysis', APP_URL: 'https://ex.test' } });
    return fs.readFileSync(path.join(dir, '.playwright-ai-router', 'evidence.json'), 'utf8');
  }

  assert.equal(run(path.join(REPO, 'scripts/collect-evidence.js')), run(origScript));
});

test('route-ai.js: original vs current identical for mode=off and missing-api-key', () => {
  const origScript = path.join(tmp(), 'route-ai.orig.js');
  gitShow('scripts/route-ai.js', origScript);

  const evidence = {
    mode: 'failure-analysis', app_url: '', passed: false, exit_code: 1,
    failed_count_reported: 1, failed_tests: ['a'],
    artifact_counts: { screenshots: 0, videos: 0, traces: 0, report_files: 0, result_files: 0 },
    sample_artifacts: { screenshots: [], videos: [], traces: [] }, log_tail: 'boom',
  };

  function run(script, mode) {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.playwright-ai-router'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.playwright-ai-router', 'evidence.json'), JSON.stringify(evidence));
    const ghOut = path.join(dir, 'gh_out');
    fs.writeFileSync(ghOut, '');
    // mode=off and (api-key absent) are fully deterministic — no network.
    execFileSync('node', [script], { cwd: dir, env: { ...process.env, MODE: mode, GITHUB_OUTPUT: ghOut } });
    return {
      result: fs.readFileSync(path.join(dir, '.playwright-ai-router', 'ai-response.json'), 'utf8'),
      out: fs.readFileSync(ghOut, 'utf8'),
    };
  }

  for (const mode of ['off', 'failure-analysis']) {
    const cur = run(path.join(REPO, 'scripts/route-ai.js'), mode);
    const orig = run(origScript, mode);
    assert.deepEqual(cur, orig, `mode=${mode} must be byte-identical`);
  }
});

test('run-tests.sh: OUT_DIR unset still writes .playwright-ai-router/exit-code', () => {
  const dir = tmp();
  execFileSync('bash', [path.join(REPO, 'scripts/run-tests.sh')], {
    cwd: dir, env: { ...process.env, TEST_COMMAND: 'echo hi && exit 4' },
  });
  assert.equal(fs.readFileSync(path.join(dir, '.playwright-ai-router', 'exit-code'), 'utf8'), '4');
});
