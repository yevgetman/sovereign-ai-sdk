# SOV auth routes and native SDK host — fresh integrated code review

Date: 2026-10-09. Reviewer: fresh Codex agent. Procedure: Telekit `code-review` skill.

## Scope and result

Reviewed the complete branch diff against `origin/master`, including the native host, shared gateway composition, subscription Responses transport, credential coordination, direct xAI route, SDK stored-prefix changes, tests, documentation and retirement of the old agent policy. The baseline contained commits through `218519e`; native-host integration and final fixes were still uncommitted during this review. Read the approved design and traced the actual Telekit consumer in `telekit/agent.py` and `telekit/sov_routes.py`.

Found **one High and one Medium defect**. The operator fixed both during review. Independent reproductions now pass. No other confirmed issue above Low remains in the reviewed product paths. The final configured repository gate must run on the complete committed snapshot.

## Confirmed findings and corrections

### H1 — explicit route silently ignored without SDK mode

Location: `src/cli/runCommand.ts`, initial native/legacy dispatch.

Trigger: invoke `sov run --route chatgpt-subscription --json --stdin` without `--sdk`. The CLI accepted the new route flag, then the legacy runner ignored it and used the ambient provider. Supplying native input, toolset or deadline controls without SDK mode was also ignored.

Consequence: a caller who explicitly chose subscription authentication could run and pay through their legacy API-key route. A caller requesting the chat toolset could receive the coding tool pool instead.

Reproduction: actual source CLI, fake HOME/HARNESS_HOME/HARNESS_CONFIG, `SOV_TEST_MOCK_PROVIDER=1`, `--provider mock --no-preflight`, and a temporary DB. Before correction, the explicitly requested ChatGPT route exited 0 with `session.started.provider=mock` and a normal legacy completion. No real credentials, Keychain, login or provider network were used.

Correction: reject route/native-only controls on the legacy branch before reading stdin or starting runtime/provider work. Independent source CLI rechecks of `--route chatgpt-subscription`, `--toolset chat`, `--input-format json` and `--deadline-ms 100` now each exit 2 and emit one safe `invalid_input` terminal with no session start. The new actual-CLI regression covers the route fence.

### M1 — final storage failure reported as provider failure

Locations: `packages/sdk/src/agent/createAgent.ts`, final persistence catch; `packages/sdk/src/providers/routes/errors.ts`, stable error mapper; `src/cli/sdkRunCommand.ts`, provider-stage catch.

Trigger: final assistant-message, transcript or usage persistence throws after inference. The SDK propagated a plain storage exception. The native host was in its provider stage and classified it as `provider_failed`.

Consequence: the Owner received provider recovery guidance even though the model completed and session storage failed. This hid the real failure and weakened the typed machine contract. Save-before-tool failures already had the correct typed path and did prevent execution.

Reproduction: `/tmp/sov-final-review-probe.ts` builds a temporary isolated runtime with a mock provider and makes `sessionDb.saveMessage` throw only for the final text assistant row. Before correction the turn exited 1 with `provider_failed`. After correction the same probe exits 1 with one `storage_failed` terminal and no completion. No real credentials or provider requests were used.

Correction: SDK final-persistence errors now use `SessionPersistenceError`; the stable route mapper identifies them as `storage_failed`. The native regression confirms the terminal and absence of completion. The existing `PersistBeforeRunError` pre-tool guarantee remains intact.

## Other checks

- Read-only discovery schemas align with the Telekit consumer; native terminal events include the selected route/provider/auth/model and safe fields.
- SDK mode starts the shared runtime directly, skips preflight, starts no server/TUI and does not invoke another harness. Legacy turns reuse shared composition and relay with gateway-owned persistence.
- Route auxiliary-provider/model resolution rejects unrelated providers. Subscription-executor and smart-routing paths are disabled in native mode. Public-principal subscription resolution remains refused.
- Host input separates trusted instructions from user content, keeps the base system context and checks image count/bytes/local regular-file/media signatures. Unsupported route image encodings fail before inference.
- SDK-store mode saves calls before side effects, avoids duplicate writes with the explicit stored-prefix boundary and repairs orphaned results without re-executing calls. Signed/encrypted Anthropic history is refused across unsupported backends.
- Cancellation reaches the provider/tools, emits one terminal and suppresses late deltas; disposal waits are bounded. Native tool blocks uniquely identify concurrent calls and match results.
- Responses conversion preserves original function-call ids and fails on malformed/truncated/incomplete tool streams. No provider/auth/model fallback was found.
- Seven real-process lock cases cover overlapping expiry/401 refresh, crash recovery, PID generation, logout and cancellation. The credential mutex, generation and Keychain error paths contain no credential data in machine output.

## Validation and limits

Final focused review run after both corrections: **35 pass, zero fail, 133 assertions**, covering SDK input/run, Responses, process locks and stored-prefix/toolset enforcement. While the operator added H1's regression, its first run had a test-only cleanup-array typo (`homes` instead of `dirs`); the operator corrected it and the final focused run passed. Independent product probes for H1 and M1 passed after their fixes. The full-gate result is recorded by the operator after the completed snapshot.

This review proves offline behavior. It does not establish live account entitlement, backend-supported default models, six-route real inference, subscription live tool cycles/resume, installed binary compatibility or a real Telegram turn. Those remain the approved spec's separate delivery evidence. No installation, restart, real credential lookup, login, external inference, merge or release publication was performed by this reviewer.
