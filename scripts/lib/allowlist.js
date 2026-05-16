/*
 * Command allowlist for model-driven shell execution in the test-plan agent
 * loop. The model proposes shell strings; only a tiny, anchored set is ever
 * executed by trusted code. Everything else throws so the loop can surface the
 * rejection back to the model instead of running it.
 *
 * Allowed:
 *   - the configured single test command, optionally followed by ONE spec path
 *     inside the spec dir (…/x.spec.ts | …/x.spec.js)
 *   - `git status` / `git status --short`
 *   - `ls` / `ls -<flags>` / `ls <path>`
 *   - `cat <path>`            (no `..`)
 *
 * Hard-rejected: any shell metacharacter that enables chaining, piping,
 * redirection, command substitution, or backgrounding — so `rm`, `curl`,
 * `git push`, `npm i`, `bash -c`, `a && b`, `a; b`, `a | b` never run.
 */

// Chaining / piping / redirection / substitution / backgrounding / newlines.
const META_RE = /[;&|`<>\n\r]|\$\(|\$\{/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} cmd
 * @param {{ testCommand: string, specDir: string }} opts
 * @returns {true} when allowed
 * @throws {Error} with a `disallowed`-prefixed message when rejected
 */
function assertAllowed(cmd, opts = {}) {
  const testCommand = (opts.testCommand || 'npx playwright test').trim();
  const specDir = (opts.specDir || 'e2e/specs/generated').replace(/\/+$/, '');
  const raw = String(cmd == null ? '' : cmd);
  const c = raw.trim();

  if (!c) throw new Error('disallowed-command: empty command');
  if (META_RE.test(raw)) {
    throw new Error(`disallowed-command: shell metacharacters not permitted: ${c}`);
  }
  if (c.includes('..')) {
    throw new Error(`disallowed-command: parent-directory traversal not permitted: ${c}`);
  }

  // git status (read-only).
  if (/^git status(?: --short)?$/.test(c)) return true;

  // ls with optional single flag group and/or single path.
  if (/^ls(?: -[a-zA-Z]+)?(?: [\w./-]+)?$/.test(c)) return true;

  // cat a single path (no `..`, already rejected above).
  if (/^cat [\w./-]+$/.test(c)) return true;

  // The configured single test command, optionally + ONE spec path.
  const esc = escapeRegExp(testCommand);
  const m = c.match(new RegExp('^' + esc + '(?:\\s+(\\S+))?$'));
  if (m) {
    const arg = m[1];
    if (!arg) return true;
    if (!/^[\w./-]+\.spec\.(?:ts|js)$/.test(arg)) {
      throw new Error(`disallowed-command: argument is not a .spec.ts/.spec.js path: ${c}`);
    }
    const norm = arg.replace(/^\.\//, '');
    if (!norm.startsWith(specDir + '/')) {
      throw new Error(`disallowed-command: spec path must be inside ${specDir}/: ${c}`);
    }
    return true;
  }

  throw new Error(`disallowed-command: not in allowlist: ${c}`);
}

module.exports = { assertAllowed };
