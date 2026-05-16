#!/usr/bin/env node
/*
 * Extracts PR metadata from the GitHub event payload ($GITHUB_EVENT_PATH) —
 * zero network calls. Writes OUT_DIR/pr-meta.json:
 *   { owner, repo, number, head_ref, head_sha, head_repo_fork, body }
 * pr-writeback.js re-fetches the live body just before editing; this body is
 * only the start-of-run snapshot used for parsing and DRY_RUN.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = process.env.OUT_DIR || '.playwright-ai-router';
const OUT = path.join(OUT_DIR, 'pr-meta.json');

function main() {
  const evPath = process.env.GITHUB_EVENT_PATH;
  let ev = {};
  try { ev = JSON.parse(fs.readFileSync(evPath, 'utf8')); }
  catch (e) {
    console.log(`::warning::test-plan: could not read GITHUB_EVENT_PATH: ${e && e.message || e}`);
  }

  const pr = ev.pull_request || {};
  const baseRepo = (pr.base && pr.base.repo) || ev.repository || {};
  const headRepo = (pr.head && pr.head.repo) || {};
  const repoFullName = baseRepo.full_name || (process.env.GITHUB_REPOSITORY || '/');
  const [ownerFallback, repoFallback] = repoFullName.split('/');

  const isFork = headRepo.full_name && baseRepo.full_name
    ? headRepo.full_name !== baseRepo.full_name
    : (headRepo.fork === true);

  const meta = {
    owner: (baseRepo.owner && baseRepo.owner.login) || ownerFallback || '',
    repo: baseRepo.name || repoFallback || '',
    number: pr.number || ev.number || 0,
    head_ref: (pr.head && pr.head.ref) || '',
    head_sha: (pr.head && pr.head.sha) || '',
    head_repo_fork: !!isFork,
    body: pr.body || '',
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(meta, null, 2));
  console.log(`pr-meta: ${meta.owner}/${meta.repo}#${meta.number} head=${meta.head_ref} fork=${meta.head_repo_fork}`);
}

main();
