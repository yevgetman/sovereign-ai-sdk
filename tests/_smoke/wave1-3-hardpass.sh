#!/bin/bash
# Hard-pass workflow for Waves 1-3.
# Exercises every slash command + rendering surface from Phase 10.5b,
# 10.5c, and 10.5d against a sandboxed config / DB / cwd. Real model
# turns use the cheapest Anthropic Haiku model; total cost should be
# well under a dollar per run.
#
# Run with: bash tests/_smoke/wave1-3-hardpass.sh
# Pass criteria: every assertion line ends in OK; total tail line
# reports 0 failures.

set +e

PASS=0
FAIL=0
FAILURES=()

# ──────────────────────────────────────────────────────────────────────
# Sandbox setup
# ──────────────────────────────────────────────────────────────────────
TESTDIR=$(mktemp -d /tmp/sov-hardpass.XXXXXX)
CFG=$TESTDIR/cfg.json
DB=$TESTDIR/sessions.db
echo '{}' > "$CFG"
trap "rm -rf '$TESTDIR'" EXIT

ESC=$(printf '\x1b')
strip_ansi() { sed "s/${ESC}\[[0-9;]*m//g"; }

ok() {
  PASS=$((PASS + 1))
  printf '  \033[32mOK\033[0m   %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1: $2")
  printf '  \033[31mFAIL\033[0m %s — %s\n' "$1" "$2"
}

assert_contains() {
  local name="$1"; local file="$2"; local needle="$3"
  # `--` terminates option parsing so a needle starting with `-` doesn't
  # confuse grep. Without it, `- const greeting...` looks like a flag.
  if grep -qF -- "$needle" "$file"; then ok "$name"; else fail "$name" "missing: $needle"; fi
}
assert_not_contains() {
  local name="$1"; local file="$2"; local needle="$3"
  if grep -qF -- "$needle" "$file"; then fail "$name" "should not contain: $needle"; else ok "$name"; fi
}
assert_empty_match() {
  local name="$1"; local file="$2"; local pattern="$3"
  if grep -q "$pattern" "$file"; then fail "$name" "matched: $pattern"; else ok "$name"; fi
}

run_sov() {
  local input="$1"; local outfile="$2"; shift 2
  (
    export HARNESS_CONFIG="$CFG"
    cd "$TESTDIR" && printf "$input" | \
      sov chat --no-preflight --no-cache --permission-mode bypass --db "$DB" "$@" 2>&1 | \
      strip_ansi > "$outfile"
  )
}

run_sov_raw() {
  # Like run_sov but doesn't strip ANSI — for NO_COLOR / theme assertions.
  local input="$1"; local outfile="$2"; shift 2
  (
    export HARNESS_CONFIG="$CFG"
    cd "$TESTDIR" && printf "$input" | \
      sov chat --no-preflight --no-cache --permission-mode bypass --db "$DB" "$@" 2>&1 \
      > "$outfile"
  )
}

section() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

# ──────────────────────────────────────────────────────────────────────
# Tests
# ──────────────────────────────────────────────────────────────────────

section "T1 — /help renders categorized layout"
run_sov '/help\n/quit\n' "$TESTDIR/t1.txt"
assert_contains "T1.1 has 'slash commands' header"  "$TESTDIR/t1.txt" 'slash commands'
assert_contains "T1.2 session category"             "$TESTDIR/t1.txt" '── session ──'
assert_contains "T1.3 info category"                "$TESTDIR/t1.txt" '── info ──'
assert_contains "T1.4 config category"              "$TESTDIR/t1.txt" '── config ──'
assert_contains "T1.5 files category"               "$TESTDIR/t1.txt" '── files ──'
assert_contains "T1.6 git category"                 "$TESTDIR/t1.txt" '── git ──'
assert_contains "T1.7 lists /quit alias"            "$TESTDIR/t1.txt" '/quit (/exit /q)'
assert_contains "T1.8 lists /theme"                 "$TESTDIR/t1.txt" '/theme'
assert_contains "T1.9 lists /settings"              "$TESTDIR/t1.txt" '/settings'
assert_contains "T1.10 lists /resume"               "$TESTDIR/t1.txt" '/resume'
assert_contains "T1.11 lists /export"               "$TESTDIR/t1.txt" '/export'
assert_contains "T1.12 lists /init"                 "$TESTDIR/t1.txt" '/init'
assert_contains "T1.13 lists /commit"               "$TESTDIR/t1.txt" '/commit'
assert_contains "T1.14 hint about Tab autocomplete" "$TESTDIR/t1.txt" 'Press Tab to autocomplete'

