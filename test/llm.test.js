'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chat } = require('../scripts/lib/llm');
const { parseAnalysis } = require('../scripts/lib/schema');
const valid = {summary: 'Example', verdict: 'fail', confidence: 0.8, needs_visual_review: false,
  failures: [{ test: 'button', likely_cause: 'disabled', suggested_fix: 'enable it' }]};

test('analysis schema rejects valid JSON with missing or invalid fields', () => {
  assert.deepEqual(parseAnalysis(JSON.stringify(valid)), valid);
  for (const obj of [null, [], {}, {...valid, confidence: '0.9'}, {...valid, confidence: 2},
    {...valid, verdict: 'success'}, {...valid, failures: [{}]}, {...valid, needs_visual_review: 'false'}]) {
    assert.equal(parseAnalysis(JSON.stringify(obj)), null);
  }
  assert.equal(parseAnalysis('```json\n' + JSON.stringify(valid) + '\n```'), null);
});

test('LLM deadline aborts a stalled response body', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'application/json'}); res.write('{'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(chat({baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic', model: 'mock', messages: [], timeoutMs: 50}), /abort|timeout/i);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('HTTP errors do not include provider response bodies', async () => {
  const server = http.createServer((req, res) => { res.writeHead(401); res.end('SENSITIVE-SENTINEL'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(chat({baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic', model: 'mock', messages: []}), e => e.message === 'LLM HTTP 401');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
