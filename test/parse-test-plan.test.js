'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTestPlan, normalizeTitle, itemId, splitSkipPatterns } = require('../scripts/parse-test-plan.js');

test('extracts only unchecked items, regardless of Manual prefix', () => {
  const body = [
    '## Test plan',
    '',
    '- [ ] confirm the home page returns 200',
    '- [x] this one is already done',
    '- [ ] Manual: verify the checkout flow',
    '- [X] Manual: done manual item',
  ].join('\n');
  const { section_found, items } = parseTestPlan(body);
  assert.equal(section_found, true);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.title), [
    'confirm the home page returns 200',
    'verify the checkout flow',
  ]);
});

test('Manual: prefix sets manual_hint and is stripped (case-insensitive)', () => {
  const body = [
    '## Test plan',
    '- [ ] MANUAL: alpha',
    '- [ ] manual: beta',
    '- [ ] Manual:gamma',
    '- [ ] plain delta',
  ].join('\n');
  const { items } = parseTestPlan(body);
  assert.deepEqual(items.map((i) => [i.title, i.manual_hint]), [
    ['alpha', true],
    ['beta', true],
    ['gamma', true],
    ['plain delta', false],
  ]);
});

test('non-Manual unchecked items are still kept (no marker required)', () => {
  const { items } = parseTestPlan('## Test plan\n- [ ] just a plain item');
  assert.equal(items.length, 1);
  assert.equal(items[0].manual_hint, false);
  assert.equal(items[0].skip, false);
});

test('skip-patterns flag skip:true with reason', () => {
  const body = '## Test plan\n- [ ] ask the PM to review the design';
  const { items } = parseTestPlan(body, { skipPatterns: ['design review', 'ask '] });
  assert.equal(items.length, 1);
  assert.equal(items[0].skip, true);
  assert.equal(items[0].skip_reason, 'skip-pattern');
});

test('Manual hint bypasses a matching skip-pattern', () => {
  const body = '## Test plan\n- [ ] Manual: ask the user to confirm the modal';
  const { items } = parseTestPlan(body, { skipPatterns: ['ask '] });
  assert.equal(items.length, 1);
  assert.equal(items[0].manual_hint, true);
  assert.equal(items[0].skip, false, 'Manual hint must override skip-pattern');
});

test('no Test plan section => section_found false, no items', () => {
  const body = '## Summary\n- [ ] not in a test plan section\n## Other\n- [ ] nope';
  const r = parseTestPlan(body);
  assert.equal(r.section_found, false);
  assert.equal(r.items.length, 0);
});

test('section ends at next heading of equal/higher level', () => {
  const body = [
    '## Test plan',
    '- [ ] inside one',
    '### Sub heading still inside',
    '- [ ] inside two',
    '## Rollout',
    '- [ ] outside the section',
  ].join('\n');
  const { items } = parseTestPlan(body);
  assert.deepEqual(items.map((i) => i.title), ['inside one', 'inside two']);
});

test('case-insensitive heading and nested/indented items', () => {
  const body = [
    '# Description',
    'blah',
    '## test PLAN',
    '  - [ ] indented child item',
    '    * [ ] deeper star item',
  ].join('\n');
  const { section_found, items } = parseTestPlan(body);
  assert.equal(section_found, true);
  assert.deepEqual(items.map((i) => i.title), ['indented child item', 'deeper star item']);
});

test('id is stable across whitespace/case differences', () => {
  assert.equal(itemId('Confirm the   Home Page'), itemId('confirm the home page'));
  assert.equal(normalizeTitle('  A  B '), 'a b');
});

test('splitSkipPatterns preserves deliberate trailing spaces, drops empties', () => {
  assert.deepEqual(splitSkipPatterns('ask ,PM ,design review,manually verify with'), [
    'ask ', 'PM ', 'design review', 'manually verify with',
  ]);
  assert.deepEqual(splitSkipPatterns(''), []);
  assert.deepEqual(splitSkipPatterns('a,,b'), ['a', 'b']);
});

test('CRLF bodies are handled', () => {
  const body = '## Test plan\r\n- [ ] crlf item\r\n- [x] done\r\n';
  const { items } = parseTestPlan(body);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'crlf item');
});
