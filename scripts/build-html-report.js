#!/usr/bin/env node
/*
 * Renders playwright-ai-router-report.html — a self-contained, visually styled
 * report of the current run. Tolerant of any combination of input artifacts
 * (evidence.json, ai-response.json, test-plan-result.json, pr-meta.json) and
 * works for failure-analysis, review, and test-plan modes.
 *
 * Sets the `report-path` step output.
 */
const fs = require('fs');
const path = require('path');
const { setOutput } = require('./lib/llm.js');

const OUT_DIR = process.env.OUT_DIR || '.playwright-ai-router';
const REPORT_PATH = 'playwright-ai-router-report.html';
const SERVER = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');

const MAX_INLINE_BYTES_PER_IMAGE = 500 * 1024;
const MAX_INLINE_BYTES_TOTAL = 5 * 1024 * 1024;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Minimal markdown -> HTML. Handles fenced code, headings, lists, inline code,
// bold, italic, paragraphs. Enough for the AI `summary` field.
function mdToHtml(src) {
  if (!src) return '';
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inUl = false;
  const closeUl = () => { if (inUl) { out.push('</ul>'); inUl = false; } };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      closeUl();
      const lang = fence[1] || '';
      i++;
      const buf = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++;
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeUl();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      i++;
      continue;
    }
    if (line.trim() === '') {
      closeUl();
      i++;
      continue;
    }
    // Paragraph: gather contiguous non-empty lines.
    closeUl();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^[-*]\s/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  closeUl();
  return out.join('\n');
}

function inline(s) {
  // Escape first, then re-introduce simple inline patterns on the escaped text.
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, (_, p, c) => `${p}<em>${c}</em>`);
  return t;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
}

