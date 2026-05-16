#!/usr/bin/env node
/*
 * Bounded generate -> run -> fix agent loop for `mode: test-plan`.
 *
 * For each attemptable Test plan item it asks an OpenAI-compatible model
 * (reusing the shared chat client + fast->smart escalation) to emit, via a
 * STRICT JSON protocol, the spec file(s) to write and the shell command(s) to
 * run. Trusted code applies sandboxed writes, runs ONLY allowlisted commands,
 * reuses run-tests.sh + collect-evidence.js to evaluate the spec, and feeds
 * compact failure evidence back. On green it commits the spec + its
 * screenshots (trusted code only — the model never runs git). Caps: per-item
 * max-iterations and wall-clock seconds.
 *
 * Writes OUT_DIR/test-plan-result.json (consumed by pr-writeback.js).
 * Never fails the job: generation problems are reported, not fatal.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chat, tryParseJson } = require('./lib/llm.js');
const { assertAllowed } = require('./lib/allowlist.js');
const { PROVIDER_DEFAULTS } = require('./lib/llm.js');

const OUT_DIR = process.env.OUT_DIR || '.playwright-ai-router';
const RESULT_PATH = path.join(OUT_DIR, 'test-plan-result.json');
const ITEMS_PATH = path.join(OUT_DIR, 'test-plan-items.json');
const ITER_DIR = path.join(OUT_DIR, 'iter');

const ACTION_DIR = path.resolve(__dirname, '..');
const RUN_TESTS = path.join(__dirname, 'run-tests.sh');
const COLLECT = path.join(__dirname, 'collect-evidence.js');

const SPEC_OUTPUT_DIR = (process.env.SPEC_OUTPUT_DIR || 'e2e/specs/generated').replace(/\/+$/, '');
const SCREENSHOT_DIR = (process.env.SCREENSHOT_DIR || '.playwright-ai-router/screenshots').replace(/\/+$/, '');
const TEST_COMMAND_SINGLE = (process.env.TEST_COMMAND_SINGLE || 'npx playwright test').trim();
const MAX_ITERATIONS = clampInt(process.env.MAX_ITERATIONS, 20, 1, 200);
const WALL_CLOCK_SECONDS = clampInt(process.env.WALL_CLOCK_SECONDS, 480, 10, 7200);
const SCREENSHOTS_PER_ITEM = clampInt(process.env.SCREENSHOTS_PER_ITEM, 8, 0, 50);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const BOT_NAME = process.env.BOT_NAME || 'playwright-ai-router[bot]';
const BOT_EMAIL = process.env.BOT_EMAIL || 'playwright-ai-router[bot]@users.noreply.github.com';

const MAX_WRITE_BYTES = 64 * 1024;
const MAX_WRITES_PER_ITER = 10;
const FEEDBACK_LOG_CHARS = 3000;

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeResult(obj) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(obj, null, 2));
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}

function withinDir(targetPath, baseDir) {
  const abs = path.resolve(targetPath);
  const base = path.resolve(baseDir);
  return abs === base || abs.startsWith(base + path.sep);
}

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', ...opts });
}

function buildMessages(item, suggestedSpecPath) {
  const sys = [
    'You are an autonomous Playwright test-authoring agent.',
    'Goal: implement ONE test-plan item as a passing Playwright spec.',
    'Respond ONLY with a single JSON object — no prose, no code fences.',
    'Schema: {',
    '  "reasoning": string (<= 500 chars),',
    '  "non_automatable": boolean,',
    '  "confidence": number between 0 and 1,',
    '  "file_writes": [{ "path": string, "content": string }],',
    '  "commands": [string],',
    '  "screenshots_expected": [string]',
    '}',
    `Write spec files ONLY under "${SPEC_OUTPUT_DIR}/" and end them with .spec.ts or .spec.js.`,
    `Take screenshots at meaningful steps via page.screenshot({ path: '${SCREENSHOT_DIR}/<name>-N.png' }) — only under "${SCREENSHOT_DIR}/".`,
    `Run the spec with EXACTLY: "${TEST_COMMAND_SINGLE} ${suggestedSpecPath}". You may also use "git status", "ls <path>", "cat <path>" to inspect.`,
    'You may NOT run rm, curl, git commit, git push, npm install, or any chained/piped command — they are rejected.',
    'Set non_automatable=true ONLY if this item fundamentally cannot be expressed as an automated browser test (e.g. requires a human judgement call, hardware, or third-party manual action).',
    'Set confidence<0.7 if you are unsure the spec will pass.',
    'Keep the spec self-contained and deterministic. Prefer resilient selectors.',
  ].join('\n');

  const user = [
    `Test plan item: ${item.title}`,
    process.env.APP_URL ? `App under test (base URL): ${process.env.APP_URL}` : 'No APP_URL provided; infer the base URL from the project config if needed.',
    `Suggested spec path: ${suggestedSpecPath}`,
    `Screenshot directory: ${SCREENSHOT_DIR}`,
    'Produce the spec now.',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

async function callModel(messages, baseUrl, apiKey, fastModel, smartModel) {
  let usedModel = fastModel;
  let raw = '';
  let parsed = null;
  let error = null;
  try {
    raw = await chat({ baseUrl, apiKey, model: fastModel, messages });
    parsed = tryParseJson(raw);
  } catch (e) { error = String(e && e.message || e); }

  let escalate = false;
  let why = '';
  if (error) { escalate = true; why = `fast-error:${error.slice(0, 80)}`; }
  else if (!parsed) { escalate = true; why = 'invalid-json'; }
  else if (typeof parsed.confidence === 'number' && parsed.confidence < 0.7) { escalate = true; why = `low-confidence(${parsed.confidence})`; }
  else if (parsed.non_automatable === true) { escalate = true; why = 'non-automatable-claim'; }

  if (escalate && smartModel && smartModel !== fastModel) {
    try {
      const escMsgs = messages.concat([
        { role: 'user', content: `Escalation reason: ${why}. Re-think carefully and return the same JSON schema.` },
      ]);
      const sraw = await chat({ baseUrl, apiKey, model: smartModel, messages: escMsgs });
      const sparsed = tryParseJson(sraw);
      if (sparsed) { usedModel = smartModel; parsed = sparsed; raw = sraw; error = null; }
    } catch (e) { /* keep fast result/error */ }
  }
  return { parsed, raw, error, usedModel };
}

