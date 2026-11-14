#!/usr/bin/env node
'use strict';
// Fail closed: arbitrary model-authored code must not share a runner with
// provider credentials, checkout credentials, or a PR write token. A command
// allowlist or a filtered child environment does not provide that boundary.
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.OUT_DIR || '.playwright-ai-router';
let plan = { section_found: false, items: [] };
try { plan = JSON.parse(fs.readFileSync(path.join(out, 'test-plan-items.json'), 'utf8')); } catch {}
const items = Array.isArray(plan.items) ? plan.items : [];
const reason = 'test-plan execution is disabled pending an isolated, credential-free runner and reviewed writeback';
const result = {
  fork: false, section_found: plan.section_found === true,
  items: items.map(item => ({ ...item, status: 'skipped', screenshots: [], iterations: 0, last_failure_excerpt: reason })),
  commit_sha: '', branch_moved: false,
  totals: { total: items.length, automated: 0, failed: 0, skipped: items.length },
  blocked: true, note: reason,
};
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'test-plan-result.json'), JSON.stringify(result, null, 2));
console.error(`::error::${reason}`);
process.exitCode = 1;
