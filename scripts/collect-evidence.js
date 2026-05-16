#!/usr/bin/env node
/*
 * Builds a compact evidence packet from a Playwright run.
 * Reads .playwright-ai-router/{test-output.log,exit-code} and inspects
 * test-results/ and playwright-report/ if present. Writes
 * .playwright-ai-router/evidence.json. Designed to stay small enough to send
 * to a cheap model without blowing the token budget.
 */
const fs = require('fs');
const path = require('path');

// OUT_DIR / REPORT_DIR / RESULTS_DIR are env-overridable so a single spec can
// be evidenced into a per-iteration scratch dir. Unset => original behavior.
const OUT_DIR = process.env.OUT_DIR || '.playwright-ai-router';
const REPORT_DIR = process.env.REPORT_DIR || 'playwright-report';
const RESULTS_DIR = process.env.RESULTS_DIR || 'test-results';
const LOG_PATH = path.join(OUT_DIR, 'test-output.log');
const EXIT_PATH = path.join(OUT_DIR, 'exit-code');
const EVIDENCE_PATH = path.join(OUT_DIR, 'evidence.json');

const MAX_LOG_CHARS = 8000;
const MAX_FILES_LISTED = 50;
const MAX_FAILED_TESTS = 25;

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function tail(str, max) {
  if (str.length <= max) return str;
  return '…(truncated)…\n' + str.slice(str.length - max);
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length && out.length < MAX_FILES_LISTED * 4) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        out.push({ path: full, size });
      }
    }
  }
  return out;
}

function parseFailures(log) {
  const failed = new Set();
  // Playwright list reporter prints lines like:  "  1) [chromium] › specs/foo.spec.ts:12:3 › my test"
  const lineRe = /\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?([^\n]+?)(?:\s+─|\s+✘|\s*$)/g;
  let m;
  while ((m = lineRe.exec(log)) !== null) {
    const t = m[1].trim();
    if (t && !/^Error/i.test(t)) failed.add(t);
    if (failed.size >= MAX_FAILED_TESTS) break;
  }
  // Also pull "X failed" summary line.
  const sumRe = /(\d+)\s+failed/i;
  const sum = sumRe.exec(log);
  return {
    failed_tests: Array.from(failed),
    failed_count_reported: sum ? Number(sum[1]) : null,
  };
}

const rawLog = readSafe(LOG_PATH);
const log = stripAnsi(rawLog);
const exitCode = Number((readSafe(EXIT_PATH) || '1').trim()) || 0;
const passed = exitCode === 0;

const reportFiles = listFiles(REPORT_DIR);
const resultFiles = listFiles(RESULTS_DIR);

const screenshots = resultFiles.filter(f => /\.(png|jpg|jpeg)$/i.test(f.path));
const videos = resultFiles.filter(f => /\.(webm|mp4)$/i.test(f.path));
const traces = resultFiles.filter(f => /trace\.zip$/i.test(f.path));

const { failed_tests, failed_count_reported } = parseFailures(log);

const evidence = {
  mode: process.env.MODE || 'failure-analysis',
  app_url: process.env.APP_URL || '',
  passed,
  exit_code: exitCode,
  failed_count_reported,
  failed_tests,
  artifact_counts: {
    screenshots: screenshots.length,
    videos: videos.length,
    traces: traces.length,
    report_files: reportFiles.length,
    result_files: resultFiles.length,
  },
  sample_artifacts: {
    screenshots: screenshots.slice(0, 10).map(f => f.path),
    videos: videos.slice(0, 5).map(f => f.path),
    traces: traces.slice(0, 5).map(f => f.path),
  },
  log_tail: tail(log, MAX_LOG_CHARS),
};

fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
console.log(`evidence: passed=${passed} failed_tests=${failed_tests.length} screenshots=${screenshots.length} traces=${traces.length}`);
