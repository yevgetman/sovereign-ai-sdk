#!/bin/bash
#
# Phase 16.1 M11 — Default-flip smoke runner.
#
# Exercises the boot-decision path end-to-end against the working-tree
# code (via `bun src/main.ts`). Captures stdout/stderr per scenario to
# the close-out directory. Designed to run from the repo root.
#
# Cost: $0 — no real-Anthropic API calls. The dispatcher-command
# verification happens via the separate gated test:
#   ANTHROPIC_API_KEY=... SOV_M11_REAL_SMOKE=1 \
#     bun test tests/parity/m11RealAnthropicSmoke.test.ts
# (added by M11 close-out.)

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$REPO_ROOT/docs/07-history/state/2026-05-17-m11-smoke"
TMP_HOME="$(mktemp -d -t sov-m11-smoke-home-XXXXXX)"
TMP_BUNDLE="$(mktemp -d -t sov-m11-smoke-bundle-XXXXXX)"
TIMEOUT_SECS=6

# Use gtimeout if installed (Homebrew coreutils), fall back to a perl
# wrapper otherwise. macOS BSD doesn't ship GNU timeout by default.
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout $TIMEOUT_SECS"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout $TIMEOUT_SECS"
else
  TIMEOUT_CMD="perl -e 'alarm shift; exec @ARGV' $TIMEOUT_SECS"
fi

# Build a minimal harness bundle so sov has somewhere to point.
cat > "$TMP_BUNDLE/index.yaml" <<EOF
name: m11-smoke-bundle
version: 0.1.0
EOF
mkdir -p "$TMP_BUNDLE/business"
echo "# smoke" > "$TMP_BUNDLE/business/README.md"

cd "$REPO_ROOT"

# Cleanup on exit.
cleanup() {
  rm -rf "$TMP_HOME" "$TMP_BUNDLE"
}
trap cleanup EXIT

# Helper: run sov with given env/args, capture stdout + stderr, write
# both to a transcript file. Closes stdin immediately so any
# interactive surface bails out fast. The timeout ensures TUI mode
# (which would otherwise spin a server) is bounded.
run_scenario() {
  local name="$1"
  shift
  local env_pairs="$1"
  shift
  local args="$*"

  local outfile="$OUT/$name.transcript.txt"
  {
    echo "=== M11 smoke scenario: $name ==="
    echo "env: $env_pairs"
    echo "args: bun src/main.ts $args"
    echo "HARNESS_HOME=$TMP_HOME"
    echo "--- stdout + stderr ---"
  } > "$outfile"

  # shellcheck disable=SC2086
  $TIMEOUT_CMD env $env_pairs HARNESS_HOME="$TMP_HOME" HARNESS_BUNDLE="$TMP_BUNDLE" \
    bun src/main.ts $args </dev/null >> "$outfile" 2>&1
  local rc=$?
  echo "--- exit code: $rc ---" >> "$outfile"
  echo "scenario=$name  exit=$rc  out=$outfile"
}

echo "M11 smoke — writing transcripts to $OUT"
echo "TMP_HOME=$TMP_HOME"
echo "TMP_BUNDLE=$TMP_BUNDLE"
echo

# --- Scenario 1: bare sov (no --ui, no SOV_UI, no config) → TUI boots
# Expected: server-boot message on stdout/stderr, exit 124 on timeout
# (TUI waits for client / TTY input).
run_scenario "01-bare-sov-default-tui" "" ""

# --- Scenario 2: bare sov with SOV_TUI_BIN=/nonexistent → fallback to REPL
# Expected: stderr contains "sov-tui binary not found — falling back".
# The REPL itself may exit fast on closed stdin or banner.
run_scenario "02-missing-binary-fallback" "SOV_TUI_BIN=/nonexistent/sov-tui" ""

# --- Scenario 3: SOV_UI=repl with no other flags → REPL (env wins over default)
# Expected: REPL banner, no TUI start.
run_scenario "03-env-sov-ui-repl" "SOV_UI=repl" ""

# --- Scenario 4: --ui repl (CLI flag wins over default) → REPL
run_scenario "04-cli-ui-repl" "" "--ui repl"

# --- Scenario 5: --ui tui (CLI flag explicit) → TUI
run_scenario "05-cli-ui-tui-explicit" "" "--ui tui"

# --- Scenario 6: config ui.surface=repl → REPL (config wins when CLI + env absent)
# Write a config under TMP_HOME first.
mkdir -p "$TMP_HOME"
cat > "$TMP_HOME/config.json" <<EOF
{
  "ui": {
    "surface": "repl"
  }
}
EOF
run_scenario "06-config-surface-repl" "" ""

# --- Scenario 7: same config but CLI --ui tui wins → TUI
run_scenario "07-cli-tui-overrides-config-repl" "" "--ui tui"

# --- Scenario 8: same config but SOV_UI=tui wins over config → TUI
run_scenario "08-env-tui-overrides-config-repl" "SOV_UI=tui" ""

# --- Scenario 9: invalid CLI flag → warning to stderr + falls through to config (repl)
run_scenario "09-invalid-cli-flag-warns" "" "--ui xyzzy"

# Reset config (remove the surface=repl override)
rm -f "$TMP_HOME/config.json"

# --- Scenario 10: invalid SOV_UI → silent fallthrough to default (tui)
# Should not print the "unknown" warning (env typos are silent by design).
run_scenario "10-invalid-env-silent-fallthrough" "SOV_UI=nonsense" ""

# --- Scenario 11: sov --help (verify help text)
run_scenario "11-help-text" "" "--help"

# --- Scenario 12: sov --version
run_scenario "12-version" "" "--version"

echo
echo "M11 smoke — all scenarios complete. Transcripts in $OUT/"
