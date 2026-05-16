#!/usr/bin/env node
/*
 * Parses a pull-request body, finds the `## Test plan` section, and extracts
 * every UNCHECKED list item as a candidate to automate.
 *
 * Selection rule (intentionally NOT gated on a `Manual:` prefix — relying on
 * authors/agents to add a marker silently loses coverage):
 *   - every unchecked `- [ ]` / `* [ ]` item under the Test plan is a candidate
 *   - a leading `Manual:` (case-insensitive, plain prefix) is a strong
 *     "definitely automate" hint that BYPASSES skip-patterns
 *   - items matching a skip-pattern (and without the Manual hint) are emitted
 *     with skip:true so the caller reports them as skipped, not attempted
 *
 * Pure function `parseTestPlan(body, { skipPatterns })` is unit-tested.
 * The CLI wrapper reads PR_META_PATH (JSON {body}) and writes
 * OUT_DIR/test-plan-items.json.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
// Indent-tolerant GitHub task-list item: optional leading whitespace, - or *,
// a [ ] / [x] / [X] checkbox, then the item text.
const ITEM_RE = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/;
const MANUAL_RE = /^Manual:\s*/i;

function normalizeTitle(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function itemId(title) {
  return crypto.createHash('sha1').update(normalizeTitle(title)).digest('hex').slice(0, 12);
}

function splitSkipPatterns(raw) {
  // Comma-split. Do NOT trim individual patterns: defaults like "ask " carry a
  // deliberate trailing space so "ask " does not match "task". Drop empties.
  if (!raw) return [];
  return String(raw).split(',').filter((p) => p.length > 0);
}

/**
 * @param {string} body  raw PR body markdown
 * @param {{ skipPatterns?: string[] }} [opts]
 * @returns {{ section_found: boolean, items: Array }}
 */
function parseTestPlan(body, opts = {}) {
  const skipPatterns = (opts.skipPatterns || []).map((p) => p.toLowerCase());
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');

  let sectionLevel = -1; // -1 => not yet inside the Test plan section
  let sectionFound = false;
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(HEADING_RE);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      if (sectionLevel === -1) {
        // Looking for the Test plan heading itself.
        if (/^test\s+plan\b/i.test(text)) {
          sectionLevel = level;
          sectionFound = true;
        }
        continue;
      }
      // Inside the section: a heading of equal/higher level ends it.
      if (level <= sectionLevel) {
        sectionLevel = -1;
      }
      continue;
    }

    if (sectionLevel === -1) continue;

    const m = line.match(ITEM_RE);
    if (!m) continue;
    const checked = m[2] === 'x' || m[2] === 'X';
    if (checked) continue; // ignore already-checked items

    const rawText = m[3].trim();
    const manualHint = MANUAL_RE.test(rawText);
    const title = manualHint ? rawText.replace(MANUAL_RE, '').trim() : rawText;
    if (!title) continue;

    const lowerTitle = title.toLowerCase();
    let skip = false;
    let skipReason = '';
    if (!manualHint) {
      const hit = skipPatterns.find((p) => lowerTitle.includes(p));
      if (hit) {
        skip = true;
        skipReason = 'skip-pattern';
      }
    }

    items.push({
      id: itemId(title),
      title,
      raw_line: line.replace(/\s+$/, ''),
      line_index: i,
      manual_hint: manualHint,
      skip,
      skip_reason: skipReason,
    });
  }

  return { section_found: sectionFound, items };
}

module.exports = { parseTestPlan, normalizeTitle, itemId, splitSkipPatterns };

if (require.main === module) {
  const OUT_DIR = process.env.OUT_DIR || '.playwright-ai-router';
  const metaPath = process.env.PR_META_PATH || path.join(OUT_DIR, 'pr-meta.json');
  let body = '';
  try {
    body = JSON.parse(fs.readFileSync(metaPath, 'utf8')).body || '';
  } catch (e) {
    console.log(`::warning::test-plan: could not read PR metadata at ${metaPath}: ${e && e.message || e}`);
  }
  const skipPatterns = splitSkipPatterns(process.env.SKIP_PATTERNS);
  const result = parseTestPlan(body, { skipPatterns });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'test-plan-items.json'), JSON.stringify(result, null, 2));
  const attemptable = result.items.filter((it) => !it.skip).length;
  console.log(`test-plan: section_found=${result.section_found} items=${result.items.length} attemptable=${attemptable} skipped=${result.items.length - attemptable}`);
}