section "T2 — /about boxed info card"
run_sov '/about\n/quit\n' "$TESTDIR/t2.txt"
assert_contains "T2.1 contains 'Sovereign AI'"      "$TESTDIR/t2.txt" 'Sovereign AI'
assert_contains "T2.2 version v0.0.1"               "$TESTDIR/t2.txt" 'v0.0.1'
assert_contains "T2.3 provider line"                "$TESTDIR/t2.txt" 'provider:'
assert_contains "T2.4 model line"                   "$TESTDIR/t2.txt" 'model:'
assert_contains "T2.5 cwd line"                     "$TESTDIR/t2.txt" 'cwd:'
assert_contains "T2.6 generic-agent label"          "$TESTDIR/t2.txt" 'generic-agent mode'
assert_contains "T2.7 GitHub URL"                   "$TESTDIR/t2.txt" 'github.com/yevgetman/sovereign-ai-harness'
assert_contains "T2.8 box top border"               "$TESTDIR/t2.txt" '╭'
assert_contains "T2.9 box bottom border"            "$TESTDIR/t2.txt" '╰'

section "T3 — /tools list"
run_sov '/tools\n/quit\n' "$TESTDIR/t3.txt"
assert_contains "T3.1 'tools (14)' header"          "$TESTDIR/t3.txt" 'tools (14)'
assert_contains "T3.2 lists Bash"                   "$TESTDIR/t3.txt" 'Bash'
assert_contains "T3.3 lists FileEdit"               "$TESTDIR/t3.txt" 'FileEdit'
assert_contains "T3.4 lists FileWrite"              "$TESTDIR/t3.txt" 'FileWrite'
assert_contains "T3.5 lists Glob"                   "$TESTDIR/t3.txt" 'Glob'
assert_contains "T3.6 lists Grep"                   "$TESTDIR/t3.txt" 'Grep'
assert_contains "T3.7 lists WebFetch"               "$TESTDIR/t3.txt" 'WebFetch'

section "T4 — /skills empty list"
run_sov '/skills\n/quit\n' "$TESTDIR/t4.txt"
assert_contains "T4.1 reports no skills"            "$TESTDIR/t4.txt" 'no skills loaded'

section "T5 — /stats mid-session card"
run_sov '/stats\n/quit\n' "$TESTDIR/t5.txt"
assert_contains "T5.1 has Interaction Summary"      "$TESTDIR/t5.txt" 'Interaction Summary'
assert_contains "T5.2 shows Tool Calls"             "$TESTDIR/t5.txt" 'Tool Calls'
assert_contains "T5.3 shows Performance"            "$TESTDIR/t5.txt" 'Performance'

section "T6 — /permissions display"
run_sov '/permissions\n/quit\n' "$TESTDIR/t6.txt"
assert_contains "T6.1 shows mode"                   "$TESTDIR/t6.txt" 'mode:'
assert_contains "T6.2 bypass label"                 "$TESTDIR/t6.txt" 'bypass'
assert_contains "T6.3 reports no rules"             "$TESTDIR/t6.txt" 'no persistent allow/deny rules'

section "T7 — /quit and aliases"
run_sov '/quit\n' "$TESTDIR/t7q.txt"
run_sov '/exit\n' "$TESTDIR/t7e.txt"
run_sov '/q\n'    "$TESTDIR/t7s.txt"
assert_contains "T7.1 /quit prints goodbye"         "$TESTDIR/t7q.txt" 'goodbye'
assert_contains "T7.2 /exit prints goodbye"         "$TESTDIR/t7e.txt" 'goodbye'
assert_contains "T7.3 /q prints goodbye"            "$TESTDIR/t7s.txt" 'goodbye'
assert_contains "T7.4 /quit shows summary box"      "$TESTDIR/t7q.txt" 'Agent powering down'

section "T8 — /copy with no assistant text"
run_sov '/copy\n/quit\n' "$TESTDIR/t8.txt"
assert_contains "T8.1 graceful empty message"       "$TESTDIR/t8.txt" 'no assistant text available'

