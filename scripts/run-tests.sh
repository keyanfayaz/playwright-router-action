#!/usr/bin/env bash
# Runs the user-provided Playwright command, captures combined stdout/stderr to
# a log file, and records the exit code without failing the step. The outer
# action fails at the very end so AI analysis can still run.
set -u
set -o pipefail

OUT_DIR=".playwright-ai-router"
LOG="$OUT_DIR/test-output.log"

if [ -z "${TEST_COMMAND:-}" ]; then
  echo "TEST_COMMAND is empty" >&2
  exit 2
fi

echo "::group::Playwright (${TEST_COMMAND})"
set +e
# shellcheck disable=SC2086
bash -c "${TEST_COMMAND}" 2>&1 | tee "$LOG"
EXIT_CODE=${PIPESTATUS[0]}
set -e
echo "::endgroup::"

printf '%s' "$EXIT_CODE" > "$OUT_DIR/exit-code"
echo "Playwright exit code captured: $EXIT_CODE"

exit 0