function applyFileWrites(fileWrites) {
  const written = [];
  const rejections = [];
  if (!Array.isArray(fileWrites)) return { written, rejections };
  for (const fw of fileWrites.slice(0, MAX_WRITES_PER_ITER)) {
    const p = fw && typeof fw.path === 'string' ? fw.path : '';
    const content = fw && typeof fw.content === 'string' ? fw.content : '';
    if (!p || path.isAbsolute(p) || p.includes('..')) {
      rejections.push(`rejected write (absolute/traversal/empty): ${p}`);
      continue;
    }
    const isSpec = withinDir(p, SPEC_OUTPUT_DIR);
    const isShot = withinDir(p, SCREENSHOT_DIR);
    if (!isSpec && !isShot) {
      rejections.push(`rejected write (outside ${SPEC_OUTPUT_DIR}/ and ${SCREENSHOT_DIR}/): ${p}`);
      continue;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
      rejections.push(`rejected write (>${MAX_WRITE_BYTES} bytes): ${p}`);
      continue;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    written.push(p);
  }
  return { written, rejections };
}

function runInspection(cmd) {
  // cmd already passed assertAllowed and is a read-only git/ls/cat command.
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 60000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return out.slice(0, 2000);
}

function runSpec(specPath) {
  fs.rmSync(ITER_DIR, { recursive: true, force: true });
  fs.mkdirSync(ITER_DIR, { recursive: true });
  const cmd = `${TEST_COMMAND_SINGLE} ${specPath}`;
  spawnSync('bash', [RUN_TESTS], {
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, TEST_COMMAND: cmd, OUT_DIR: ITER_DIR },
  });
  spawnSync('node', [COLLECT], {
    encoding: 'utf8',
    env: { ...process.env, OUT_DIR: ITER_DIR },
  });
  return readJson(path.join(ITER_DIR, 'evidence.json'), { passed: false, exit_code: 1, log_tail: '', failed_tests: [] });
}

function listScreenshots() {
  try {
    return fs.readdirSync(SCREENSHOT_DIR)
      .filter((f) => /\.(png|jpe?g)$/i.test(f))
      .map((f) => path.join(SCREENSHOT_DIR, f));
  } catch { return []; }
}

function ensureGitIdentity() {
  git(['config', 'user.name', BOT_NAME]);
  git(['config', 'user.email', BOT_EMAIL]);
}

