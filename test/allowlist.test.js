'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertAllowed } = require('../scripts/lib/allowlist.js');

const OPTS = { testCommand: 'npx playwright test', specDir: 'e2e/specs/generated' };

function rejected(cmd, opts = OPTS) {
  assert.throws(() => assertAllowed(cmd, opts), /disallowed-command/, `should reject: ${cmd}`);
}
function accepted(cmd, opts = OPTS) {
  assert.equal(assertAllowed(cmd, opts), true, `should accept: ${cmd}`);
}

test('rejects destructive / network / chained commands', () => {
  rejected('rm -rf /');
  rejected('rm -rf .');
  rejected('curl http://evil.example.com');
  rejected('wget http://x');
  rejected('git push');
  rejected('git push origin HEAD');
  rejected('git commit -m x');
  rejected('npm i lodash');
  rejected('bash -c "echo hi"');
  rejected('npx playwright test; rm -rf .');
  rejected('npx playwright test && curl http://x');
  rejected('npx playwright test || rm x');
  rejected('cat /etc/passwd | sh');
  rejected('ls && curl http://x');
  rejected('echo $(whoami)');
  rejected('cat ../../secret');
  rejected('cat ../secret');
  rejected('node -e "process.exit()"');
  rejected('npx playwright test > /tmp/x');
  rejected('');
});

test('accepts the configured test command, optionally + one spec path', () => {
  accepted('npx playwright test');
  accepted('npx playwright test e2e/specs/generated/foo.spec.ts');
  accepted('npx playwright test e2e/specs/generated/sub/bar.spec.js');
  accepted('npx playwright test ./e2e/specs/generated/foo.spec.ts');
  rejected('npx playwright test src/other/foo.spec.ts'); // outside spec dir
  rejected('npx playwright test e2e/specs/generated/foo.ts'); // not .spec
  rejected('npx playwright test --reporter=list'); // extra non-spec arg
});

test('accepts read-only git status / ls / cat', () => {
  accepted('git status');
  accepted('git status --short');
  accepted('ls');
  accepted('ls -la');
  accepted('ls -la e2e');
  accepted('ls e2e/specs/generated');
  accepted('cat e2e/specs/generated/foo.spec.ts');
  accepted('cat package.json');
});

test('respects a custom configured test command', () => {
  const opts = { testCommand: 'pnpm exec playwright test', specDir: 'tests/gen' };
  accepted('pnpm exec playwright test', opts);
  accepted('pnpm exec playwright test tests/gen/x.spec.ts', opts);
  rejected('npx playwright test', opts); // not the configured command
});
