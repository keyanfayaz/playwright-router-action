'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('test-plan fails closed even with credentials and a requested test command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-plan-'));
  try {
    fs.mkdirSync(path.join(dir, '.playwright-ai-router'));
    fs.writeFileSync(path.join(dir, '.playwright-ai-router/test-plan-items.json'), JSON.stringify({section_found: true, items: [{ id: '1', title: 'example' }]}));
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/generate-spec.js')], {
      cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, API_KEY: 'synthetic', GITHUB_TOKEN: 'synthetic', TEST_COMMAND_SINGLE: 'touch SHOULD_NOT_EXIST' },
    });
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(path.join(dir, 'SHOULD_NOT_EXIST')), false);
    assert.equal(fs.existsSync(path.join(dir, 'e2e')), false);
    const report = JSON.parse(fs.readFileSync(path.join(dir, '.playwright-ai-router/test-plan-result.json')));
    assert.equal(report.blocked, true);
    assert.equal(report.totals.automated, 0);
    assert.equal(report.totals.skipped, 1);
    assert.equal(report.commit_sha, '');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