section "T9 — /export edge cases"
run_sov '/export\n/quit\n' "$TESTDIR/t9a.txt"   # empty session, picker fallback
run_sov '/export bogus\n/quit\n' "$TESTDIR/t9b.txt" # unknown format with empty session
assert_contains "T9.1 empty session graceful"       "$TESTDIR/t9a.txt" 'nothing to export'
assert_contains "T9.2 unknown format detected"      "$TESTDIR/t9b.txt" 'nothing to export'

section "T10 — /init returns prompt command (no model burn)"
# We can't easily test the prompt-command output without running a turn.
# Instead spawn /init and assert the input is recognized (no 'unknown command').
run_sov '/init\n/quit\n' "$TESTDIR/t10.txt"
assert_not_contains "T10.1 not unknown command"     "$TESTDIR/t10.txt" 'unknown command: /init'

section "T11 — /resume with no sessions"
# Use a fresh DB to ensure no sessions exist
FRESH_DB=$TESTDIR/fresh.db
( export HARNESS_CONFIG="$CFG"
  cd "$TESTDIR" && printf '/resume\n/quit\n' | \
    sov chat --no-preflight --no-cache --permission-mode bypass --db "$FRESH_DB" 2>&1 | \
    strip_ansi > "$TESTDIR/t11.txt" )
assert_contains "T11.1 non-TTY hint"                "$TESTDIR/t11.txt" 'requires a TTY'

section "T12 — /model direct + persistence"
run_sov '/model claude-opus-4-7\n/quit\n' "$TESTDIR/t12a.txt"
assert_contains "T12.1 sets model"                  "$TESTDIR/t12a.txt" 'model set to claude-opus-4-7'
# Now /model with no arg, should report current model
run_sov '/model\n/quit\n' "$TESTDIR/t12b.txt"
assert_contains "T12.2 reports current"             "$TESTDIR/t12b.txt" 'current model'

section "T13 — /theme inline + listing + bogus"
run_sov '/theme\n/theme light\n/theme bogus\n/theme dark\n/quit\n' "$TESTDIR/t13.txt"
assert_contains "T13.1 lists current theme"         "$TESTDIR/t13.txt" 'current theme:'
assert_contains "T13.2 light applied"               "$TESTDIR/t13.txt" 'theme set to light'
assert_contains "T13.3 unknown theme rejected"      "$TESTDIR/t13.txt" 'unknown theme: bogus'
assert_contains "T13.4 known list shown"            "$TESTDIR/t13.txt" 'known: dark, light, no-color'
assert_contains "T13.5 dark applied"                "$TESTDIR/t13.txt" 'theme set to dark'

section "T14 — theme persisted to sandbox config"
# Cleanup config file before fresh test
echo '{}' > "$CFG"
run_sov '/theme light\n/quit\n' "$TESTDIR/t14a.txt"
assert_contains "T14.1 cfg has theme:light"         "$CFG" '"theme": "light"'
# Restart, verify it's picked up
run_sov '/theme\n/quit\n' "$TESTDIR/t14b.txt"
assert_contains "T14.2 second run sees light"       "$TESTDIR/t14b.txt" 'current theme: light'

section "T15 — /settings non-TTY fallback"
run_sov '/settings\n/quit\n' "$TESTDIR/t15.txt"
assert_contains "T15.1 TTY hint"                    "$TESTDIR/t15.txt" 'requires a TTY'
assert_contains "T15.2 mentions sov config"         "$TESTDIR/t15.txt" 'sov config'

section "T16 — NO_COLOR strips ANSI"
echo '{"ui":{"theme":"dark"}}' > "$CFG"
( export HARNESS_CONFIG="$CFG" NO_COLOR=1
  cd "$TESTDIR" && printf '/about\n/quit\n' | \
    sov chat --no-preflight --no-cache --permission-mode bypass --db "$DB" 2>&1 \
    > "$TESTDIR/t16.txt" )
if grep -q "$ESC\[" "$TESTDIR/t16.txt"; then
  fail "T16.1 NO_COLOR strips ANSI" "found escape sequences"
else
  ok "T16.1 NO_COLOR strips ANSI"
fi

