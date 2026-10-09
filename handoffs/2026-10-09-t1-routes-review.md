# T1 auth routes and credential locking — self-review

Read the code-review skill and traced the CLI discovery consumer in Telekit, route resolution, provider attempt/refresh callers, and attended login/logout. This is the implementer's self-review. It does not replace the later fresh integrated review.

Confirmed defects corrected:

- High: the old in-process refresh Map allowed two OS processes to rotate the same token. Production ports now use OS-account/service-scoped bakery tickets with atomic publication, PID liveness, unique contender paths, bounded/cancellable waits, and generation rereads. Expiry and concurrent401 process tests exchange once.
- High: a refresh or late attended approval could restore a logged-out credential. Refresh/logout share the mutex. Attended login captures a non-secret generation and rejects a changed generation at commit. Logout-after-refresh and delayed-login-after-logout tests pass.
- High: directory mutex recovery/release had shared-path deletion races. The final implementation has no shared reclaimer pathname. Every process removes only its unique ticket. Concurrent dead-owner recovery is tested.
- Medium: refreshing and failed persistence could lose typed error identity or send unpersisted tokens. Exchanges are bounded, cancellation prevents late writes, and writes must succeed before inference. Credential-store errors remain typed.
- Medium: explicit invalid default models were silently replaced by built-in defaults. Route and provider default overrides now raise model_unsupported before credential lookup. Unknown valid backend model identifiers remain permitted.
- Medium: subscription HTTP errors lost rate/model error codes and retries retained rejected response bodies. Typed SubscriptionHttpError status, bounded failure-body classification, and body disposal now preserve the machine contract without echoing backend material.
- Medium: corrupt/locked Keychain records could appear missing. Adapter read failures and unreadable records are distinct. Status remains read-only and times out as unavailable.

Validation uses fake credentials and fake HTTP only. Seven OS-process mutex cases cover overlapping expiry and401 refresh, logout ordering, three concurrent contenders after owner death, cancellation behind a live owner, late cancelled refresh results, and a reused PID with another start generation. CLI probes run in a fake HOME with no real Keychain/network/login. Static catalog and token presence are not live inference/entitlement evidence.

No installation, restart, upgrade, release, or merge was performed. The parent must preserve request-local sentRecord and cancellation hooks when integrating the Responses protocol edits. Subscription image claims stay false in this task's catalog pending protocol verification.

Final configured gate: `bun run lint` (211 modules, 710 dependencies), `bun run typecheck`, and `bun run test` pass. Full suite: 5459 pass, 19 skip, zero fail, 22316 assertions (97.26 seconds). Final focused route/auth/process/CLI suite: 52 pass, zero fail, 301 assertions. PID generation uses precise Linux boot ticks or macOS kernel start time from ps; a temporary inspection failure keeps a live owner and ends waiting by the deadline.