function rebaseGuard(headRef) {
  // Returns true if OK to keep committing, false if the branch moved and we
  // could not cleanly rebase (caller should stop, comment, exit 0).
  const fetch = git(['fetch', 'origin', headRef]);
  if (fetch.status !== 0) return true; // best effort; nothing to rebase onto
  const local = git(['rev-parse', 'HEAD']).stdout.trim();
  const remote = git(['rev-parse', `origin/${headRef}`]).stdout.trim();
  if (!remote || local === remote) return true;
  const base = git(['merge-base', 'HEAD', `origin/${headRef}`]).stdout.trim();
  if (base === remote) return true; // remote is an ancestor; we're ahead, fine
  const rb = git(['rebase', `origin/${headRef}`]);
  if (rb.status !== 0) {
    git(['rebase', '--abort']);
    return false;
  }
  return true;
}

async function main() {
  const items = readJson(ITEMS_PATH, { section_found: false, items: [] });
  const meta = readJson(process.env.PR_META_PATH || path.join(OUT_DIR, 'pr-meta.json'), {});
  const owner = meta.owner || '';
  const repo = meta.repo || '';
  const headRef = meta.head_ref || '';
  const isFork = meta.head_repo_fork === true;

  const result = {
    fork: isFork,
    section_found: items.section_found,
    items: [],
    commit_sha: '',
    branch_moved: false,
    totals: { total: 0, automated: 0, failed: 0, skipped: 0 },
  };

  if (isFork) {
    result.note = 'fork-pr-skipped';
    writeResult(result);
    console.log('::notice::test-plan: PR head is a fork; skipping generation (no secret/token access).');
    return;
  }

  const attemptable = items.items.filter((it) => !it.skip);
  // Pre-seed skipped (skip-pattern) items into the report.
  for (const it of items.items.filter((i) => i.skip)) {
    result.items.push({ ...it, status: 'skipped', screenshots: [], iterations: 0 });
    result.totals.skipped++;
  }
  result.totals.total = items.items.length;

  if (!items.section_found || attemptable.length === 0) {
    writeResult(result);
    console.log('::warning::test-plan: no automatable Test plan items found — PR shipped without generated coverage.');
    return;
  }

  const provider = (process.env.PROVIDER || 'openrouter').toLowerCase();
  const baseUrl = (process.env.BASE_URL || PROVIDER_DEFAULTS[provider] || '').trim();
  const apiKey = process.env.API_KEY || '';
  const fastModel = process.env.FAST_MODEL;
  const smartModel = process.env.SMART_MODEL;
  const token = process.env.GITHUB_TOKEN || '';

  if (!DRY_RUN && !token) {
    throw new Error('github-token is required for mode=test-plan (used to push commits and edit the PR).');
  }
  if (!apiKey || !baseUrl) {
    for (const it of attemptable) {
      result.items.push({ ...it, status: 'failed', screenshots: [], iterations: 0, last_failure_excerpt: 'missing api-key or base-url' });
      result.totals.failed++;
    }
    writeResult(result);
    console.log('::warning::test-plan: api-key/base-url not configured; cannot generate specs.');
    return;
  }

  if (!DRY_RUN) ensureGitIdentity();
  let committedAny = false;

  for (const item of attemptable) {
    const slug = `${slugify(item.title)}-${item.id}`;
    const suggestedSpecPath = `${SPEC_OUTPUT_DIR}/${slug}.spec.ts`;
    const shotsBefore = new Set(listScreenshots());
    const messages = buildMessages(item, suggestedSpecPath);
    const started = Date.now();
    let iterations = 0;
    let status = 'failed';
    let lastFailure = '';
    let specPath = suggestedSpecPath;

    while (iterations < MAX_ITERATIONS && (Date.now() - started) / 1000 < WALL_CLOCK_SECONDS) {
      iterations++;
      const { parsed, error } = await callModel(messages, baseUrl, apiKey, fastModel, smartModel);

      if (!parsed) {
        lastFailure = `model returned no parseable JSON (iter ${iterations})${error ? ': ' + error : ''}`;
        messages.push({ role: 'user', content: 'Your previous reply was not a single valid JSON object. Reply again with ONLY the JSON object per the schema.' });
        continue;
      }
      if (parsed.non_automatable === true) {
        status = 'skipped';
        lastFailure = 'model declared item non-automatable';
        break;
      }

      const { written, rejections } = applyFileWrites(parsed.file_writes);
      const specWrite = written.find((w) => /\.spec\.(ts|js)$/.test(w) && withinDir(w, SPEC_OUTPUT_DIR));
      if (specWrite) specPath = specWrite;

      // Run any model-proposed read-only inspection commands; collect rejections.
      const inspections = [];
      const cmdRejections = [...rejections];
      if (Array.isArray(parsed.commands)) {
        for (const cmd of parsed.commands) {
          let allowed = true;
          try { assertAllowed(cmd, { testCommand: TEST_COMMAND_SINGLE, specDir: SPEC_OUTPUT_DIR }); }
          catch (e) { allowed = false; cmdRejections.push(String(e.message || e)); }
          if (!allowed) continue;
          if (cmd.trim().startsWith(TEST_COMMAND_SINGLE)) continue; // test run handled below
          inspections.push(`$ ${cmd}\n${runInspection(cmd)}`);
        }
      }

      if (!fs.existsSync(specPath)) {
        lastFailure = 'no spec file was written under the spec output dir';
        messages.push({ role: 'user', content: `${lastFailure}. Write the spec to ${suggestedSpecPath} via file_writes. ${cmdRejections.join(' | ')}` });
        continue;
      }

      const ev = runSpec(specPath);
      if (ev.passed) {
        status = 'automated';
        break;
      }
      const tailExcerpt = String(ev.log_tail || '').slice(-FEEDBACK_LOG_CHARS);
      lastFailure = tailExcerpt.slice(-600);
      const feedback = [
        `The spec FAILED (exit ${ev.exit_code}).`,
        ev.failed_tests && ev.failed_tests.length ? `Failed tests: ${JSON.stringify(ev.failed_tests)}` : '',
        cmdRejections.length ? `Rejected commands: ${cmdRejections.join(' | ')}` : '',
        inspections.length ? `Inspection output:\n${inspections.join('\n').slice(0, 2000)}` : '',
        'Failure log tail:',
        '```',
        tailExcerpt,
        '```',
        'Fix the spec and return the same JSON schema (re-send the full spec content in file_writes).',
      ].filter(Boolean).join('\n');
      messages.push({ role: 'user', content: feedback });
    }

    const shotsAfter = listScreenshots();
    let itemShots = shotsAfter.filter((s) => !shotsBefore.has(s));
    if (itemShots.length > SCREENSHOTS_PER_ITEM) {
      for (const extra of itemShots.slice(SCREENSHOTS_PER_ITEM)) {
        try { fs.rmSync(extra, { force: true }); } catch {}
      }
      itemShots = itemShots.slice(0, SCREENSHOTS_PER_ITEM);
    }

    const rec = {
      ...item,
      status,
      spec_path: status === 'automated' ? specPath : '',
      screenshots: status === 'automated' ? itemShots : [],
      iterations,
      last_failure_excerpt: status === 'automated' ? '' : lastFailure,
    };
    result.items.push(rec);
    result.totals[status === 'automated' ? 'automated' : status === 'skipped' ? 'skipped' : 'failed']++;

    if (status === 'automated' && !DRY_RUN) {
      if (!rebaseGuard(headRef)) {
        result.branch_moved = true;
        writeResult(result);
        console.log('::warning::test-plan: head branch moved and could not be rebased cleanly; will retry next push.');
        return;
      }
      git(['add', '--', specPath, ...itemShots]);
      const c = git(['commit', '-m', `test(ai): automate '${item.title}' [skip ci]`]);
      if (c.status === 0) committedAny = true;
    }
  }

  if (committedAny && !DRY_RUN) {
    if (!rebaseGuard(headRef)) {
      result.branch_moved = true;
      writeResult(result);
      console.log('::warning::test-plan: head branch moved before push; will retry next push.');
      return;
    }
    const remote = owner && repo
      ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
      : 'origin';
    const push = git(['push', remote, `HEAD:${headRef}`]);
    if (push.status === 0) {
      result.commit_sha = git(['rev-parse', 'HEAD']).stdout.trim();
    } else {
      console.log(`::warning::test-plan: git push failed: ${(push.stderr || '').slice(0, 300)}`);
    }
  }

  writeResult(result);

  if (result.totals.automated === 0) {
    console.log('::warning::test-plan: no specs were generated for this PR — shipped without generated coverage.');
  }
  console.log(`test-plan: total=${result.totals.total} automated=${result.totals.automated} failed=${result.totals.failed} skipped=${result.totals.skipped} commit=${result.commit_sha || '(none)'}${DRY_RUN ? ' [DRY_RUN]' : ''}`);
}

main().catch((e) => {
  const msg = String(e && e.message || e);
  console.log(`::error::test-plan generate-spec failed: ${msg}`);
  // Still emit a result so writeback/outputs are coherent; never fail the job.
  try {
    const existing = readJson(RESULT_PATH, null);
    if (!existing) writeResult({ fork: false, section_found: false, items: [], commit_sha: '', branch_moved: false, totals: { total: 0, automated: 0, failed: 0, skipped: 0 }, error: msg });
  } catch {}
  process.exit(0);
});