section "T17 — multi-command pipe drains queue (Wave 2 hotfix)"
echo '{"ui":{"theme":"dark"}}' > "$CFG"
run_sov '/about\n/tools\n/skills\n/permissions\n/quit\n' "$TESTDIR/t17.txt"
assert_contains "T17.1 /about ran"                  "$TESTDIR/t17.txt" 'Sovereign AI'
assert_contains "T17.2 /tools ran"                  "$TESTDIR/t17.txt" 'tools (14)'
assert_contains "T17.3 /skills ran"                 "$TESTDIR/t17.txt" 'no skills loaded'
assert_contains "T17.4 /permissions ran"            "$TESTDIR/t17.txt" 'mode:'
assert_contains "T17.5 /quit ran (goodbye)"         "$TESTDIR/t17.txt" 'goodbye'

section "T18 — Bash error multi-line suffix (live model turn)"
echo '{"ui":{"theme":"dark"}}' > "$CFG"
run_sov 'Use Bash to run "ls /this/path/does/not/exist/ever && echo never". Just run it once and report the result.\n/quit\n' "$TESTDIR/t18.txt"
# Don't assert on +N more — single-line errors are also valid. Just confirm tool ran.
assert_contains "T18.1 tool actually ran"           "$TESTDIR/t18.txt" '✗'

section "T19 — FileEdit live diff with line context (Wave 1 hotfix)"
echo '{"ui":{"theme":"dark"}}' > "$CFG"
echo 'const greeting = "hello world";' > "$TESTDIR/sample.ts"
run_sov 'Use FileEdit to change "hello world" to "hello sovereign" in sample.ts. Make ONLY this edit, no commentary.\n/quit\n' "$TESTDIR/t19.txt"
assert_contains "T19.1 diff has minus full line"    "$TESTDIR/t19.txt" '- const greeting = "hello world";'
assert_contains "T19.2 diff has plus full line"     "$TESTDIR/t19.txt" '+ const greeting = "hello sovereign";'
assert_contains "T19.3 file actually changed"       "$TESTDIR/sample.ts" 'hello sovereign'

section "T20 — /export md/jsonl/json round-trip"
echo '{"ui":{"theme":"dark"}}' > "$CFG"
EXPORT_DIR=$TESTDIR/export-test
mkdir -p "$EXPORT_DIR"
( export HARNESS_CONFIG="$CFG"
  cd "$EXPORT_DIR" && printf 'Reply with exactly: hardpass test\n/export md\n/export jsonl\n/export json\n/quit\n' | \
    sov chat --no-preflight --no-cache --permission-mode bypass --db "$TESTDIR/exp.db" 2>&1 | \
    strip_ansi > "$TESTDIR/t20.txt" )
EXPORT_MD=$(ls "$EXPORT_DIR"/session-*.md 2>/dev/null | head -1)
EXPORT_JSONL=$(ls "$EXPORT_DIR"/session-*.jsonl 2>/dev/null | head -1)
EXPORT_JSON=$(ls "$EXPORT_DIR"/session-*.json 2>/dev/null | head -1)
[ -f "$EXPORT_MD" ]    && ok "T20.1 md file exists"     || fail "T20.1 md file"     "no session-*.md found"
[ -f "$EXPORT_JSONL" ] && ok "T20.2 jsonl file exists"  || fail "T20.2 jsonl file"  "no session-*.jsonl found"
[ -f "$EXPORT_JSON" ]  && ok "T20.3 json file exists"   || fail "T20.3 json file"   "no session-*.json found"
[ -f "$EXPORT_MD" ]    && assert_contains "T20.4 md has Turn header" "$EXPORT_MD" '## Turn 1 — User'
[ -f "$EXPORT_MD" ]    && assert_contains "T20.5 md has assistant"   "$EXPORT_MD" 'hardpass test'
[ -f "$EXPORT_JSONL" ] && assert_contains "T20.6 jsonl has user"     "$EXPORT_JSONL" '"role":"user"'
[ -f "$EXPORT_JSONL" ] && assert_contains "T20.7 jsonl has assistant" "$EXPORT_JSONL" '"role":"assistant"'
[ -f "$EXPORT_JSON" ]  && assert_contains "T20.8 json has metadata"  "$EXPORT_JSON" '"providerName"'

section "T21 — /clear and /rollback"
echo '{}' > "$CFG"
run_sov 'Reply: original session\n/clear\n/rollback\n/quit\n' "$TESTDIR/t21.txt"
assert_contains "T21.1 /clear creates child"        "$TESTDIR/t21.txt" 'cleared into child session'
assert_contains "T21.2 /rollback restores parent"   "$TESTDIR/t21.txt" 'rolled back'

