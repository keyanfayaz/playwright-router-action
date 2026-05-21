#!/usr/bin/env node
/*
 * Writes the test-plan run back to the PR:
 *   1. re-fetches the CURRENT PR body (never reuses the start-of-run copy, so
 *      concurrent edits are not clobbered)
 *   2. ticks each automated item's checkbox by matching its exact raw line
 *   3. PATCHes the PR with the minimally-edited body
 *   4. posts/updates ONE idempotent marker comment summarising the run, with
 *      screenshots inlined via raw.github URLs
 *   5. sets the action outputs
 *
 * DRY_RUN=1 performs no network writes — it dumps the would-be body and comment
 * to OUT_DIR. Never fails the job.
 */
const fs = require('fs');
const path = require('path');
const { setOutput } = require('./lib/llm.js');

const OUT_DIR = process.env.OUT_DIR || '.playwright-ai-router';
const RESULT_PATH = path.join(OUT_DIR, 'test-plan-result.json');
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const SERVER = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
const MARKER = '<!-- playwright-ai-router:test-plan -->';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

async function gh(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'playwright-ai-router',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`GitHub ${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function tickCheckbox(line) {
  return line.replace(/\[ \]/, '[x]');
}

function applyTicks(body, automatedItems) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const notes = [];
  for (const it of automatedItems) {
    const target = String(it.raw_line || '').replace(/\s+$/, '');
    if (!target) continue;
    const idx = lines.findIndex((l) => l.replace(/\s+$/, '') === target);
    if (idx === -1) {
      notes.push(`could not tick "${it.title}" — its line changed in the PR body`);
      continue;
    }
    lines[idx] = tickCheckbox(lines[idx]);
  }
  return { body: lines.join('\n'), notes };
}

function rawUrl(owner, repo, headRef, p) {
  const clean = String(p).replace(/^\.\//, '');
  return `${SERVER}/${owner}/${repo}/raw/${headRef}/${clean}`;
}

function buildComment(result, owner, repo, headRef, tickNotes) {
  const by = (s) => result.items.filter((i) => i.status === s);
  const automated = by('automated');
  const failed = by('failed');
  const skipped = by('skipped');
  const L = [MARKER, '', '## 🎭 Playwright AI Router — test plan', ''];

  if (result.fork) {
    L.push('> PR head is a fork; spec generation was skipped (no secret/token access).', '');
  }
  L.push(`**${automated.length} automated · ${failed.length} failed · ${skipped.length} skipped**`, '');

  if (automated.length) {
    L.push('### ✅ Automated');
    for (const it of automated) {
      L.push(`- **${it.title}** — \`${it.spec_path}\``);
      for (const s of (it.screenshots || [])) {
        L.push('', `  ![${path.basename(s)}](${rawUrl(owner, repo, headRef, s)})`);
      }
    }
    L.push('');
  }
  if (failed.length) {
    L.push('### ❌ Failed (left unchecked)');
    for (const it of failed) {
      L.push(`- **${it.title}** — gave up after ${it.iterations} iteration(s)`);
      if (it.last_failure_excerpt) {
        L.push('', '  <details><summary>last failure</summary>', '', '  ```', ...String(it.last_failure_excerpt).split('\n').map((x) => '  ' + x), '  ```', '', '  </details>');
      }
    }
    L.push('');
  }
  if (skipped.length) {
    L.push('### ⏭️ Skipped (left unchecked)');
    for (const it of skipped) {
      L.push(`- ${it.title} _(${it.skip_reason || it.last_failure_excerpt || 'not automatable'})_`);
    }
    L.push('');
  }
  if (result.branch_moved) {
    L.push('> ⚠️ The head branch moved during the run; will retry on the next push.', '');
  }
  if (tickNotes && tickNotes.length) {
    L.push('> Note: ' + tickNotes.join('; '), '');
  }
  L.push('📊 Full visual report: download the `playwright-ai-router-report` workflow artifact.');
  return L.join('\n');
}

async function findMarkerComment(owner, repo, number, token) {
  let page = 1;
  while (page <= 10) {
    const comments = await gh('GET', `${API}/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`, token);
    if (!Array.isArray(comments) || comments.length === 0) break;
    const hit = comments.find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
    if (hit) return hit;
    if (comments.length < 100) break;
    page++;
  }
  return null;
}

async function main() {
  const result = readJson(RESULT_PATH, { items: [], totals: { total: 0, automated: 0, failed: 0, skipped: 0 }, commit_sha: '' });
  const meta = readJson(process.env.PR_META_PATH || path.join(OUT_DIR, 'pr-meta.json'), {});
  const { owner, repo, number, head_ref: headRef } = meta;
  const token = process.env.GITHUB_TOKEN || '';
  const totals = result.totals || { total: 0, automated: 0, failed: 0, skipped: 0 };

  setOutput('items-total', totals.total || 0);
  setOutput('items-automated', totals.automated || 0);
  setOutput('items-failed', totals.failed || 0);
  setOutput('items-skipped', totals.skipped || 0);
  setOutput('commit-sha', result.commit_sha || '');

  const automated = result.items.filter((i) => i.status === 'automated');

  if (DRY_RUN || !token || !owner || !repo || !number) {
    let body = meta.body || '';
    const { body: edited, notes } = applyTicks(body, automated);
    const comment = buildComment(result, owner || 'OWNER', repo || 'REPO', headRef || 'BRANCH', notes);
    fs.writeFileSync(path.join(OUT_DIR, 'would-be-pr-body.md'), edited);
    fs.writeFileSync(path.join(OUT_DIR, 'would-be-comment.md'), comment);
    console.log(`test-plan writeback: ${DRY_RUN ? 'DRY_RUN' : 'no token/meta'} — wrote would-be body + comment to ${OUT_DIR}/`);
    return;
  }

  // 1. Re-fetch the CURRENT body.
  const pr = await gh('GET', `${API}/repos/${owner}/${repo}/pulls/${number}`, token);
  const freshBody = pr.body || '';

  // 2-3. Tick automated items and PATCH the PR if anything changed.
  const { body: editedBody, notes } = applyTicks(freshBody, automated);
  if (editedBody !== freshBody) {
    await gh('PATCH', `${API}/repos/${owner}/${repo}/pulls/${number}`, token, { body: editedBody });
  }

  // 4. Idempotent comment.
  const commentBody = buildComment(result, owner, repo, headRef, notes);
  const existing = await findMarkerComment(owner, repo, number, token);
  if (existing) {
    await gh('PATCH', `${API}/repos/${owner}/${repo}/issues/comments/${existing.id}`, token, { body: commentBody });
  } else {
    await gh('POST', `${API}/repos/${owner}/${repo}/issues/${number}/comments`, token, { body: commentBody });
  }

  console.log(`test-plan writeback: ticked=${automated.length} comment=${existing ? 'updated' : 'created'}`);
}

main().catch((e) => {
  console.log(`::warning::test-plan writeback failed: ${String(e && e.message || e)}`);
  process.exit(0);
});