function pickImageMime(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

function makeImageEmbedder(meta) {
  let inlinedBytes = 0;
  return (relPath) => {
    if (!relPath) return null;
    const abs = path.isAbsolute(relPath) ? relPath : path.resolve(process.cwd(), relPath);
    let stat = null;
    try { stat = fs.statSync(abs); } catch {}
    if (stat && stat.size <= MAX_INLINE_BYTES_PER_IMAGE && inlinedBytes + stat.size <= MAX_INLINE_BYTES_TOTAL) {
      try {
        const buf = fs.readFileSync(abs);
        inlinedBytes += buf.length;
        return `data:${pickImageMime(abs)};base64,${buf.toString('base64')}`;
      } catch {}
    }
    if (meta && meta.owner && meta.repo && meta.head_ref) {
      const clean = String(relPath).replace(/^\.\//, '');
      return `${SERVER}/${meta.owner}/${meta.repo}/raw/${meta.head_ref}/${clean}`;
    }
    return null;
  };
}

function verdictFor(evidence, ai) {
  const passed = !!(evidence && evidence.passed);
  const aiFail = ai && ai.called && ai.parsed && ai.parsed.verdict === 'fail';
  if (passed && !aiFail) return { status: 'success', label: 'Passed' };
  if (!passed) return { status: 'failure', label: 'Failed' };
  return { status: 'ai-flagged', label: 'AI-flagged' };
}

function renderHeader({ mode, verdict, appUrl, generatedAt }) {
  return `
<header class="hdr" data-status="${esc(verdict.status)}">
  <div class="hdr-left">
    <div class="logo" aria-hidden="true">🎭</div>
    <div>
      <h1>Playwright AI Router</h1>
      <div class="sub">
        <span class="badge badge-mode">mode: ${esc(mode)}</span>
        ${appUrl ? `<span class="badge badge-url">${esc(appUrl)}</span>` : ''}
        <span class="muted">${esc(generatedAt)}</span>
      </div>
    </div>
  </div>
  <div class="verdict pill pill-${esc(verdict.status)}" data-verdict="${esc(verdict.status)}">${esc(verdict.label)}</div>
</header>`;
}

function renderStatsNonPlan(evidence, ai) {
  const counts = (evidence && evidence.artifact_counts) || {};
  const failed = (evidence && evidence.failed_tests && evidence.failed_tests.length) || 0;
  const passed = !!(evidence && evidence.passed);
  const stats = [
    { label: 'Status', value: passed ? 'Pass' : 'Fail', tone: passed ? 'good' : 'bad' },
    { label: 'Exit code', value: String(evidence && evidence.exit_code != null ? evidence.exit_code : '–') },
    { label: 'Failed tests', value: String(failed), tone: failed ? 'bad' : 'good' },
    { label: 'Screenshots', value: String(counts.screenshots || 0) },
    { label: 'Traces', value: String(counts.traces || 0) },
    { label: 'AI model', value: (ai && ai.model_used) || '—' },
  ];
  return statsGrid(stats);
}

function renderStatsTestPlan(result) {
  const t = (result && result.totals) || { total: 0, automated: 0, failed: 0, skipped: 0 };
  const stats = [
    { label: 'Total items', value: String(t.total || 0) },
    { label: 'Automated', value: String(t.automated || 0), tone: 'good' },
    { label: 'Failed', value: String(t.failed || 0), tone: t.failed ? 'bad' : '' },
    { label: 'Skipped', value: String(t.skipped || 0), tone: 'muted' },
    { label: 'Commit', value: result && result.commit_sha ? String(result.commit_sha).slice(0, 7) : '—' },
    { label: 'Fork PR', value: result && result.fork ? 'yes' : 'no' },
  ];
  return statsGrid(stats);
}

function statsGrid(stats) {
  return `
<section class="stats">
  ${stats.map((s) => `
    <div class="stat stat-${esc(s.tone || '')}">
      <div class="stat-label">${esc(s.label)}</div>
      <div class="stat-value">${esc(s.value)}</div>
    </div>`).join('')}
</section>`;
}

function renderAi(ai) {
  if (!ai || !ai.called) {
    return `<section class="card"><h2>AI</h2><p class="muted">No AI call was made${ai && ai.reason ? ` (${esc(ai.reason)})` : ''}.</p></section>`;
  }
  const p = ai.parsed;
  const conf = p && typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : null;
  const verdict = p && p.verdict ? String(p.verdict) : 'unknown';
  const failures = (p && Array.isArray(p.failures)) ? p.failures : [];
  return `
<section class="card ai" data-ai-verdict="${esc(verdict)}">
  <div class="card-head">
    <h2>AI analysis</h2>
    <span class="pill pill-${esc(verdict === 'pass' ? 'success' : verdict === 'fail' ? 'failure' : 'ai-flagged')}">${esc(verdict)}</span>
  </div>
  <div class="ai-meta">
    <span class="badge">model: <code>${esc(ai.model_used || 'unknown')}</code></span>
    ${ai.escalated ? `<span class="badge badge-warn">escalated${ai.escalation_reason ? `: ${esc(ai.escalation_reason)}` : ''}</span>` : ''}
    ${p && p.needs_visual_review ? '<span class="badge badge-warn">needs visual review</span>' : ''}
  </div>
  ${conf != null ? `
    <div class="confidence" title="confidence ${Math.round(conf * 100)}%">
      <div class="confidence-track"><div class="confidence-fill" style="width:${Math.round(conf * 100)}%"></div></div>
      <div class="confidence-label">${Math.round(conf * 100)}% confidence</div>
    </div>` : ''}
  ${p && p.summary ? `<div class="ai-summary md">${mdToHtml(p.summary)}</div>` : ''}
  ${failures.length ? `
    <h3>Failures</h3>
    <ul class="failure-list">
      ${failures.map((f) => `
        <li class="failure">
          <div class="failure-title">${esc(f.test || '(unnamed)')}</div>
          ${f.likely_cause ? `<div><strong>Likely cause:</strong> ${esc(f.likely_cause)}</div>` : ''}
          ${f.suggested_fix ? `<div><strong>Suggested fix:</strong> ${esc(f.suggested_fix)}</div>` : ''}
        </li>`).join('')}
    </ul>` : ''}
  ${!p ? `<p class="muted">AI response could not be parsed as JSON.</p>` : ''}
</section>`;
}

function renderFailedTests(evidence) {
  const failed = (evidence && evidence.failed_tests) || [];
  if (!failed.length) return '';
  return `
<section class="card">
  <h2>Parsed failed tests <span class="count">${failed.length}</span></h2>
  <ul class="failed-tests">
    ${failed.map((t) => `<li><code>${esc(t)}</code></li>`).join('')}
  </ul>
</section>`;
}

function renderLogTail(evidence) {
  const tail = evidence && evidence.log_tail;
  if (!tail) return '';
  return `
<section class="card">
  <details>
    <summary>Test output (last ${tail.length.toLocaleString()} chars)</summary>
    <pre class="log">${esc(tail)}</pre>
  </details>
</section>`;
}

function renderTestPlanItems(result, embedImage, meta) {
  if (!result || !Array.isArray(result.items) || !result.items.length) return '';
  const groups = [
    { key: 'automated', label: 'Automated', icon: '✅', tone: 'good' },
    { key: 'failed', label: 'Failed', icon: '❌', tone: 'bad' },
    { key: 'skipped', label: 'Skipped', icon: '⏭️', tone: 'muted' },
  ];
  return groups.map((g) => {
    const items = result.items.filter((i) => i.status === g.key);
    if (!items.length) return '';
    return `
<section class="card group group-${esc(g.tone)}" data-group="${esc(g.key)}">
  <div class="card-head">
    <h2>${g.icon} ${esc(g.label)} <span class="count">${items.length}</span></h2>
  </div>
  <div class="items">
    ${items.map((it) => renderItem(it, g.key, embedImage, meta, result)).join('')}
  </div>
</section>`;
  }).join('');
}

function renderItem(it, status, embedImage, meta, result) {
  const shots = Array.isArray(it.screenshots) ? it.screenshots : [];
  const specLink = (() => {
    if (!it.spec_path) return '';
    if (meta && meta.owner && meta.repo && (result.commit_sha || meta.head_ref)) {
      const ref = result.commit_sha || meta.head_ref;
      return `<a class="spec-link" href="${SERVER}/${esc(meta.owner)}/${esc(meta.repo)}/blob/${esc(ref)}/${esc(it.spec_path)}" target="_blank" rel="noopener">${esc(it.spec_path)}</a>`;
    }
    return `<code>${esc(it.spec_path)}</code>`;
  })();
  return `
<article class="item" data-status="${esc(status)}">
  <div class="item-head">
    <h3>${esc(it.title || '(untitled)')}</h3>
    <div class="item-meta">
      ${it.iterations != null ? `<span class="badge">iters: ${esc(it.iterations)}</span>` : ''}
      ${shots.length ? `<span class="badge">📷 ${shots.length}</span>` : ''}
    </div>
  </div>
  ${specLink ? `<div class="item-spec">${specLink}</div>` : ''}
  ${shots.length ? `
    <div class="gallery">
      ${shots.map((s) => {
        const src = embedImage(s);
        if (!src) return '';
        return `<a class="thumb" href="${esc(src)}" target="_blank" rel="noopener"><img loading="lazy" alt="${esc(path.basename(s))}" src="${esc(src)}"></a>`;
      }).join('')}
    </div>` : ''}
  ${it.last_failure_excerpt ? `
    <details class="excerpt">
      <summary>last failure</summary>
      <pre class="log">${esc(it.last_failure_excerpt)}</pre>
    </details>` : ''}
  ${it.skip_reason ? `<div class="skip-reason muted">${esc(it.skip_reason)}</div>` : ''}
</article>`;
}

function renderFooter(meta) {
  if (!meta || !meta.owner) return '';
  const repoUrl = `${SERVER}/${meta.owner}/${meta.repo}`;
  const prUrl = meta.number ? `${repoUrl}/pull/${meta.number}` : '';
  return `
<footer>
  <a href="${esc(repoUrl)}" target="_blank" rel="noopener">${esc(meta.owner)}/${esc(meta.repo)}</a>
  ${prUrl ? `· <a href="${esc(prUrl)}" target="_blank" rel="noopener">PR #${esc(meta.number)}</a>` : ''}
  ${meta.head_ref ? `· branch <code>${esc(meta.head_ref)}</code>` : ''}
</footer>`;
}

const CSS = `
:root {
  --bg: #f7f7fb;
  --fg: #1a1a23;
  --muted: #6b7280;
  --card: #ffffff;
  --border: #e5e7eb;
  --accent: #6366f1;
  --good: #10b981;
  --good-bg: #ecfdf5;
  --bad: #ef4444;
  --bad-bg: #fef2f2;
  --warn: #f59e0b;
  --warn-bg: #fffbeb;
  --code-bg: #f3f4f6;
  --shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --fg: #e5e7eb;
    --muted: #9ca3af;
    --card: #161922;
    --border: #262a35;
    --accent: #818cf8;
    --good: #34d399;
    --good-bg: #064e3b33;
    --bad: #f87171;
    --bad-bg: #7f1d1d33;
    --warn: #fbbf24;
    --warn-bg: #78350f33;
    --code-bg: #1f2230;
    --shadow: 0 1px 2px rgba(0,0,0,0.4), 0 6px 18px rgba(0,0,0,0.35);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 20px 64px; }
h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
h2 { margin: 0 0 12px; font-size: 17px; font-weight: 650; letter-spacing: -0.005em; }
h3 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.muted { color: var(--muted); }
code { background: var(--code-bg); padding: 1px 6px; border-radius: 4px; font-size: 0.9em;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
pre { background: var(--code-bg); padding: 12px 14px; border-radius: 8px; overflow: auto;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.5; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.hdr { display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 20px 22px; background: var(--card); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: var(--shadow); margin-bottom: 18px; }
.hdr-left { display: flex; align-items: center; gap: 14px; min-width: 0; }
.logo { width: 38px; height: 38px; border-radius: 10px; background: linear-gradient(135deg, #8b5cf6, #ec4899);
  display: grid; place-items: center; font-size: 22px; }
.sub { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
  background: var(--code-bg); color: var(--fg); font-size: 12px; border: 1px solid var(--border); }
.badge-warn { background: var(--warn-bg); border-color: var(--warn); color: var(--warn); }
.pill { display: inline-flex; align-items: center; padding: 6px 14px; border-radius: 999px;
  font-weight: 600; font-size: 13px; border: 1px solid transparent; white-space: nowrap; }
.pill-success { background: var(--good-bg); color: var(--good); border-color: var(--good); }
.pill-failure { background: var(--bad-bg); color: var(--bad); border-color: var(--bad); }
.pill-ai-flagged { background: var(--warn-bg); color: var(--warn); border-color: var(--warn); }
.verdict { font-size: 14px; padding: 8px 18px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px; margin-bottom: 18px; }
.stat { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
  padding: 14px 16px; box-shadow: var(--shadow); }
.stat-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.stat-value { font-size: 22px; font-weight: 600; margin-top: 4px; letter-spacing: -0.01em; }
.stat-good .stat-value { color: var(--good); }
.stat-bad .stat-value { color: var(--bad); }
.stat-muted .stat-value { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
  padding: 18px 20px; box-shadow: var(--shadow); margin-bottom: 16px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.count { display: inline-block; min-width: 22px; padding: 0 8px; margin-left: 6px;
  border-radius: 999px; background: var(--code-bg); color: var(--muted); font-size: 12px; }
.ai-meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }
.confidence { display: flex; align-items: center; gap: 10px; margin: 10px 0 14px; }
.confidence-track { flex: 1; height: 8px; background: var(--code-bg); border-radius: 999px; overflow: hidden; }
.confidence-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--good));
  border-radius: 999px; transition: width 0.4s ease; }
.confidence-label { font-size: 12px; color: var(--muted); white-space: nowrap; }
.ai-summary { margin-bottom: 10px; }
.md p { margin: 0 0 8px; }
.md ul { margin: 0 0 8px 20px; padding: 0; }
.failure-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.failure { background: var(--bad-bg); border: 1px solid var(--bad); border-radius: 10px;
  padding: 12px 14px; }
.failure-title { font-weight: 600; margin-bottom: 4px; }
.failed-tests { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.failed-tests li { padding: 6px 10px; background: var(--code-bg); border-radius: 6px; }
.group .items { display: grid; gap: 12px; margin-top: 4px; }
.item { background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 16px; }
.item[data-status="automated"] { border-left: 3px solid var(--good); }
.item[data-status="failed"] { border-left: 3px solid var(--bad); }
.item[data-status="skipped"] { border-left: 3px solid var(--muted); }
.item-head { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-bottom: 6px; flex-wrap: wrap; }
.item-meta { display: flex; gap: 6px; flex-wrap: wrap; }
.item-spec { margin: 4px 0 10px; font-size: 13px; }
.spec-link { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px; margin-top: 10px; }
.thumb { display: block; border-radius: 8px; overflow: hidden; border: 1px solid var(--border);
  background: var(--code-bg); }
.thumb img { display: block; width: 100%; height: 120px; object-fit: cover; transition: transform 0.2s; }
.thumb:hover img { transform: scale(1.03); }
.excerpt { margin-top: 10px; }
.excerpt summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.skip-reason { font-size: 13px; margin-top: 6px; font-style: italic; }
.log { max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border);
  color: var(--muted); font-size: 13px; }
details summary { cursor: pointer; }
details[open] summary { margin-bottom: 8px; }
`;

function main() {
  const evidence = readJson(path.join(OUT_DIR, 'evidence.json'));
  const ai = readJson(path.join(OUT_DIR, 'ai-response.json'));
  const testPlan = readJson(path.join(OUT_DIR, 'test-plan-result.json'));
  const meta = readJson(path.join(OUT_DIR, 'pr-meta.json'));

  const mode = process.env.MODE || (testPlan ? 'test-plan' : (evidence && evidence.mode) || 'failure-analysis');
  const appUrl = process.env.APP_URL || (evidence && evidence.app_url) || '';
  const generatedAt = new Date().toISOString().replace('T', ' ').replace(/\..+/, ' UTC');

  const isTestPlan = mode === 'test-plan' || (!evidence && !!testPlan);
  const verdict = isTestPlan
    ? (testPlan && testPlan.totals && testPlan.totals.failed
        ? { status: 'failure', label: `${testPlan.totals.failed} failed` }
        : { status: 'success', label: 'Done' })
    : verdictFor(evidence, ai);

  const embedImage = makeImageEmbedder(meta);

  const parts = [];
  parts.push('<!doctype html>');
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  parts.push(`<title>Playwright AI Router report — ${esc(mode)}</title>`);
  parts.push(`<style>${CSS}</style>`);
  parts.push('</head><body><main>');
  parts.push(renderHeader({ mode, verdict, appUrl, generatedAt }));

  if (isTestPlan) {
    parts.push(renderStatsTestPlan(testPlan || {}));
    if (testPlan && testPlan.fork) {
      parts.push(`<section class="card"><p class="muted">PR head is a fork; spec generation was skipped (no secret/token access).</p></section>`);
    }
    parts.push(renderTestPlanItems(testPlan || { items: [] }, embedImage, meta));
    if (testPlan && testPlan.branch_moved) {
      parts.push(`<section class="card"><p class="muted">⚠️ The head branch moved during the run; the next push will retry.</p></section>`);
    }
  } else {
    parts.push(renderStatsNonPlan(evidence || {}, ai || {}));
    parts.push(renderAi(ai || {}));
    parts.push(renderFailedTests(evidence || {}));
    parts.push(renderLogTail(evidence || {}));
  }

  parts.push(renderFooter(meta));
  parts.push('</main></body></html>');

  fs.writeFileSync(REPORT_PATH, parts.join('\n'));
  setOutput('report-path', REPORT_PATH);
  console.log(`html report written: ${REPORT_PATH} mode=${mode} verdict=${verdict.status}`);
}

main();