section "T22 — /copy with assistant text (live model turn)"
run_sov 'Reply with exactly: copy-this-string\n/copy\n/quit\n' "$TESTDIR/t22.txt"
# /copy might succeed (copied) OR fall back; both are acceptable. We just need NO crash.
if grep -qE 'copied|clipboard tool not available' "$TESTDIR/t22.txt"; then
  ok "T22.1 /copy ran without crash"
else
  fail "T22.1 /copy ran" "no copy or fallback message"
fi

section "T23 — /config show round-trip via /config"
echo '{}' > "$CFG"
run_sov '/config set defaultProvider ollama\n/config get defaultProvider\n/config unset defaultProvider\n/quit\n' "$TESTDIR/t23.txt"
assert_contains "T23.1 /config set echoed"          "$TESTDIR/t23.txt" 'set defaultProvider'
assert_contains "T23.2 /config get returns ollama"  "$TESTDIR/t23.txt" 'ollama'
assert_contains "T23.3 /config unset echoed"        "$TESTDIR/t23.txt" 'unset defaultProvider'

section "T24 — /cost basic shape"
run_sov '/cost\n/quit\n' "$TESTDIR/t24.txt"
assert_contains "T24.1 /cost has session line"      "$TESTDIR/t24.txt" 'session:'
assert_contains "T24.2 /cost has tokens line"       "$TESTDIR/t24.txt" 'tokens:'

section "T25 — splash always-allow rule count"
echo '{}' > "$CFG"
mkdir -p "$TESTDIR/.harness"
cat > "$TESTDIR/.harness/settings.local.json" <<'EOF'
{
  "permissions": {
    "allow": ["Bash(ls *)", "Read(*.ts)"]
  }
}
EOF
run_sov '/quit\n' "$TESTDIR/t25.txt"
# splash shows the rules count when non-zero
assert_contains "T25.1 splash shows allow rules"    "$TESTDIR/t25.txt" 'allow rule'
rm -rf "$TESTDIR/.harness"

section "T26 — provider error doesn't crash REPL (using bogus model)"
echo '{}' > "$CFG"
( export HARNESS_CONFIG="$CFG"
  cd "$TESTDIR" && printf 'Hi\n/quit\n' | \
    sov chat --no-preflight --no-cache --permission-mode bypass --db "$DB" --model totally-bogus-model 2>&1 | \
    strip_ansi > "$TESTDIR/t26.txt" )
# Should produce an [error] line and still exit cleanly with goodbye
assert_contains "T26.1 error rendered"              "$TESTDIR/t26.txt" '[error]'
assert_contains "T26.2 still exits cleanly"         "$TESTDIR/t26.txt" 'goodbye'

section "T27 — unicode round-trip (basic sanity)"
echo '{}' > "$CFG"
run_sov 'Reply: 你好 😀 ñ\n/copy\n/quit\n' "$TESTDIR/t27.txt"
# Just confirm no crash; the actual unicode in /copy depends on model
assert_contains "T27.1 /copy completed"             "$TESTDIR/t27.txt" 'goodbye'

section "T28 — modal permission prompt in ask mode (live)"
echo '{}' > "$CFG"
mkdir -p "$TESTDIR/modal-test"
( export HARNESS_CONFIG="$CFG"
  cd "$TESTDIR/modal-test" && \
    printf 'Use Bash to run "mkdir created-by-test". Just run that one command.\ny\n/quit\n' | \
    sov chat --no-preflight --no-cache --permission-mode ask --db "$TESTDIR/modal.db" 2>&1 | \
    strip_ansi > "$TESTDIR/t28.txt" )
assert_contains "T28.1 modal frame title"            "$TESTDIR/t28.txt" 'permission required'
assert_contains "T28.2 modal frame border"           "$TESTDIR/t28.txt" '╭'
assert_contains "T28.3 modal shows tool name"        "$TESTDIR/t28.txt" 'Bash'
assert_contains "T28.4 modal shows choices"          "$TESTDIR/t28.txt" '[y]'
assert_contains "T28.5 modal shows default"          "$TESTDIR/t28.txt" '[N]'
# After answering 'y', the directory should exist (model executed mkdir)
[ -d "$TESTDIR/modal-test/created-by-test" ] && ok "T28.6 'y' answer let tool run" || \
  fail "T28.6 'y' answer let tool run" "directory not created"

