'use strict';
// Parse only the promised response shape, not arbitrary JSON or prose wrappers.
function parseAnalysis(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.summary !== 'string' || value.summary.length > 1500 ||
      !['pass', 'fail', 'ambiguous'].includes(value.verdict) ||
      !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
      typeof value.needs_visual_review !== 'boolean' || !Array.isArray(value.failures) || value.failures.length > 25) return null;
  if (!value.failures.every(f => f && ['test', 'likely_cause', 'suggested_fix'].every(k => typeof f[k] === 'string' && f[k].length <= 4000))) return null;
  return { summary: value.summary, verdict: value.verdict, confidence: value.confidence,
    needs_visual_review: value.needs_visual_review,
    failures: value.failures.map(({test, likely_cause, suggested_fix}) => ({test, likely_cause, suggested_fix})) };
}
module.exports = { parseAnalysis };