section "T29 — FileEdit replace_all annotation"
echo '{}' > "$CFG"
mkdir -p "$TESTDIR/repl-test"
printf 'foo\nfoo\nfoo bar\nfoo\n' > "$TESTDIR/repl-test/data.txt"
( export HARNESS_CONFIG="$CFG"
  cd "$TESTDIR/repl-test" && \
    printf 'Use FileEdit on data.txt to replace ALL occurrences of "foo" with "qux". Set replace_all to true.\n/quit\n' | \
    sov chat --no-preflight --no-cache --permission-mode bypass --db "$TESTDIR/repl.db" 2>&1 | \
    strip_ansi > "$TESTDIR/t29.txt" )
assert_contains "T29.1 occurrence count shown"       "$TESTDIR/t29.txt" 'occurrences'
# Confirm file actually had all occurrences replaced
if grep -q 'qux' "$TESTDIR/repl-test/data.txt" && ! grep -q 'foo' "$TESTDIR/repl-test/data.txt"; then
  ok "T29.2 file fully replaced"
else
  fail "T29.2 file fully replaced" "still contains foo or missing qux"
fi

section "T30 — FileWrite live diff rendering"
echo '{}' > "$CFG"
mkdir -p "$TESTDIR/write-test"
( export HARNESS_CONFIG="$CFG"
  cd "$TESTDIR/write-test" && \
    printf 'Use FileWrite to create file new.txt with content: "alpha\\nbeta\\ngamma\\n". Just do the write.\n/quit\n' | \
    sov chat --no-preflight --no-cache --permission-mode bypass --db "$TESTDIR/write.db" 2>&1 | \
    strip_ansi > "$TESTDIR/t30.txt" )
assert_contains "T30.1 diff has + lines"             "$TESTDIR/t30.txt" '+ alpha'
[ -f "$TESTDIR/write-test/new.txt" ] && ok "T30.2 file exists" || fail "T30.2 file exists" "new.txt not created"

section "T31 — theme cross-check: each theme renders /about"
for THEME_NAME in dark light no-color; do
  echo "{\"ui\":{\"theme\":\"$THEME_NAME\"}}" > "$CFG"
  run_sov '/about\n/quit\n' "$TESTDIR/t31-$THEME_NAME.txt"
  assert_contains "T31.$THEME_NAME /about renders"   "$TESTDIR/t31-$THEME_NAME.txt" 'Sovereign AI'
done

section "T32 — picker fallback for /export (no-arg, non-TTY)"
echo '{}' > "$CFG"
run_sov 'Reply: short\n/export\n/quit\n' "$TESTDIR/t32.txt"
assert_contains "T32.1 picker hint or fallback"      "$TESTDIR/t32.txt" 'export needs a format on non-TTY'

section "T33 — /commit prompt-command shape"
echo '{}' > "$CFG"
run_sov '/commit fix typo\n/quit\n' "$TESTDIR/t33.txt"
# /commit returns a prompt; the model would actually do git ops. We're in
# bypass mode and the test runs in a non-git temp dir, so the model will
# attempt and fail gracefully. Just confirm the command was recognized.
assert_not_contains "T33.1 /commit recognized"       "$TESTDIR/t33.txt" 'unknown command: /commit'

section "T34 — /config persist round-trip (numeric and boolean)"
echo '{}' > "$CFG"
run_sov '/config set ui.contextMeter.warnAtPercent 70\n/config get ui.contextMeter.warnAtPercent\n/config set ui.diffRender.enabled false\n/config get ui.diffRender.enabled\n/quit\n' "$TESTDIR/t34.txt"
assert_contains "T34.1 numeric round-trip"           "$TESTDIR/t34.txt" '70'
assert_contains "T34.2 boolean round-trip"           "$TESTDIR/t34.txt" 'false'

section "T35 — schema rejects bogus theme via /config"
echo '{}' > "$CFG"
run_sov '/config set ui.theme bogus\n/quit\n' "$TESTDIR/t35.txt"
assert_contains "T35.1 schema error surfaced"        "$TESTDIR/t35.txt" 'config error'

# ──────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
printf '\n\033[1m═══ HARDPASS RESULT: %d/%d passed ═══\033[0m\n' "$PASS" "$TOTAL"
if [ "$FAIL" -gt 0 ]; then
  printf '\n\033[31mFailures (%d):\033[0m\n' "$FAIL"
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
