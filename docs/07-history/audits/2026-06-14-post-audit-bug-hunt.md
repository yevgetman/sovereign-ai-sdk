# Post-audit deep-dive bug hunt — 2026-06-14

**Scope:** a second deep-dive bug hunt run *after* the comprehensive 2026-06-10 full-codebase audit (`2026-06-10-full-codebase-audit.md`) and its 17 fix commits shipped. This pass deliberately targets the **least-reviewed code in the repo** — the 69 files / ~3,600 lines changed *since* that audit's baseline (`f661f24`): the audit fixes themselves (security-critical), the multi-user/provider/OpenAI-API/cron/extensions changes, the heavily-churned Go TUI, and post-audit features (per-session `/effort` #57, sov/MLX reasoning streaming) — plus a sweep of high-value *unchanged* subsystems.

**Method:** 16 focused finder agents (each tasked to verify its area's prior fix is *complete* AND hunt new/introduced bugs), one independent skeptic verifier per candidate (defaulting to REFUTED, flagging anything already-fixed by the 2026-06-10 audit so it would not be re-filed), then a gap-sweep finder given the confirmed list. Many findings were empirically reproduced against HEAD (`5d9a0a6`).

**Baseline at hunt time:** `lint` clean (753 files), `typecheck` clean. The 2026-06-10 audit shipped at 3857 pass / 0 fail / 16 skip.

**Tally (confirmed NEW findings, none duplicating the 2026-06-10 audit):** 1 critical, 10 high, 12 medium, 23 low.

Verdict legend: **CONFIRMED** = reproduced / decisive line quoted; **PLAUSIBLE** = mechanism real, trigger uncertain. `is_new_or_introduced`: whether the bug was missed by the prior audit, introduced by one of its fixes, or lives in post-audit feature code.

---

## Resolution (shipped 2026-06-14)

**All 46 findings fixed** (every critical/high/medium + all 23 lows), built by a 20-way parallel subagent fan-out over disjoint file sets (Opus implementers, TDD per fix), with each group independently reviewed for completeness and the two **security groups (Bash RCE, SSRF) additionally given an adversarial bypass review**. Three groups needed central follow-up — exactly what the review layers exist to catch:

- **F2 SSRF — residual bypass caught by the adversarial reviewer.** The implementer fixed the IPv4-*mapped* `::ffff:` form but missed the IPv4-*compatible* `::a.b.c.d` (`::/96`) form, which a real resolver returns for an AAAA record (`::a9fe:a9fe` = `::169.254.169.254`). Fixed centrally in `isPrivateIpv6Bytes` (re-check the embedded IPv4 for both forms); the secondary non-canonical-IPv4 gap was assessed not-production-reachable (the WHATWG `URL` parser canonicalizes literal IPv4, and `node:dns` returns canonical dotted-quad) and documented.
- **F17 router — runtime wiring.** The provider-side decoupling was correct but inert until `buildRuntime` threads the resolved lane models into `RouterProvider` (`resolvedLocalModel`/`resolvedFrontierModel`); wired centrally.
- **F28 redaction — incomplete.** `accountSid` was added to `SECRET_KEYS` but `fromNumber` (the third schema-documented Twilio secret) was missed; added.

**One regression introduced by a fix, caught by the central gate and fixed:** F36's `mergeConsecutiveSameRoleMessages` was applied too broadly (every hydrate, any same-role pair), folding a legitimate trailing `tool_result` user message into the next user prompt and breaking two microcompaction turn-loop tests. Re-scoped to coalesce only *plain* (non-`tool_use`/`tool_result`) consecutive same-role messages — exactly the pre-H7 corruption signature — preserving tool pairing.

**Security repros confirm closed** (run against the fixed tree): the quoted-`find` RCE (`find . '-delete'`, `find . '-exec' …`) classifies non-read-only with no false-positives; the SSRF guard blocks `::169.254.169.254`/`::127.0.0.1`/`::100.64.0.1` (sync gate + DNS-pin path) while leaving public embedded IPv4 (`::8.8.8.8`) allowed.

**Consciously deferred (documented, not blocking):**
- **F36 sibling-hydrate paths (LOW).** The plain-merge heal runs in the `/turns` resume path (the finding's scope); the sibling `channels/pipeline.ts` and `server/routes/compact.ts` hydrate paths are not healed. Channel sessions are minted post-H7, so the practical exposure is nil; tracked as a low follow-up.
- **F15 same-credential-id race (MEDIUM→accepted).** The cited stale-boot-snapshot clobber is fixed (per-credential last-writer merge); the narrower same-id A-marks-ok-after-B-exhausts race would need file-lock RMW (the finding's "Alternatively" option) and is independently bounded by the cross-process `RateLimitGuard` sentinel. Accepted as-is.

**Gate at ship:** `lint` clean (761 files) + `typecheck` clean + **TS 3996 pass / 0 fail / 16 skip** (+139 over the 3857 baseline — every fix landed with a regression test) + Go `build`/`vet`/`test` all green (fresh `HARNESS_HOME`).

The full per-finding inventory below stands as the record.

---

## CRITICAL

### F1. src/tools/BashTool.ts:81 — `critical` · security · CONFIRMED · _introduced-by-fix_ · area:sec-bash

**Summary.** Incomplete C3 fix: the BashTool auto-allow gate's find-primary detector (FIND_DESTRUCTIVE_RE) is quote-naive, so quoting a destructive find primary (e.g. find . '-exec' rm {} ';' or find /x '-delete') classifies the command as read-only and auto-allows it — a channel-reachable arbitrary file deletion / command execution that runs with NO permission prompt.

**Failure scenario.** DEMONSTRATED. The regex is /(?:^|\s)-(?:delete|exec|...)(?:\s|$)/ — it requires the primary to be preceded by whitespace or start-of-string. Wrapping the primary in quotes ('-exec'/"-delete") puts a quote char before the dash, so the regex MISSES it and isReadOnlySegment returns true. I confirmed: isReadOnlyBashCommand("find /tmp/bt5 -type f '-exec' rm {} ';'") returns true (ALLOW), and bash actually executes the quoted primary (it deleted the target file in my test — bash honors quoted find primaries). Because BashTool.checkPermissions returns {behavior:'allow'} for this, canUseTool.ts line 47 short-circuits with allow BEFORE the channel's deny-asker is consulted (channels have empty ruleLayers, so no 'ask' rule blocks it). Bash is NOT in SUBAGENT_EXCLUDED_TOOLS, so it is in the channel tool pool. Net: an untrusted Slack/Telegram/webhook/SMS sender can drive arbitrary file deletion or command execution via find's -exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls primaries simply by quoting them. NOTE the divergence: shellSemantics.ts's parallel detector (FIND_DESTRUCTIVE_PRIMARIES Set, checked against tokenized+quote-stripped args) correctly flags these as 'exec' — only the BashTool regex path, which is the actual auto-allow gate, is fooled.

**Suggested fix.** Do not run a quote-naive regex over the raw segment. Apply the find-primary check after the SAME quote-stripping tokenizer shellSemantics.ts uses (or import/share isShellCommandReadOnly's analysis). Concretely: tokenize the segment (stripping quotes) and test whether any resulting token is in the destructive-primary Set, matching shellSemantics.ts's FIND_DESTRUCTIVE_PRIMARIES exactly. Better still, have isReadOnlyBashCommand defer find classification to analyzeShellCommand/isShellCommandReadOnly so the two paths cannot diverge again.

<details><summary>Evidence</summary>

CONFIRMED critical, channel-reachable RCE/file-deletion via an INCOMPLETE C3 fix. Reproduced the full chain against current HEAD.

(1) Detector divergence, run via bun against the real modules:
  BashTool.isReadOnlyBashCommand("find /x '-delete'")        => true   (AUTO-ALLOW)
  shellSemantics.isShellCommandReadOnly("find /x '-delete'") => false  (correct)
Same for "find /tmp/bt5 -type f '-exec' rm {} ';'" and the double-quoted variant.

(2) Offending line — src/tools/BashTool.ts:191:
  `if (cmd === 'find' && FIND_DESTRUCTIVE_RE.test(seg)) return false;`
tests the quote-naive regex (src/tools/BashTool.ts:80-81) against the raw segment:
  `const FIND_DESTRUCTIVE_RE = /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fprint0|fls)(?:\s|$)/;`
The primary must be preceded by whitespace or start-of-string. A quote char before the dash ('-exec') satisfies neither, so the regex misses it and isReadOnlySegment returns true. The parallel src/permissions/shellSemantics.ts path (tokenizeSegment lines 370-377 STRIP quote chars, then line 207 checks FIND_DESTRUCTIVE_PRIMARIES.has(a)) correctly flags 'exec'. The two paths diverge; only the BashTool regex — the actual auto-allow gate (checkPermissions at BashTool.ts:113-116 calls isReadOnlyBashCommand) — is fooled.

(3) Auto-allow short-circuit — src/permissions/canUseTool.ts:47:
  `if (selfCheck.behavior === 'allow' && ruleResult?.behavior !== 'ask') return { behavior: 'allow', ... };`
For a channel, ruleLayers is [] so ruleResult is undefined; the self-check 'allow' returns BEFORE the asker (line 55). The channel's `ask: () => 'deny'` (src/channels/permission.ts:58) is never consulted — the auto-deny safety entirely depends on checkPermissions returning 'ask', which the quoting bug defeats.

(4) Channel reachability: Bash is NOT in SUBAGENT_EXCLUDED_TOOLS (src/agents/exclusions.ts:20-35), so it is in the channel tool pool (src/channels/pipeline.ts:209-211), run under buildChannelCanUseTool (pipeline.ts:204).

(5) Real execution (empirically tested on this platform): bash strips the quotes before find sees the arg. `find <dir> -type f '-delete'` DELETED the target file (exit 0, empty listing after); `find <dir> -type f '-exec' echo PWNED {} ';'` RAN the arbitrary command (output lines began PWNED). So a destructive quoted primary genuinely executes, not just misclassifies.

Not a duplicate: `git diff f661f24..HEAD -- src/tools/BashTool.ts` shows FIND_DESTRUCTIVE_RE was INTRODUCED by the audit's C3 fix (absent at baseline). The fix closed the unquoted case but left the quoted case open on the gate path, while the sibling shellSemantics fix used a quote-stripping tokenizer and is correct. This is a genuine residual/introduced bug — an untrusted Slack/Telegram/webhook/SMS sender can drive arbitrary file deletion or arbitrary command execution (find -exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls) with NO permission prompt simply by quoting the primary. Per the trust model, channel-reachable RCE/file-deletion is CRITICAL. Suggested fix is correct: defer find classification to the shared quote-stripping tokenizer / FIND_DESTRUCTIVE_PRIMARIES Set (or to isShellCommandReadOnly) so the two paths cannot diverge.

</details>

## HIGH

### F2. src/tools/ssrfGuard.ts:35 — `high` · security · CONFIRMED · _missed-by-audit_ · area:sec-ssrf

**Summary.** IPv6 unique-local (ULA) block is incomplete: /^fc00::/i + /^fd[0-9a-f]{2}:/i only catch addresses literally starting `fc00::` (plus all `fd**:`), but the ULA range is fc00::/7 (fc00:: – fdff::). Addresses like fc01::, fc12:3456::1, fcaa::1 pass BOTH the sync and DNS checks.

**Failure scenario.** An untrusted channel sender (WebFetch is reachable from channel turns — not in SUBAGENT_EXCLUDED_TOOLS) prompts the model to call WebFetch on http://[fc12:3456::1]/ (a valid unique-local address of an internal service). checkUrlAllowed returns ok:true (verified: 'http://[fc12:3456::1]/ ALLOWED'). On the DNS path assertResolvedHostPublic short-circuits to null because isIP('fc12:3456::1')===6, so there is NO backstop — the fetch is issued against the private host. The warn-only copy in src/mcp/client.ts:380 (`/^f[cd][0-9a-f]*:/`) actually handles fc00::/7 correctly, so the security-load-bearing gate is LESS complete than the heuristic warning.

**Suggested fix.** Replace the narrow ULA regexes with a single fc00::/7 matcher mirroring client.ts: /^f[cd][0-9a-f]*:/i (covers fc00–fdff). Likewise widen link-local from /^fe80::/i to fe80::/10 (fe80–febf), e.g. /^fe[89ab][0-9a-f]*:/i. Add fc01::/fcaa::/fc12:3456::1 cases to the ssrfGuard test.

<details><summary>Evidence</summary>

CONFIRMED via source + empirical test. The sync gate in src/tools/ssrfGuard.ts lines 31-37 lists only:
  /^fe80::/i, // link-local
  /^fc00::/i, // unique-local
  /^fd[0-9a-f]{2}:/i, // unique-local fd00::/8
These match only the LITERAL prefix `fc00::` and `fe80::` (plus all `fd**:`). ULA is fc00::/7 (fc00::–fdff::) and link-local is fe80::/10 (fe80–febf). Ran a Node repro of isPrivateAddress against the exact patterns: `fc01::`, `fc12:3456::1`, `fcaa::1`, `fe90::1`, `febf::1` all return blockedBySync=FALSE; only `fc00::1`, `fd00:1234::1`, `fe80::1` return TRUE. So checkUrlAllowed('http://[fc12:3456::1]/') returns ok:true.

The DNS backstop provides NO second line of defense for these: assertResolvedHostPublic line 123 `if (isIP(host) !== 0) return null;` short-circuits because isIP('fc12:3456::1')===6 — by design the sync check is supposed to catch literals, so the gap is fully exposed.

Reachable by an UNTRUSTED channel sender: WebFetch (src/tools/WebFetchTool.ts:123 name:'WebFetch', isReadOnly:()=>true at line 127) is NOT in SUBAGENT_EXCLUDED_TOOLS (src/agents/exclusions.ts only lists AgentTool/cron_*/task_stop/send_message), and src/channels/permission.ts lines 15-16 state read-only tools "still run" without an approver. So a channel sender prompts the model to WebFetch http://[fc12:3456::1]/ → validateInput passes (line 131) → assertResolvedHostPublic returns null (line 165) → fetchImpl is issued against the private IPv6 host (line 168). SSRF.

This is an INCOMPLETE audit fix, not a re-derivation: ssrfGuard.ts was newly ADDED in commit cbba0fa (the audit-H/M SSRF fix); git diff f661f24..HEAD shows the whole file is new. Audit line 192 specified "block if any resolved address is private/loopback/link-local" — the fix implemented the DNS layer + IPv4-mapped normalization correctly but wrote the IPv6 range regexes too narrowly. Ironically the warn-only heuristic in src/mcp/client.ts lines 380-382 is CORRECT for the full ranges: `/^f[cd][0-9a-f]*:/` (fc00::/7) and `/^fe[89ab][0-9a-f]*:/` (fe80::/10) — confirmed it blocks all 8 test cases. So the security-load-bearing gate is strictly less complete than the heuristic warning.

Severity HIGH not CRITICAL: the most-deployed ULA prefixes (fc00::/16, fd00::/8 incl. AWS IPv6 metadata fd00:ec2::254) and fe80::/16 ARE correctly blocked, and all IPv4 RFC1918/loopback/metadata are blocked — the exploitable residue is the rest of fc00::/7 and fe80::/10, a narrower but real internal-IPv6 SSRF surface for an untrusted channel sender. Fix: mirror client.ts — /^f[cd][0-9a-f]*:/i for ULA and /^fe[89ab][0-9a-f]*:/i for link-local.

</details>

### F3. src/tools/ssrfGuard.ts:22 — `high` · security · CONFIRMED · _missed-by-audit_ · area:sec-ssrf

**Summary.** CGNAT range 100.64.0.0/10 (RFC 6598) is not blocked. PRIVATE_IPV4_PATTERNS omits it entirely. Cloud internal services and some metadata endpoints (e.g. Alibaba Cloud 100.100.100.200) live in this shared-address space.

**Failure scenario.** Untrusted channel sender prompts WebFetch on http://100.64.0.1/ or http://100.100.100.200/. checkUrlAllowed returns ok:true (verified: both 'ALLOWED'). For IP literals assertResolvedHostPublic short-circuits (isIP===4), so there is no DNS backstop — the request reaches the internal/CGNAT host. The IPv4-mapped form http://[::ffff:6440:1]/ (::ffff:100.64.0.1) is also allowed.

**Suggested fix.** Add the CGNAT pattern to PRIVATE_IPV4_PATTERNS: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./ (matches 100.64.0.0 – 100.127.255.255). Add it to the ssrfGuard test's IPv4 block list.

<details><summary>Evidence</summary>

VERIFIED at HEAD. src/tools/ssrfGuard.ts:22-29 PRIVATE_IPV4_PATTERNS omits the CGNAT range 100.64.0.0/10 (RFC 6598):
```
const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  /^127\./, /^0\./, /^10\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
];
```
Empirical run (bun, importing the real module) confirmed every CGNAT case returns ALLOWED:
  http://100.64.0.1/           ALLOWED
  http://100.100.100.200/      ALLOWED   (Alibaba Cloud metadata)
  http://100.127.255.255/      ALLOWED
  http://[::ffff:6440:1]/      ALLOWED   (= ::ffff:100.64.0.1; normalizeMappedIpv4 -> 100.64.0.1)
  isPrivateAddress('100.64.0.1') === false
Boundary-correct: 100.63.255.255 and 100.128.0.0 (genuinely public) stay ALLOWED, so the proposed regex /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./ would not over-block.

No DNS backstop for IP literals: src/tools/ssrfGuard.ts:123 `if (isIP(host) !== 0) return null;` short-circuits assertResolvedHostPublic for any literal, so the only gate on 100.64.0.1 is checkUrlAllowed -> isPrivateHost -> isPrivateAddress, which is false. Confirmed reachable by an UNTRUSTED channel sender: src/channels/pipeline.ts:209-210 builds the channel pool as `runtime.toolPool.filter((tool) => !SUBAGENT_EXCLUDED_TOOLS.has(tool.name))`; WebFetch is NOT in SUBAGENT_EXCLUDED_TOOLS (src/agents/exclusions.ts:20-35), and WebFetchTool is `isReadOnly: () => true` (WebFetchTool.ts:127), so the safe-by-default channel decider (src/channels/permission.ts — read-only tools self-allow, only ask-tools deny) permits it. A Slack/Telegram/webhook/SMS sender can therefore prompt WebFetch on http://100.100.100.200/ or http://100.64.0.1/ and reach internal/CGNAT/overlay space and certain cloud metadata endpoints.

Scope: NEW/residual. The 2026-06-10 audit (per the module header comment) added the IPv4-mapped-IPv6 normalization and the link-local 169.254.169.254 (AWS/GCP) metadata block, but missed RFC 6598. The most common cloud-creds metadata vector (169.254.169.254) IS already blocked, which keeps this at HIGH rather than CRITICAL, but Alibaba-style metadata (100.100.100.200) and carrier-grade/overlay internal hosts remain reachable. Not a known-open deferred item (#17/#50-54) and not in the audit's fixed set. The suggested fix is correct.

</details>

### F4. src/tools/ssrfGuard.ts:165 — `high` · security · CONFIRMED · _missed-by-audit_ · area:sec-ssrf

**Summary.** DNS-rebinding TOCTOU: assertResolvedHostPublic resolves the hostname once, then fetchImpl(currentUrl) performs an INDEPENDENT second DNS resolution at connect time. There is no IP pinning between guard-check and fetch, so a low-TTL attacker-controlled domain can answer 'public' to the guard's lookup and 'private/loopback/metadata' to fetch's lookup.

**Failure scenario.** Untrusted channel sender prompts WebFetch on http://rebind.attacker.example/. The guard's node:dns lookup returns a public A record (passes assertResolvedHostPublic). Microseconds later fetchImpl resolves the same name again (separate resolver/cache; attacker rotates the record to 169.254.169.254 or 127.0.0.1) and connects to the private target. The guard checked a different IP than the one fetched — the classic DNS-rebinding bypass the guard's own header comment names but does not actually prevent (resolve-then-pin would be required).

**Suggested fix.** Pin the resolved address: resolve once in the guard, verify it is public, then connect to that exact IP via a custom undici Agent/dispatcher with a fixed lookup (sending the original Host header for TLS/vhost). Absent pinning, prefer a deny-by-default egress allow-list on the channel-reachable surface and document this as a known residual (the DNS guard only closes first-resolution-private hosts, not rebinding).

<details><summary>Evidence</summary>

CONFIRMED — the resolve-then-reresolve TOCTOU is real and untrusted-channel-reachable.

Decisive lines in WebFetchTool.ts (the real-fetch path; injectedFetch is undefined for a live channel turn, so fetchImpl = globalThis.fetch and dnsGuardEnabled = true):

  L165:  const dnsBlock = await assertResolvedHostPublic(new URL(currentUrl).hostname, lookupImpl);
  L166:  if (dnsBlock) return blockedResult(input.url, currentUrl, dnsBlock);
  L168:  response = await fetchImpl(currentUrl, { signal: controller.signal, redirect: 'manual', headers: {...} });

assertResolvedHostPublic (ssrfGuard.ts:118-135) does ONE dns.lookup of the hostname and discards the IP — it returns only a block/allow verdict, never a pinned address. Line 168 then hands the *hostname string* to fetch, which performs a SECOND, independent connect-time resolution. There is no IP pinning between guard and fetch, so a low-TTL attacker-controlled name can answer 'public' to the guard's lookup and 'private/metadata' to fetch's lookup. The guard's own header comment overclaims this protection — ssrfGuard.ts:10-11: "An ASYNC DNS-resolution check for hostnames: a public name that resolves to a private address (DNS-rebinding / *.nip.io / localtest.me) is blocked." nip.io/localtest.me (static private answers) ARE blocked; true *rebinding* (rotating answer) is NOT.

Reachability by an untrusted channel sender is established end-to-end:
- WebFetchTool declares isReadOnly:()=>true and does NOT override checkPermissions, so via buildTool.ts:18 TOOL_DEFAULTS its self-check returns { behavior:'allow' }.
- Channel posture (channels/permission.ts buildChannelCanUseTool): mode 'default', ruleLayers:[], ask:()=>'deny'. In canUseTool.ts the self-check 'allow' at L46-48 returns { behavior:'allow' } — WebFetch RUNS for channel senders.
- WebFetch is NOT in SUBAGENT_EXCLUDED_TOOLS (agents/exclusions.ts:20-35), and pipeline.ts:209-211 builds the channel pool as runtime.toolPool minus that set — so WebFetch is in the channel tool pool.

Exploit: a Slack/Telegram/webhook/SMS sender prompts WebFetch http://rebind.attacker.example/ ; the guard resolves a public A record (passes L165), then fetch re-resolves the same low-TTL name to 169.254.169.254 / 127.0.0.1 and returns the body — cloud-metadata/loopback exfil on a hosted gateway, exactly what the tool claims to block.

Not a duplicate: this is a RESIDUAL of the audit's own H23 fix. Audit H23 (docs/07-history/audits/2026-06-10-full-codebase-audit.md:190) prescribed "Resolve hostname to IP(s) (dns.lookup all) and block if any resolved address is private" — the exact resolve-then-block-without-pinning approach that shipped in cbba0fa. The audit named the DNS-to-private class and considered it fixed; the rebinding race the new guard's comment claims to close survives. Same residual also exists in src/context/references.ts:146-149 (but @url is a user-only surface, not channel-reachable; WebFetch is the untrusted-reachable sink).

Severity high (not critical): real untrusted-reachable SSRF-to-metadata, but exploitation requires winning a race between two resolutions of a low-TTL attacker domain; Node/libuv may serve the first resolution from process cache within the TTL, reducing race reliability. Proper fix is IP-pinning (resolve once, verify public, connect to that exact IP via a fixed-lookup undici dispatcher with the original Host header), or document rebinding as a known residual and gate the channel-reachable surface behind a deny-by-default egress allow-list.

</details>

### F5. src/tools/ssrfGuard.ts:131 — `high` · security · CONFIRMED · _missed-by-audit_ · area:sec-ssrf

**Summary.** Fail-open on DNS error combined with fetch's independent resolution: when the guard's lookup throws it returns null (allowed) and fetchImpl then resolves independently and may succeed against a private target. The 'let the fetch fail naturally' rationale only holds if the two resolvers agree.

**Failure scenario.** The guard's node:dns lookup transiently fails (SERVFAIL/timeout on one path) for a public-looking name whose fetch-side resolution succeeds to a private IP. assertResolvedHostPublic returns null via `catch { return null }` (line 132), the sync check already passed, and fetch connects privately. Lower likelihood than rebinding but the same root cause: the guard's resolution is advisory, not binding on the fetch.

**Suggested fix.** Pin the guard-resolved address into the fetch (see TOCTOU finding). If pinning is out of scope, on the channel-reachable surface treat a lookup error for a non-literal host as fail-CLOSED (return a block reason) rather than fail-open.

<details><summary>Evidence</summary>

The cited code is accurately quoted and the mechanism is real. `src/tools/ssrfGuard.ts` is NEW code introduced by the audit's own H23 fix (commit cbba0fa, "close SSRF bypasses in WebFetch"), so this is a residual in the fix — NOT a re-derivation (duplicate_of_audit=FALSE; category (c) incomplete fix).

Decisive lines:
- ssrfGuard.ts:124-133 `assertResolvedHostPublic`: `try { const results = await lookupImpl(host, { all: true }); for (const r of results) { if (isPrivateAddress(r.address)) return '...private/loopback...'; } } catch { return null; }` — a lookup error returns null = ALLOWED (fail-open), and on success it only *inspects* the addresses; it never returns or pins them.
- WebFetchTool.ts:165-168: the guard runs `assertResolvedHostPublic(new URL(currentUrl).hostname, ...)`, then `response = await fetchImpl(currentUrl, {...})` is called with the URL STRING. There is NO IP pinning (grep confirms no custom `lookup`/dispatcher/Agent passed to fetch). So fetch performs its OWN independent DNS resolution; the guard's resolution is purely advisory.

Reachability: WebFetch is `isReadOnly: () => true`, so its self-check returns `allow` (canUseTool.ts:46-48), and channel turns run under `buildChannelCanUseTool({mode:'default'})` (pipeline.ts:204) which auto-runs read-only tools while denying Bash/Write. Channels (Slack/Telegram/webhook/SMS) are untrusted per the trust model, so a channel sender can drive WebFetch at an arbitrary URL on a hosted gateway → cloud-metadata (169.254.169.254) / loopback reach is the exact threat H23 set out to block.

Severity re-rating to HIGH (finder said low): the finder's *headline* scenario — guard's node:dns lookup transiently SERVFAILs while fetch's resolution succeeds to a private IP — is genuinely low-likelihood (an attacker can't reliably force the two resolvers to disagree; finder concedes this). But the finder explicitly names the real root cause: "the guard's resolution is advisory, not binding on the fetch," and points at "the TOCTOU finding." That root cause is the classic DNS-rebinding TOCTOU bypass: attacker-controlled authoritative DNS with low TTL answers the guard's lookup with a public IP (allowed), then answers fetch's independent lookup with 169.254.169.254 / 127.0.0.1. This is reliably exploitable by an untrusted channel sender — a channel-reachable SSRF = HIGH per the trust model. The fail-open-on-DNS-error sub-claim alone is only low (resolver disagreement is unforced), but the advisory-not-pinned design it points to is the genuinely exploitable residual.

Proper fix: pin the guard-resolved public address into the fetch connection (custom lookup/dispatcher) so guard and fetch resolve to the same IP, eliminating both the rebinding TOCTOU and the fail-open divergence.

</details>

### F6. src/learning/observer.ts:84 — `high` · bug · PLAUSIBLE · _missed-by-audit_ · area:leak-redaction

**Summary.** observations.jsonl is append-only and never rotated/pruned, but the instinct-synthesizer sub-agent is instructed to Read it whole via FileReadTool, which hard-errors at the 1 MiB cap (MAX_BYTES in FileReadTool.ts). Once a project's corpus crosses 1 MiB the learning loop silently stops synthesizing for that project.

**Failure scenario.** observer.observe() appends one JSON line per tool use forever (no rotation/truncation anywhere in src/learning or the CLI; `harness learning prune` only prunes instincts). Each line is ~a few hundred bytes (tool_input_summary capped at 256 + envelope summary + metadata), so an active project reaches 1 MiB after a few thousand observations — easily over the multi-session learning soak. bundle-default/agents/instinct-synthesizer.md step 1 says 'Read the recent observations (use the Read tool on the JSONL path)', and synthesizer.ts buildPrompt() also just says 'Read recent observations' with NO offset/limit/head guidance. FileReadTool.ts line 98-101 throws `file too large: <n> bytes (cap is 1048576)` for any file over MAX_BYTES (= 1024*1024). The synthesizer turn then fails to read its input; runSynthesizer returns ok:true on a 'completed'/'max_turns' terminal regardless, so no new instincts are proposed/reinforced and the degradation is invisible — exactly the silent-synthesis-failure class Task 14 fought. This directly undermines the #1 active-focus learning soak.

**Suggested fix.** Rotate/cap observations.jsonl (e.g., keep the last N lines or roll to observations.N.jsonl on size) and/or instruct the synthesizer prompt to page with Read offset/limit (or tail via Grep) when the file is large, and have FileReadTool degrade to a head read for the synthesizer path rather than hard-erroring. At minimum add an observations-retention setting so a long-running soak doesn't silently wedge synthesis.

<details><summary>Evidence</summary>

Mechanism confirmed end-to-end at HEAD; only the worst-case outcome (silent total wedge) is uncertain because the synthesizer also has Grep and could self-pivot, so I rate it PLAUSIBLE rather than CONFIRMED.

1. Append-only, never rotated — observer.ts:84: `await appendFile(path, \`${JSON.stringify(observation)}\n\`, 'utf-8');` is the SOLE write. A repo-wide grep for rotate/truncate/retention/unlink against observations found NOTHING in src/learning or anywhere in src/.

2. Prune does NOT touch the stream — src/cli/learningPrune.ts prunes only sub-threshold INSTINCTS (confidence.ts shouldPrune). observations.jsonl grows unbounded.

3. Synthesizer's only ingestion path is FileReadTool — it is an LLM sub-agent (allowedTools: Read, Grep, instinct_*). There is NO programmatic observations reader in src/ (grep for readObservations/parseObservations/readFileSync.*observations returned empty; cluster.ts is explicitly "No I/O" and takes already-parsed Observation[]). bundle-default/agents/instinct-synthesizer.md:26: "Read the recent observations (use the `Read` tool on the JSONL path)." synthesizer.ts:56 buildPrompt: "Read recent observations" — NO offset/limit/tail/head/Grep guidance anywhere in either prompt.

4. FileReadTool hard-throws over 1 MiB — FileReadTool.ts:20 `const MAX_BYTES = 1024 * 1024;` and lines 98-101: `if (stat.size > MAX_BYTES) { throw new Error(\`file too large: ${stat.size} bytes (cap is ${MAX_BYTES}). Use offset/limit to page through it.\`); }`.

5. Failure is invisible upstream — synthesizer.ts:81-86 returns `{ ok: true, summary }` on any 'completed'/'max_turns' terminal; an LLM that hits the tool error and ends its turn still yields a "completed" terminal, so runSynthesizer reports success — the silent-synthesis-failure class Task 14 fought.

6. Size math: Observation lines carry a 71-char sha256 hash, summary up to 256 chars (types.ts: tool_input_summary z.string().max(256)), ISO timestamps and ids — ~300-600 bytes/line → 1 MiB at ~2,000-3,500 observations, reachable across the multi-session soak.

Not in the 2026-06-10 audit (git diff f661f24..HEAD on observer.ts shows the audit only added redaction per Invariant #15). New/residual, not a deferred #17/#50-54 item.

Downgraded from CONFIRMED to PLAUSIBLE: the synthesizer has the Grep tool and the FileRead error message literally says "Use offset/limit to page through it," so a capable model may self-recover to paged reads or Grep — making the realistic outcome "degraded/unreliable synthesis on large corpora" rather than a guaranteed silent total stop. Still HIGH: it breaks the core learning loop on the exact long-running-soak path the project is actively betting on, on a local trusted surface (no security/data-loss → not critical). Reasonable fix: cap/rotate observations.jsonl (keep last N lines or roll on size) and/or instruct the synthesizer to page or tail when large.

</details>

### F7. src/providers/openai.ts:175 — `high` · bug · CONFIRMED · _introduced-by-fix_ · area:providers

**Summary.** OpenAI reasoning models (o1/o3/o4/gpt-5) send `max_tokens` + `temperature` whenever effort is off (the default) — both of which those models reject — so the session fails preflight and never boots.

**Failure scenario.** The M27 fix gates the token-cap swap on `const openAiReasoningModel = reasoningOn && this.apiMode === 'openai'` (line 175), where `reasoningOn` requires `req.effort !== 'off'`. The default effort is `'off'` (config schema default; `src/cli/configMode.ts` uses 'off'), and `preflightProvider` (src/providers/preflight.ts:50) calls `provider.stream({ model, maxTokens: 8 })` with NO effort field at all. So for a user who sets `model: 'gpt-5'` / `o3-mini` etc. and leaves effort at its default, buildKwargs emits `max_tokens` (line 186) and `temperature` (line 189). The o-series/gpt-5 API rejects `max_tokens` with `unsupported_parameter` (they require `max_completion_tokens`) and rejects non-default temperature — independent of whether reasoning_effort is set. Demonstrated: `buildKwargs({model:'gpt-5', maxTokens:8})` (preflight) → `{max_tokens:8, max_completion_tokens:undefined}`; with `effort:'off'` → `{max_tokens:4096, temperature:0.7}`. Result: preflightProvider throws → PreflightError → buildRuntime refuses to start for any OpenAI reasoning model at default effort. The test at tests/providers/effort.adapters.test.ts:158-166 codifies this broken body as the desired 'byte-identical' output, so the suite is green while the path is broken.

**Suggested fix.** Gate the token-cap swap and temperature drop on the model being a reasoning model, NOT on reasoning being actively ON. Compute `const isOpenAiReasoningModel = this.apiMode === 'openai' && modelSupportsReasoning(req.model, this.apiMode)` and use that for the `max_completion_tokens`/`max_tokens` choice and the temperature omission. (reasoning_effort itself still keys off `reasoningOn`.) Then fix the test at effort.adapters.test.ts:158 which currently asserts the wrong contract for gpt-5 + effort off.

<details><summary>Evidence</summary>

Genuine INCOMPLETE FIX from the M27 commit 4e09883 (shipped in the audit-fix window). The fix's own commit message states the bug: "OpenAI reasoning models (o1/o3/o4/gpt-5) were sent max_tokens (which they reject) — now max_completion_tokens + temperature dropped." But the fix gated the swap on reasoning being ACTIVELY ON, not on the model being a reasoning model.

Offending line — src/providers/openai.ts:175:
  const openAiReasoningModel = reasoningOn && this.apiMode === 'openai';
where reasoningOn (line 156-162 reasoningEnabled) requires `req.effort !== undefined && req.effort !== 'off'`.

The token-cap swap (lines 184-186) and temperature drop (189-191) both key off openAiReasoningModel:
  ...(openAiReasoningModel ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),

Trigger chain — fully reachable:
1. Default effort is 'off' (src/config/schema.ts:253 `effort: z.enum(REASONING_EFFORTS).default('off')`; src/cli/configMode.ts:333,444 use 'off').
2. preflightProvider (src/providers/preflight.ts:46-53) calls `provider.stream({ model, system, messages, maxTokens: 8, cacheEnabled: false })` with NO effort field → req.effort=undefined → reasoningOn=false → openAiReasoningModel=false → buildKwargs emits `max_tokens: 8` for the reasoning model.
3. gpt-5/o1/o3/o4 ARE recognized reasoning models (src/providers/effort.ts:66 `/(^|[^a-z])(o1|o3|o4)([^a-z]|$)/.test(id) || /gpt-5/.test(id)`).
4. Model is a free-form `z.string()` (schema lines 23/162/181/237) — no catalog gate, so `model:'o3-mini'`/`defaultModel:'gpt-5'` with the openai provider is configurable.
5. buildRuntime fires preflightProvider on boot (src/server/runtime.ts:990) and throws PreflightError on failure (line 996) → the harness never boots for that model.

The OpenAI o-series/gpt-5 API rejects `max_tokens` (400 unsupported_parameter; requires max_completion_tokens) — the exact behavior M27 was built to handle, asserted twice by the author (commit msg + comment at openai.ts:169-171). So the bug persists for the default (off) effort path; it was only fixed for effort-on.

The test at tests/providers/effort.adapters.test.ts:158-166 codifies the broken body as the desired contract for gpt-5 + effort off:
  expect(off.temperature).toBe(0.7);
  expect(off.max_tokens).toBe(4096);
(baseReq sets temperature:0.7, maxTokens:4096) — masking the regression, suite stays green.

Severity high (not critical): a real core-path correctness break that any user configuring an OpenAI reasoning model at default effort hits (refuses to boot); not a security/leak boundary, and scoped to OpenAI reasoning models. Caveat narrowing the claim: the temperature half only bites via the OpenAI-compatible server (src/openai/routes/chatCompletions.ts:258 forwards a client-supplied temperature) — normal interactive turns via agentRunner→query never set temperature, so preflight itself sends only max_tokens (no temperature). The max_tokens half alone is sufficient to break preflight/boot.

</details>

### F8. src/server/webui.html:2113 — `high` · bug · CONFIRMED · _introduced-by-fix_ · area:server-misc-effort

**Summary.** webui compaction pivot (Fix 5/M37) re-points the follow stream to the child bus mid-turn, dropping the rest of the in-flight turn's events and never clearing turnActive

**Failure scenario.** Proactive compaction is the common case and fires MID-TURN, before the model produces its answer. In src/server/routes/turns.ts the proactive hop (lines 565-594) publishes compaction_complete on the PARENT bus, reassigns the local `sessionId` to the child, but then runs query() at line 694 streaming text_delta + turn_complete on the SAME `bus` — which stays bound to sessionIdInitial (the parent) for the whole turn (the recorder/bus comment at lines 662-666 confirms 'the bus is per-root-session and the TUI subscribes against the original id'). The webui's compactionNotice (webui.html:2100) reacts to compaction_complete by UNCONDITIONALLY doing `S.lastEventId = null; stopStream(); openStream();` (lines 2113-2115), aborting the parent-bus reader and reconnecting to the CHILD bus. The child bus has no events for the current turn. Result: after a proactive compaction the user sees the conversation freeze for the rest of that turn (the actual assistant answer is dropped), and because turn_complete (published on the parent bus, webui.html:1756 → S.turnActive=false) is never received on the child stream, S.turnActive stays true (webui.html:1451/2154) so the composer stays locked / spinner hangs until manual cancel. Fix 5 only works when compaction lands at a turn BOUNDARY (the explicit /compact route, or a no-content turn); for the dominant proactive-mid-turn case it pivots away too early.

**Suggested fix.** Do not abort+repoint the stream the instant compaction_complete arrives while a turn is active. The remaining current-turn events flow on the PARENT bus. Either (a) defer the pivot until the current turn terminal: record the pending child id from compaction_complete and only stopStream()+openStream() inside turnComplete/turnError once S.turnActive flips false; or (b) keep following the parent bus and have the server continue publishing every turn on the original root bus (it already does), pivoting S.sessionId for the NEXT POST /turns only without reconnecting the SSE stream. Option (a) is the minimal change and matches the server's per-root-session bus contract.

<details><summary>Evidence</summary>

CONFIRMED — incomplete-fix residual introduced by audit fix M37 (FIX 5, commit 039db06, in the 34b3fd6..eb827c8 audit-fix range).

CONTROL FLOW (proactive compaction fires MID-TURN, default path):
- src/server/runtime.ts:1324 — `proactiveCompactThreshold` defaults to `0.75` (75% of context). This is the common case for any long conversation.
- src/server/routes/turns.ts:573 — `const result = await runtime.compact(...)` runs INSIDE the turn, BEFORE the model answers.
- turns.ts:581-582 — `publishCompactionComplete(bus, sessionId, result);` then `sessionId = result.newSessionId;`. The compaction_complete is published on the PARENT `bus`; only the `sessionId` *variable* pivots to the child.
- The model's actual answer is produced at turns.ts:833 `let terminal = await runOnce(messages);` — AFTER compaction_complete was already emitted.

THE BUS IS NEVER REASSIGNED:
- `bus` is created once at turns.ts:223 `const bus = getOrCreateBus(sessionId)` keyed on the PARENT id and passed into runTurnInBackground (param at line 385). It is never reassigned when sessionId pivots.
- Every turn event still publishes on that parent bus: text_delta via `mapStreamEventToServerEvent(streamEvent, bus, sessionId, ...)` + `bus.publish(mapped)` (turns.ts:820-821), final `status_update` `bus.publish(finalStatusEvent)` (line 974), and `turn_complete` `bus.publish({ type:'turn_complete', seq: bus.nextSeq(), sessionId, ... })` (lines 975-980). The code comment at turns.ts:660-666 confirms: "the bus is per-root-session and the TUI subscribes against the original id."
- getOrCreateBus is keyed per id (src/server/eventBus.ts:298 `buses.get(sessionId)`), so parent and child are distinct bus objects.

THE WEBUI PIVOTS UNCONDITIONALLY (no turn-active guard):
- src/server/webui.html:2100-2116 `compactionNotice(ev)` — `if (ev.activeSessionId && ev.activeSessionId !== S.sessionId)` then sets `S.sessionId = ev.activeSessionId` (2103), and unconditionally `S.lastEventId = null; stopStream(); openStream();` (2113-2115). No `S.turnActive` check.
- openStream (webui.html:1540) connects to `/sessions/' + S.sessionId + '/events'` (now the child id). The events route does `getOrCreateBus(sessionId)` on the child id (src/server/routes/events.ts:76) — a freshly minted EMPTY bus with NO events for the in-flight turn.

RESULT:
- The rest of the current turn (text_delta + status_update + turn_complete) flows on the abandoned PARENT bus. The user sees the answer freeze.
- turnComplete (webui.html:2172-2173 `S.turnActive = false`) is the only place that unlocks the composer, and it never fires on the child stream → composer stays locked / spinner hangs until manual cancel.

WHY IT'S A RESIDUAL, NOT A DUPLICATE:
- Audit M37 (docs/07-history/audits/2026-06-10-full-codebase-audit.md:357-359) scoped the bug to the turn-BOUNDARY case only: "Subsequent turns POST to /sessions/<child>/turns (child bus)." Its prescribed fix is FIX 5 verbatim. That fix is correct for the explicit /compact route (src/server/routes/compact.ts:40 — a standalone between-turns HTTP request, no turn mid-flight), but the webui handler at webui.html:1750-1752→2100 cannot distinguish that from a proactive MID-TURN compaction and pivots away too early. The audit MISSED the proactive-mid-turn case; its fix introduced the regression. Current HEAD does NOT correctly handle it → duplicate_of_audit = FALSE.

SEVERITY high: default proactive-compaction path (≥75% context) on the loopback reference web UI drops the assistant's answer and wedges the composer — a core mainline-chat correctness break guaranteed to hit in normal long sessions. Not critical: loopback/within-org trusted surface, no security boundary crossed. Minimal correct fix: defer the pivot until the turn terminal (record pending child id on compaction_complete; stopStream()+openStream() only inside turnComplete/turnError once S.turnActive flips false).

</details>

### F9. packages/tui/internal/app/app.go:1545 — `high` · perf · CONFIRMED · _missed-by-audit_ · area:tui-go

**Summary.** SSE clean-close reconnect is immediate (zero delay); against the REAL server a between-turns reconnect closes instantly, producing a hot reconnect/HTTP-flood loop during all idle time. The audit's FIX 2 only throttled the error path, leaving the common idle path unthrottled — an incomplete fix.

**Failure scenario.** Turn N completes. Server (src/server/routes/events.ts:191) ends the TUI's non-?follow stream on the turn terminal. The TUI's sseDoneMsg handler sees err==nil, sets m.sseBackoff=0, and calls startSSE() with NO delay (app.go:1545-1549). The reconnect carries Last-Event-ID=m.sseCursor (the terminal event's seq). The server replays nothing (cursor past terminal) and, since !bus.isTurnActive() && replayedCount===0, ends the stream IMMEDIATELY (events.ts:132-134, the park-forever 'Fix 2'). transport.Consume returns a clean close (HTTP 200, zero events) → sseDoneMsg{err:nil} → startSSE() again → server ends immediately again → ... a tight loop of full HTTP GET round-trips to /sessions/:id/events as fast as the loopback round-trip allows, for the entire idle period between turns (up to the 30-min supervisor eviction). Pegs a CPU core, floods server logs, and drains battery whenever the user is just reading the last reply. The cadence test (app_test.go:1187-1200) does NOT catch this because its mock server holds the post-turn idle reconnect open (`<-r.Context().Done()`, line 1141) — diverging from the real server, which closes it.

**Suggested fix.** Either (a) have the TUI open the events stream with ?follow=true so the server keeps the single connection alive across turns (it already supports follow and won't auto-end on terminals), or (b) apply a minimum reconnect delay (e.g. reuse sseBackoffInitial) on the clean-close path too rather than reconnecting immediately. Also add a real-server (or accurately-modeled) test where an idle reconnect closes immediately, to catch the loop.

<details><summary>Evidence</summary>

CONFIRMED — the TUI hot-reconnects against the real server during all idle time between turns; the audit's M4 fix landed for `sov drive` but its explicitly-named TUI sibling was left unfixed.

Mechanism, verified end-to-end at HEAD:

(1) TUI opens a NON-follow stream — app.go:845: `streamURL := fmt.Sprintf("%s/sessions/%s/events", m.baseURL, m.sessionID)` (no `?follow=true`). So it inherits the per-turn-close contract.

(2) Cursor advances to the terminal seq — app.go:1466-1468 sets `m.sseCursor` from every event including `turn_complete`; startSSE passes it as Last-Event-ID — app.go:846 `m.events, m.errs = transport.Consume(cctx, streamURL, m.sseCursor)` → sse.go:45-47 `if lastEventID > 0 { req.Header.Set("Last-Event-ID", ...) }`. The cursor is NOT reset (session unchanged, app.go:841 condition false).

(3) Clean close reconnects with ZERO delay — app.go:1545-1549:
```
if msg.err == nil {
    m.sseBackoff = 0
    var c tea.Cmd
    m, c = m.startSSE()
    return m, m.respond(c)
}
```
`respond` (app.go:321-330) adds no delay. The audit's FIX 2 backoff (app.go:1555-1571) applies ONLY to the `msg.err != nil` path.

(4) Server ends the idle reconnect immediately AND cleanly — events.ts:131-134:
```
const replayedCount = queue.length;
if (!follow && replayedCount === 0 && !bus.isTurnActive()) {
    stopped = true;
}
```
After turn_complete, eventBus.ts:188-190 sets `this.turnActive = false`; a Last-Event-ID past the terminal seq makes subscribe replay `ring.filter(ev => ev.seq > lastEventId)` empty (eventBus.ts:224) → replayedCount===0 → stopped=true → stream returns HTTP 200 (headers already flushed at events.ts:93 `: connected`). The bus is NOT disposed on close (events.ts:199-204, Phase B T3), so it persists with turnActive=false for the whole idle period.

Loop: TUI sees sseDoneMsg{err:nil} → step (3) → server step (4) → clean close → sseDoneMsg{err:nil} → ... a tight loop of full HTTP GETs to /sessions/:id/events at loopback-round-trip cadence for the entire between-turns idle (up to the 30-min supervisor eviction). Each iteration does a getSession + ownership check (events.ts:73 loadOwnedSession) + bus subscribe/unsubscribe.

INCOMPLETE-FIX proof: the 2026-06-10 audit's M4 ("sov drive busy-loops ~45 reconnects/sec whenever no turn is active") states verbatim: "The Go TUI shares this reconnect pattern with NO pause; worth a sibling check," and recommends "Use `?follow=true` ... or add exponential backoff when a connection ends having delivered zero events." `sov drive` was fixed exactly that way — driveCommand.ts:154-161 and 356 now open a persistent `?follow=true` stream and reconnect only on session pivot. The TUI sibling did NOT receive this fix — it still opens a non-follow stream and reconnects immediately on clean close.

Test-blind-spot confirmed: TestApp_reconsumesSSEAfterTurnComplete's mock holds the post-turn idle reconnect open with `<-r.Context().Done()` (app_test.go:1141, the `default:` case), diverging from the real server which closes it immediately. The cadence assertion `got < 2 || got > 3` (app_test.go:1197-1199) therefore passes and never exercises the immediate-close idle reconnect, so the loop is unguarded.

Severity high (not medium): unlike the drive perf finding, this is the interactive human-facing surface and triggers during every idle window (the user reading the last reply), pegging a CPU core + flooding server logs + draining battery on the core path of every session. Not a correctness/security breach (conversation still functions), hence high not critical. Genuinely residual/incomplete, not a re-derivation of an already-fixed bug; suggested fix (a) `?follow=true` like drive, or (b) a min reconnect delay on the clean-close path, plus a real-server-accurate test, is correct.

</details>

### F10. src/agent/sessionDb.ts:392 — `high` · bug · CONFIRMED · _unsure_ · area:sweep-unchanged

**Summary.** Audit H14 (unbounded IN(...) bound-param limit in session cleanup) was NEVER fixed — cleanupOldCronSessions still builds an unbounded placeholder list and crashes boot in a loop once enough old cron sessions accumulate.

**Failure scenario.** The audit flagged H14 at sessionDb.ts:393 with the suggested fix 'delete via correlated subquery ... or chunk ids into <32k batches.' The ONLY post-audit commit touching this file (b7a745a) added listRoutingAtomsAllByOwner; the cleanup functions are byte-unchanged from the audit baseline. cleanupOldCronSessions (line 382-399) selects ALL cron sessions older than 30 days, then does `const placeholders = ids.map(() => '?').join(','); this.db.run('DELETE FROM messages WHERE session_id IN (' + placeholders + ')', ids)` plus `DELETE FROM session_compactions WHERE parent_session_id IN (...) OR child_session_id IN (...)` with `[...ids, ...ids]` (2x the params). This runs UNCONDITIONALLY at every runtime boot (src/server/runtime.ts:1071) with no surrounding try/catch. I reproduced the crash with bun:sqlite: 70,000 ids (a cron job firing every minute for ~49 days, per the function's own '~43k rows/month' comment) → `DELETE FROM messages WHERE session_id IN (...)` throws `SQLite query expected 4464 values, received 70000`; the session_compactions DELETE (doubled params) crashes at just ~32,768 ids (~23 days). writeWithRetry only retries isBusyError, so this non-busy error throws straight through to buildRuntime boot → the harness becomes unbootable and re-crashes on every restart (the same backlog re-selects every boot).

**Suggested fix.** Apply the audit's recommended fix that was never landed: replace the IN(placeholders) deletes with a correlated subquery — `DELETE FROM messages WHERE session_id IN (SELECT session_id FROM sessions WHERE json_extract(metadata,'$.kind')='cron' AND created_at<?)` (binds 1 param, like cleanupPhantomReviews already does at line 355-359), and likewise for session_compactions and the final sessions delete — OR chunk ids into batches of <32,000 (well under the 65,535 single-IN ceiling and the ~32,768 doubled ceiling). Same change needed in cleanupOldChannelSessions (see separate finding).

<details><summary>Evidence</summary>

Audit H14 (sessionDb.ts:393, "edge", conf 0.6) was flagged but its fix was NEVER landed — a genuine residual/incomplete-fix bug, not a re-derivation. PROOF the fix is absent: the only post-audit commit touching src/agent/sessionDb.ts is b7a745a (a Wave-3 multi-user fix that only ADDED listRoutingAtomsAllByOwner); `diff` of cleanupOldCronSessions at f661f24 vs HEAD reports IDENTICAL. Wave 6 (which owned sessionDb.ts in the resolution plan) never executed the H14 fix.

Offending lines at HEAD (src/agent/sessionDb.ts:391-399, twin at 433-441):
  391  const placeholders = ids.map(() => '?').join(',');
  392  this.db.run(`DELETE FROM messages WHERE session_id IN (${placeholders})`, ids);
  393-397  this.db.run(`DELETE FROM session_compactions WHERE parent_session_id IN (${placeholders}) OR child_session_id IN (${placeholders})`, [...ids, ...ids]);
The session_compactions delete binds 2x ids.

EMPIRICALLY REPRODUCED in bun:sqlite: 70,000 single ids -> `THROW: SQLite query expected 4464 values, received 70000` (exactly the finder's repro; 70000 mod 65536 = 4464). The doubled-param session_compactions delete crashes at 32,768 ids (= 65,536 params): `received 65536`. (Finder's "65,535 single-IN ceiling" is off by one — actual wrap is at 65,536 total params — but immaterial; the doubled delete at 32,768 ids is the binding constraint.)

UNCONDITIONAL, UNGUARDED BOOT CALL: src/server/runtime.ts:1071 `const cronSessionsCleaned = sessionDb.cleanupOldCronSessions();` and 1079 `cleanupOldChannelSessions()` — verified NO try/catch wraps lines 1064-1085. writeWithRetry rethrows non-busy errors: line 928 `if (!isBusyError(err) || i === MAX_RETRIES - 1) throw err;`, and isBusyError matches only SQLITE_BUSY/SQLITE_LOCKED — a bound-param overflow propagates straight through buildRuntime -> harness unbootable, re-crashing every restart (the same backlog re-selects each boot).

ACCUMULATION PREMISE HOLDS: cron mints one kind:'cron' row per run (src/cron/wiring.ts:200-205; ~43k rows/month per the function's own comment). A per-minute job crosses the doubled-delete 32,768-id ceiling after ~23 days of rows older than the 30-day window (~53 days uptime). buildRuntime is the boot path for gateway/serve/TUI/drive, so the run-anywhere gateway with cron or channels is exactly the trigger context.

Severity high (not critical): a self-inflicted boot crash-loop on the documented long-uptime gateway deployment, gated behind long uptime + cron/channel volume — a real operational bug that bricks the harness, but not a security-boundary breach or cross-user leak.

</details>

### F11. src/agent/sessionDb.ts:433 — `high` · bug · CONFIRMED · _post-audit-feature_ · area:sweep

**Summary.** cleanupOldChannelSessions (post-Phase-F F6 feature) copies the same unbounded `IN (${placeholders})` pattern as the still-unfixed cron sweep (confirmed #44), binding 2×N variables for the session_compactions delete — it runs at every gateway boot and the row accumulation it cleans is driven by UNTRUSTED channel senders.

**Failure scenario.** Channel sessions are minted per-(channel,sender) with deterministic colon-ids that are reused forever and are NOT REST-deletable (the function's own docstring). Over months of real channel traffic — or a flood of distinct untrusted Slack/Telegram/webhook/SMS senders, each minting a `kind:'channel'` session row — thousands of idle channel sessions accumulate. Once enough age past the 30-day window, cleanupOldChannelSessions runs at boot (src/server/runtime.ts:1079) and builds `DELETE FROM session_compactions WHERE parent_session_id IN (?,?,...) OR child_session_id IN (?,?,...)` bound with `[...ids, ...ids]` (line 439) = 2N parameters. When 2N exceeds SQLite's SQLITE_MAX_VARIABLE_NUMBER (32766 on modern builds → N≈16383; 999 on older → N≈499), the statement throws `too many SQL variables`, which propagates out of buildRuntime and crashes the gateway boot. Because the cleanup that would shrink the backlog is exactly what crashes, every subsequent boot crashes the same way — a self-perpetuating boot-DoS, reachable by channel-sender-driven row accumulation. Confirmed #44 names only cleanupOldCronSessions; this is its post-audit channel twin (the more reachable one, since channel rows are sender-driven and never REST-deletable).

**Suggested fix.** Batch the id list into chunks well under the variable limit (e.g. 500) and issue the DELETEs per chunk inside the existing writeWithRetry transaction, for BOTH cleanupOldChannelSessions and cleanupOldCronSessions (#44). For the doubled session_compactions clause, batch on N/2 or run the parent_session_id and child_session_id deletes as two separate single-bind statements per chunk.

<details><summary>Evidence</summary>

VERIFIED PRESENT AT HEAD. src/agent/sessionDb.ts:433-440 (cleanupOldChannelSessions) builds an unbounded parameter list and binds 2×N for the doubled clause:

  const placeholders = ids.map(() => '?').join(',');                           // line 433
  this.db.run(`DELETE FROM messages WHERE session_id IN (${placeholders})`, ids);
  this.db.run(
    `DELETE FROM session_compactions
       WHERE parent_session_id IN (${placeholders})
          OR child_session_id IN (${placeholders})`,                           // lines 436-438
    [...ids, ...ids],                                                          // line 439 — 2N params
  );

The twin cleanupOldCronSessions (lines 391-398) has the byte-identical pattern. Both run UNGUARDED at gateway boot inside buildRuntime: src/server/runtime.ts:1071 (cron) and :1079 (channel). No try/catch wraps either call, so a thrown 'too many SQL variables' / Bun's 'expected 0 values, received 65536' propagates out of buildRuntime and crashes the boot. Because the sweep that would shrink the backlog is what throws, every subsequent boot re-throws → self-perpetuating boot-DoS.

REACHABILITY confirmed: src/channels/sessionKey.ts buildSessionKey = `agent:main:${channel}:${chatType}:${chatId}[:${threadId}]` and src/channels/pipeline.ts:179-186 upsertSession with metadata {kind:'channel'} — minted per-(channel,sender/thread), sender-derived (untrusted), reused forever, and (per the function's own docstring, lines 404-408) NOT REST-deletable. So row accumulation is genuinely driven by untrusted channel senders.

CANDIDATE FRAMING CORRECTION (why duplicate_of_audit=FALSE, not TRUE): The candidate calls this a 'post-Phase-F F6 feature' twin of a 'still-unfixed cron sweep (#44)' that the audit 'missed' (naming only cron). That framing is inaccurate but the bug is real and unfixed. The 2026-06-10 audit finding H14 (docs/07-history/audits/2026-06-10-full-codebase-audit.md:159) EXPLICITLY names BOTH: 'cleanupOldCronSessions (and the twin cleanupOldChannelSessions) ... The session_compactions delete binds 2x ids. Bun's prepared-statement parameter count wraps at 65536 ... boot crash loop.' Its suggested fix: 'Delete via correlated subquery ... or chunk ids into <32k batches.' So the audit FOUND it. Critically, the fix NEVER SHIPPED: `git diff f661f24..HEAD -- src/agent/sessionDb.ts` shows only +26 lines (the unrelated listRoutingAtomsAllByOwner Phase-E helper, commit b7a745a); the cleanup functions are byte-identical to baseline. No chunk/batch/subquery helper exists at HEAD (grep confirms). This is therefore an INCOMPLETE/UNSHIPPED audit fix (residual issue, reviewer category c) — a currently-present, exploitable-by-untrusted-sender boot-DoS, NOT code already correctly handled and NOT a deferred-by-design item.

SEVERITY: high (independent re-rating). Availability boot-DoS reachable by untrusted channel senders. Not critical because it is not RCE/data-leak/cross-user-breach, the crash needs significant accumulation (the doubled session_compactions clause throws at 2N>32766 ⇒ N≈16,383 channel rows aged >30d on a modern SQLite; or N≈499 on a legacy 999-var build), and it requires tens of thousands of distinct aged senders/threads. The candidate's binding/line analysis (2N at line 439, crash propagating from runtime.ts:1079) is precisely correct; the #44/'missed by audit'/'F6 feature' attribution is the only inaccurate part.

</details>

## MEDIUM

### F12. src/tools/WebFetchTool.ts:165 — `medium` · perf · CONFIRMED · _introduced-by-fix_ · area:sec-ssrf

**Summary.** The per-hop DNS lookup (assertResolvedHostPublic) is not covered by the request AbortController/timer; node:dns/promises lookup() takes no AbortSignal here, so the documented 10s TIMEOUT_MS bounds only the fetch, not resolution. Same in references.ts:146 with its 10_000ms timer.

**Failure scenario.** A hostile/slow authoritative DNS server stalls each A/AAAA resolution up to the OS resolver timeout. With up to 5 redirect hops each triggering a fresh guard lookup, total turn latency can far exceed the advertised 10s cap, tying up a channel/turn worker. The timer aborts controller.signal (fetch) but the lookup at the loop top runs to resolver completion regardless.

**Suggested fix.** Bound the lookup with Promise.race against a timeout (or use a resolver wrapper honoring controller.signal), and treat the timeout as a block (fail-closed) on the channel-reachable path.

<details><summary>Evidence</summary>

CONFIRMED, but I re-rate medium (finder said low/perf) and it is genuinely new — `src/tools/ssrfGuard.ts` did NOT exist at baseline f661f24 (`git diff f661f24..HEAD` shows it as a new file). This is a residual gap left by the audit's own SSRF fix, not a re-derived already-fixed bug.

The DNS guard is unbounded by the request timer:
- ssrfGuard.ts:118-135 `assertResolvedHostPublic(...)` calls `await lookupImpl(host, { all: true })` (line 125). The `LookupImpl` type (lines 17-20) is `(hostname, opts: { all: true }) => Promise<...>` — it accepts NO AbortSignal, and none is passed. The default impl is `node:dns/promises lookup` (line 13), which uses getaddrinfo and does not honor an AbortSignal anyway.
- WebFetchTool.ts: the controller/timer is wired ONLY into fetch: `const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)` (line 151) and `controller.signal` is passed solely to `fetchImpl(currentUrl, { signal: controller.signal, ... })` (line 169). The guard at line 165 (`await assertResolvedHostPublic(new URL(currentUrl).hostname, lookupImpl)`) runs at the top of the loop BEFORE the fetch and is not covered by the timer. TIMEOUT_MS=10_000 (line 17), REDIRECT_CAP=5 (line 18), so up to 6 unsignaled lookups per call.
- context/references.ts (the finder's cited file lives here, not learning-layer): `const timer = setTimeout(() => controller.abort(), 10_000)` (line 139); the guard at line 146 is unsignaled; controller.signal only feeds `fetchImpl(currentUrl, { signal: controller.signal, redirect: 'manual' })` (line 149).

Reachability is real on the untrusted path: WebFetch is `isReadOnly: () => true` (line 127), is NOT listed in SUBAGENT_EXCLUDED_TOOLS (src/agents/exclusions.ts:20-35 — only AgentTool/cron_*/task_stop/send_message), survives the channel filter (channels/pipeline.ts:210 filters against that set), and channel permission posture allows read-only tools (channels/permission.ts:15-16 comment: 'read-only / permissionless tools ... still run'). A channel sender controls the `url` arg → controls the resolved hostname → can point at a hostile authoritative DNS server that stalls each A/AAAA resolution. @url references run on the gateway server path too (references.ts:126-129 comment).

Why medium, not high/low: the 10s documented cap demonstrably bounds only fetch, not resolution — a real contract gap reachable by an untrusted channel sender, so it crosses past low. But practical blast radius is bounded by the OS resolver's own timeout (resolv.conf timeout/attempts, ~5-30s per lookup) and by per-message turn semantics, not truly unbounded — a single turn can be stretched to roughly a minute, tying up a turn/poll worker, but it is not an amplification DoS or a clean security-boundary breach. Fix as suggested (Promise.race the lookup against a timeout, fail-closed on the channel path).

</details>

### F13. src/learning/paths.ts:46 — `medium` · security · CONFIRMED · _missed-by-audit_ · area:leak-redaction

**Summary.** FIX 4 (audit 2026-06-10 path-traversal hardening) validates the project_id segment at the projectRoot chokepoint but leaves instinctId unvalidated; instinctPath appends `${instinctId}.md` raw, so an LLM/synthesizer-supplied id traverses out of the learning dir.

**Failure scenario.** InstinctViewTool / InstinctUpdateConfidenceTool accept `id: z.string().min(1)` (only non-empty) and pass it to store.readWithBody(project_id, id) -> instinctPath(home, projectId, instinctId, userId) -> join(instinctsDir(...), instinctId + '.md'). project_id IS now validated by FIX 4, but instinctId is not. Demonstrated: instinctPath('/Users/julie/.harness','abcdef0123456789','../../../../../../tmp/secret') => '/tmp/secret.md' (escapes the learning dir to an arbitrary read), and with userId='bob', id='../../alice/learning/abcdef0123456789/instincts/20260610-real' => reads alice's instinct file (within-org cross-user instinct read). The read succeeds only when the target parses as an instinct .md, so it is a constrained arbitrary-read / cross-principal-instinct-leak rather than full file exfiltration. The synthesizer LLM picks `id`, and its choices are influenced by observation content (which in channel sessions reflects untrusted sender input), making the traversal reachable via indirect prompt influence. Reads only (write path uses the on-disk frontmatter id, not the supplied id, so write-traversal is not reachable).

**Suggested fix.** Add an instinctId safe-segment validator (mirror validateProjectId) and call it in instinctPath (the single chokepoint all read/write builders flow through), or tighten the tool input schemas (InstinctViewInputSchema.id / InstinctUpdateConfidenceInputSchema.id) to `/^[A-Za-z0-9_-]+$/`. This closes the same class FIX 4 targeted ('a traversal value can never reach join') for the second path segment it missed.

<details><summary>Evidence</summary>

PATH-LEVEL BUG IS REAL (residual of FIX 4). src/learning/paths.ts:58-65 `instinctPath` appends the id raw with NO validation: `return join(instinctsDir(harnessHome, projectId, userId), `${instinctId}.md`);`. FIX 4 (git diff f661f24..HEAD) added `validateProjectId(projectId)` at the `projectRoot` chokepoint (paths.ts:46) and its own comment (paths.ts:43-45) claims it is "the single chokepoint every learning path builder (observationsPath, instinctsDir, instinctPath, ensureLearningDirs) flows through ... so a traversal value can never reach `join`." That claim is false for the SECOND segment: instinctPath joins `instinctId` AFTER projectRoot, so an `instinctId` of `../../../../../../tmp/secret` resolves to `/tmp/secret.md`. The tool input schemas only enforce non-empty: InstinctViewTool.ts:11 `id: z.string().min(1)` and InstinctUpdateConfidenceTool.ts:14 `id: z.string().min(1)`. InstinctStore.read/readWithBody/remove (instinctStore.ts:47,54,76) all forward the supplied id straight into instinctPath. This is a genuine incomplete-fix residual, NOT an already-correct guard nor a deferred known-open item → duplicate_of_audit=FALSE.

REACHABILITY — FINDER OVERSTATES, real path is narrower. `instinct_view`/`instinct_update_confidence` are NOT in the main agent's tool pool: assembleToolPool (registry.ts:123-145) merges only `REGISTERED_TOOLS + mcpTools`. LEARNING_ONLY_TOOLS (registry.ts:95-100) is injected ONLY into the synthesizer sub-agent (synthesizer.ts:65 `[...opts.parentToolPool, ...LEARNING_ONLY_TOOLS]`) and the review-fork (fork.ts:80-84) — both TRUSTED, harness-authored prompts. A channel sender NEVER directly holds these tools, so the finder's lead framing (tool-input-schema-driven direct reach) is misleading. The only live trigger is SECOND-ORDER: channel turns DO feed the learning loop (pipeline.ts:223 "a channel turn participates in the learning loop"), so untrusted sender text lands in observations.jsonl which the synthesizer later reads (synthesizer prompt step 1: "Read the recent observations"), enabling indirect prompt-injection of a traversal `id` into instinct_view. The read is CONSTRAINED: parseInstinct (instinctSerde.ts) requires the target to match FRONTMATTER_RE and pass `InstinctSchema.parse`, so it leaks only instinct-shaped YAML files, not arbitrary content. The write path is NOT traversable — InstinctUpdateConfidenceTool builds `updated` from `prior` (read off disk) and write() uses `instinct.id` (the on-disk frontmatter id), not `input.id`; only the preceding readWithBody(input.project_id, input.id) at InstinctUpdateConfidenceTool.ts:47 is traversable. Cross-user (`userId='bob'`, id=`../../alice/learning/.../instincts/<real>`) is a within-org cross-principal instinct read.

SEVERITY = MEDIUM: not directly channel-reachable (trusted synthesizer/review-fork LLM only; reachable solely via second-order prompt influence), constrained to instinct-shaped reads, write not affected, and the cross-user leak falls under the explicitly within-org (non-hostile) trust model where such a leak is at most MEDIUM. Above LOW because it is a real residual of a SECURITY-LOAD-BEARING fix whose comment claims to cover instinctPath. Suggested fix is sound: add an instinctId safe-segment validator inside instinctPath (the read/write chokepoint) or tighten both tool schemas to /^[A-Za-z0-9_-]+$/.

</details>

### F14. src/server/sessionContext.ts:389 — `medium` · bug · CONFIRMED · _introduced-by-fix_ · area:multiuser

**Summary.** Per-session /effort (#57) silently reverts to the boot default whenever a turn triggers compaction, because the compaction child's SessionContext is rebuilt and re-seeded `effort: runtime.effort`. The TUI then pivots to that child as the active session, so the revert persists for the rest of the conversation — a mid-conversation degradation the pre-fix global runtime.effort did not have.

**Failure scenario.** User runs `/effort high` on session A → setEffort sets sessionCtx_A.effort='high', and turns run at 'high'. Later a long turn crosses the proactive-compaction threshold (auto, ~75% context) OR overflows OR the user runs `/compact`. turns.ts:587/891 (and compact.ts) pivots: `sessionId = result.newSessionId; sessionCtx = runtime.getSessionContext(newChildId)`. buildSessionContext seeds the child with `effort: runtime.effort` (still the boot default 'off' — setEffort never touches runtime.effort post-fix). The compaction-retry run within that same turn, and EVERY subsequent turn on the now-active child id, read sessionCtx.effort='off'. The user's explicitly-requested reasoning depth is silently dropped with no notification, in exactly the long sessions where they'd have raised it. Note this is now ASYMMETRIC with /model, whose setModel still mutates the global runtime.model and therefore survives compaction.

**Suggested fix.** On the compaction pivot, carry the parent's effort onto the child SessionContext (e.g. after `sessionCtx = runtime.getSessionContext(newSessionId)` in both turns.ts hops and compact.ts, copy the prior context's effort), or persist effort on the session DB row (like updateSessionModel) and seed buildSessionContext from `getSession(sessionId)?.effort ?? runtime.effort` so a compaction child / idle-rebuild inherits it. The code comment at sessionContext.ts:124-126 frames this as 'acceptable for a UX-depth dial,' but it understates that the revert is silent, mid-conversation, automatic, and conversation-durable — not merely an across-restart reset.

<details><summary>Evidence</summary>

Every load-bearing link verified at HEAD:

1. `/effort` mutates ONLY the per-session context, never the global boot default — src/server/commandContext.ts:188-191: `setEffort: (level) => { sessionCtx.effort = level; sideEffects.effortChanged = level; }`. It does NOT touch `runtime.effort`.

2. The compaction child gets a FRESH SessionContext seeded with the untouched boot default. turns.ts re-fetches on every compaction hop: line 582-587 (proactive) `sessionId = result.newSessionId; ... sessionCtx = runtime.getSessionContext(sessionId);` and line 888-891 (overflow-recovery retry, in-turn) likewise. `getSessionContext` (runtime.ts:1335-1342) builds a brand-new context for an unseen id via `sessionContextFactory` → `buildSessionContext`, whose seed is src/server/sessionContext.ts:389 `effort: runtime.effort` — the boot default 'off', which `/effort` never updates (runtime.ts:304-312 documents `runtime.effort` is "NOT mutated by /effort").

3. The query() call reads the (re-fetched child) context's effort — turns.ts:702 `effort: sessionCtx.effort`. So the compaction-retry run within the same turn AND every subsequent turn execute at the dropped boot default.

4. The pivot is conversation-durable, not turn-local. The Go TUI sets its active session id to the child on the compaction event — packages/tui/internal/app/app.go:2218 `m.sessionID = cc.ActiveSessionID` (test app_test.go:802-803 pins "subsequent turns POST hit the new child"). So all later turns target the child id whose context carries effort='off'.

5. The asymmetry with /model is real: setModel (commandContext.ts:175-178) does `runtime.model = model;` (global), and query() reads `model: runtime.model` (turns.ts:696) — so model survives compaction while effort does not.

A broad grep confirms NO code carries the parent's effort onto the child and NO DB persistence of effort exists (the only effort assignments are commandContext.ts:189, sessionContext.ts:389, and the cron/channel boot-default reads). Triggers: proactive ~threshold compaction, in-turn overflow recovery, and the user-driven /compact route — all three pivot via publishCompactionComplete + getSessionContext(child).

The source comment at sessionContext.ts:124-126 acknowledges the reset ("Resets to the boot default when the session context is rebuilt ... acceptable for a UX-depth dial") but understates it: the revert is silent (no user notification), automatic, mid-conversation, and conversation-durable — not merely an across-restart reset, and it lands precisely in the long sessions where a user raised effort.

This is a genuine RESIDUAL gap left by the #57 fix (which made effort per-session) — not a re-derivation of an already-fixed audit bug, and distinct from known-open #58 (runtime.model being global, the opposite axis). Severity medium per the rubric: a local/within-org correctness/contract-drift defect that real users will hit in long sessions; no security-boundary breach or cross-user leak. The candidate's MEDIUM rating stands.

</details>

### F15. src/providers/credentials/pool.ts:182 — `medium` · consistency · CONFIRMED · _introduced-by-fix_ · area:providers

**Summary.** persist() merge only guards OTHER providers' rows; concurrent same-provider updates from another process (the exact 'two gateways' case the comment claims to handle) are still clobbered by this pool's stale boot snapshot.

**Failure scenario.** The M28 merge re-reads disk but then does `merged.credentials[this.provider] = ours` (line 190), wholesale replacing this provider's sub-map with `this.state` (a boot-time snapshot plus this pool's own mutations). The comment at line 184 explicitly names 'two gateways' as a case it fixes — but two gateways share the same provider, so they still clobber. Demonstrated: process A boots + select()s cred 'slot' (status ok); process B marks the same slot `exhausted` (writes disk); process A finishes its long turn and calls markOk('slot') → its stale in-memory map (status ok) overwrites B's fresh `exhausted` marker on disk, leaving status 'ok', cooldownUntil null. The clobber window equals a full turn duration (markOk in wrapWithProviderHardening runs only after the stream completes — resolver.ts:270). Net effect: a credential another process correctly locked out for rate-limit/auth gets silently re-marked usable, re-amplifying the very 429/401 the lockout was meant to prevent.

**Suggested fix.** Merge at the credential-row granularity, not the provider-map granularity: start from the disk's provider sub-map and overlay only the credential ids this pool actually touched this call (the selected/marked id), preserving rows another process wrote. Alternatively read-modify-write under a file lock (sessionDb already does lock-based contention handling) so a mark from one process isn't lost to another's stale snapshot.

<details><summary>Evidence</summary>

The code at HEAD says exactly what the finder claims. `persist()` (src/providers/credentials/pool.ts:182-192):

  const disk = readState(this.path);
  const merged: StateFile = { credentials: { ...(disk.credentials ?? {}) } };
  const ours = this.state.credentials?.[this.provider] ?? {};
  if (merged.credentials) merged.credentials[this.provider] = ours;   // line 190
  writeStateAtomic(this.path, merged);

The merge re-reads disk only to preserve OTHER providers' submaps, then overwrites THIS provider's submap wholesale with `ours`. `this.state` is a boot-time disk snapshot taken once in the constructor (line 82: `this.state = readState(this.path)`) and thereafter mutated ONLY by this pool's own select/mark* calls — it is never re-synced from disk for this provider's rows. So any same-provider credential row another process wrote since boot is discarded.

The comment at line 183-186 explicitly names "two gateways" as a case the merge fixes — but two gateways run the SAME provider, so they hit the wholesale-replace path and clobber each other. The fix is provably incomplete: it guards different-provider rows, not same-provider rows.

Concrete demonstrated clobber (matches the finder's scenario):
- Process A boots → `select()` (line 116-130) sets a credential's in-memory status to 'ok', cooldownUntil null, persists.
- Process B marks the SAME credential `exhausted` (markExhausted, line 142-150) on disk with a cooldownUntil.
- Process A finishes its turn → `markOk(id)` (line 132-140) mutates A's stale in-memory row (still 'ok'), then `persist()` re-reads disk (sees B's 'exhausted'), but `merged.credentials[provider] = ours` (line 190) overwrites the whole submap with A's snapshot → B's 'exhausted'/cooldownUntil is lost, status back to 'ok', cooldownUntil null. The lockout B installed to stop a 429/401 is silently erased.

Timing window is real: `markOk` runs only after `transport.stream` completes (src/providers/resolver.ts:270 in wrapWithProviderHardening), i.e. after a full streamed turn. The CredentialPool is constructed in resolveProvider (resolver.ts:167) and held for the session lifetime, so its snapshot is stale for the whole session, not just one turn. The clobber also reproduces WITHIN one gateway process: each session-level buildRuntime calls resolveProvider (server/runtime.ts:940), so two concurrent sessions on the same provider each get a separate CredentialPool with its own boot snapshot pointed at the same credentials.json.

The test suite confirms the gap: tests/providers/credentials.test.ts:97-133 covers ONLY 'interleaved persists for different providers do not clobber each other'. There is no same-provider concurrent test. This is a residual/incomplete-fix issue from audit commit 30e788b (git diff f661f24..HEAD shows the merge was added by that audit fix), not a re-derivation of an already-fixed bug and not a known-open deferred item.

Severity medium (not higher): the effect is bounded — re-amplifying the same 429/401 the lockout was meant to prevent — and self-corrects on the next mark; it requires concurrent processes/sessions sharing credentials.json plus a turn-length race. It does not cross to untrusted channels, leak data, or lose user data; the separate file-based RateLimitGuard still throttles. Correct fix is row-granularity merge (overlay only the touched credential ids onto the disk submap) or a read-modify-write under a file lock.

</details>

### F16. src/providers/credentials/rateGuard.ts:111 — `medium` · bug · CONFIRMED · _missed-by-audit_ · area:providers

**Summary.** OpenAI's native rate-limit reset headers use Go-duration format ('6m0s', '1.5s', '880ms') which parseResetHeader cannot parse, so real OpenAI 429 reset windows are dropped and the guard under-waits at the 60s no-header floor.

**Failure scenario.** resetTimeFromHeaders checks `x-ratelimit-reset-requests` (line 111) and the newly-added generic `x-ratelimit-reset` (line 115), both via parseResetHeader. OpenAI emits these as Go duration strings, e.g. `x-ratelimit-reset-requests: 6m0s`. parseResetHeader (line 131): `Number('6m0s')` is NaN, then `Date.parse('6m0s')` is NaN → returns null. retry-after is typically absent on OpenAI chat 429s, so resetTimeFromHeaders returns null and markRateLimited falls to the no-header base of 60s even when OpenAI signalled a multi-minute window. The harness then re-hits the provider after 60s while still limited, amplifying retries — the exact harm the rate guard exists to prevent. (The new x-ratelimit-reset line in the M29 diff doesn't help OpenAI because the value is still duration-format.)

**Suggested fix.** Extend parseResetHeader (or add a sibling) to parse Go-duration strings: match `(\d+(\.\d+)?)(ms|s|m|h)` segments and sum to seconds, returning now + total. This makes the OpenAI reset headers (and the generic x-ratelimit-reset) actually honored instead of silently dropped to the 60s floor.

<details><summary>Evidence</summary>

VERIFIED against current HEAD code in src/providers/credentials/rateGuard.ts.

The parser cannot handle Go-duration strings. parseResetHeader (lines 131-142):
  const numeric = Number(trimmed);            // Number('6m0s') -> NaN
  if (Number.isFinite(numeric)) { ... }       // false, skipped
  const date = Date.parse(trimmed);           // Date.parse('6m0s') -> NaN
  return Number.isFinite(date) ? date / 1000 : null;   // -> null

resetTimeFromHeaders (line 111) reads OpenAI's `x-ratelimit-reset-requests` through this same parser:
  const reset = parseResetHeader(getHeader(headers, 'x-ratelimit-reset-requests'), now);

OpenAI's documented rate-limit reset headers (x-ratelimit-reset-requests / x-ratelimit-reset-tokens) are Go-duration formatted strings, e.g. `6m0s`, `880ms`, `1.5s`, `1s`. Every such value yields NaN from both Number() and Date.parse(), so parseResetHeader returns null. The generic `x-ratelimit-reset` lookup added in the post-audit diff (line 115) does NOT help OpenAI — same value, same parser. `retry-after` is commonly absent on OpenAI chat 429s, so resetTimeFromHeaders returns null entirely.

markRateLimited (line 78) then falls to the no-header floor:
  const exhaustedUntil = fromHeaders ?? now + this.noHeaderCooldownSeconds(now);
with NO_HEADER_BASE_COOLDOWN_SECONDS = 60 (line 38). So a real OpenAI 429 that signalled a 6-minute window via x-ratelimit-reset-requests=6m0s is throttled to only 60s in beforeRequest — the harness re-hits the still-limited provider after a minute, amplifying retries, the exact harm the guard exists to prevent.

OpenAI is a first-class registered provider (PROVIDER_REGISTRY.openai -> https://api.openai.com/v1, models.ts:22-29) whose 429s throw ProviderHttpError with response.headers (openai.ts:224-229), routed to guard.markRateLimited(err.headers, ...) (resolver.ts:274). So the path is real and reachable.

Not a duplicate / not already-fixed: the f661f24..HEAD diff only ADDED the generic `x-ratelimit-reset` lookup (for OpenRouter) and the no-header backoff growth; it added NO Go-duration parsing. The inline comment at line 113-114 even claims the parser 'already disambiguates' formats, overlooking duration strings. Tests at tests/providers/credentials.test.ts:141 only cover the bare-numeric form ('20'), never OpenAI's actual duration format — so the gap was never under test.

Severity medium (not high): the noHeaderCooldownSeconds growth path (lines 87-95) doubles the backoff on immediate repeat 429s (60s->120s->..., capped 15m), so it ramps toward the real window via trial-and-error rather than honoring the explicit signal — partial mitigation. It's an intermittent rate-limit-path resilience degradation, not a crash/data-loss/security/cross-user-leak. Matches the finder's rating.

</details>

### F17. src/router/provider.ts:122 — `medium` · bug · CONFIRMED · _unsure_ · area:router

**Summary.** M25 lane-model recovery silently breaks if /model is run in router mode, because recoverLaneModel depends on req.model still being the synthetic "local | frontier" string

**Failure scenario.** In router mode runtime.model is the synthetic display string `"qwen2.5:14b | claude-sonnet-4-6"` (built in runtime.ts:928), and the turns route passes `model: runtime.model` into query() → RouterProvider.stream's req.model. The M25 fix relies on this: when config omits a per-lane model, `delegatedModel = configuredModel ?? recoverLaneModel(req.model, lane)` splits the synthetic string to recover the real lane model. But the /model slash command (commandContext.ts:175-177 `setModel: (model) => { runtime.model = model }`) is NOT gated in router mode. If a user runs `/model claude-sonnet-4-6`, runtime.model becomes `"claude-sonnet-4-6"` (no ' | '). On the next turn recoverLaneModel("claude-sonnet-4-6", lane) → split(' | ') yields length 1 → returns '' → with no configured per-lane model delegatedModel='' → childReq passes req through unchanged, handing BOTH lanes the single literal model. If the local (ollama) lane is then chosen, the ollama provider receives model 'claude-sonnet-4-6' and the API rejects it.

**Suggested fix.** Either gate /model in router mode (refuse, or route it to set router.localModel/frontierModel), or make RouterProvider resolve each lane's model independently of req.model (e.g. fall back to the child transport's own resolved default rather than reconstructing from a synthetic string). Decoupling the lane model from the mutable process-global runtime.model is the durable fix (sibling of #58).

<details><summary>Evidence</summary>

Mechanism fully confirmed by reading current HEAD code.

ROUTER MODE MODEL STRING: runtime.ts:928 builds `model: `${localResolved.model} | ${frontierResolved.model}`` — the synthetic "<local> | <frontier>" display string.

FLOW INTO RouterProvider: turns.ts:696 `model: runtime.model` → query.ts:158-159 `provider.stream({ model, ... })` → becomes req.model in RouterProvider.stream.

THE M25 FIX (provider.ts:122): `const delegatedModel = configuredModel ?? recoverLaneModel(req.model, decision.lane);` where configuredModel is `config.localModel/frontierModel` (provider.ts:120-121). Both are schema-OPTIONAL (schema.ts:301 `localModel: z.string().optional()`, :303 `frontierModel`; router/types.ts:19/23). When a lane model is unconfigured, the fix depends entirely on recoverLaneModel splitting the synthetic string.

recoverLaneModel (provider.ts:174-179): `const parts = syntheticModel.split(SYNTHETIC_MODEL_SEPARATOR); if (parts.length !== 2) return '';` — returns '' for any non-synthetic string.

/model IS UNGATED IN ROUTER MODE: runModelPicker (pickers.ts:161-165) explicit-arg branch `if (explicit) { ctx.setModel(explicit); ... }` — no router check. ctx.setModel (commandContext.ts:175-178) `setModel: (model) => { runtime.model = model; ... }` mutates the process-global. The comment at commandContext.ts:186-187 even admits "setModel, which remains global — that sibling gap is tracked separately."

CONSEQUENCE: After `/model claude-sonnet-4-6`, runtime.model = "claude-sonnet-4-6". Next turn: recoverLaneModel("claude-sonnet-4-6", lane).split(" | ") → length 1 → returns ''. delegatedModel = undefined ?? '' = ''. provider.ts:160 `const childReq = delegatedModel ? { ...req, model: delegatedModel } : req;` → falsy '' → childReq = req unchanged (model = "claude-sonnet-4-6"). If the local lane is chosen, ollama.ts:123 `model: req.model` sends "claude-sonnet-4-6" to the Ollama API → model-not-found, turn fails.

NOT A DUPLICATE OF M25: recoverLaneModel was introduced by commit 4e09883 (verified `git merge-base --is-ancestor f661f24 4e09883` = after baseline; an audit-era fix), which is the shipped FIX for audit finding M25 (docs/07-history/audits/2026-06-10-full-codebase-audit.md:309-311). The audit's recommended DURABLE fix was "In runtime router wiring, default routerConfig.localModel/frontierModel to localResolved.model/frontierResolved.model" — i.e. always give RouterProvider a concrete lane model. The shipped fix instead reconstructs from the mutable synthetic req.model, leaving a residual that the audit's own fix would have closed. This is category (c): an incomplete fix that left a residual issue, triggered by /model mutation — distinct from the M25 base case (which is now handled in steady state).

SEVERITY medium (not higher): router mode is a local trusted single-user surface (TUI / sov drive on loopback); this is a self-inflicted correctness footgun, not a security boundary breach, and it does NOT reach channels (router mode is not channel-wired). It requires the specific combination of (router mode) + (at least one lane model unconfigured — the exact config M25 was meant to support) + (/model run) + (that lane chosen). Real and will produce hard failures, but a rare path → medium per the rubric. The candidate's medium rating is correct.

</details>

### F18. src/openai/routes/chatCompletions.ts:556 — `medium` · bug · CONFIRMED · _introduced-by-fix_ · area:openai-api

**Summary.** FIX 4 (M21) usage accumulation drops cache-read and cache-creation tokens, so prompt_tokens/total_tokens are understated on the default (cached) Anthropic path.

**Failure scenario.** FIX 4 sums only callInputTokens/callOutputTokens, set from ev.usage.inputTokens/outputTokens (lines 510-511). For Anthropic, usageToInternal (src/providers/anthropic.ts:296-306) maps input_tokens WITHOUT cached tokens — cache_read_input_tokens and cache_creation_input_tokens are separate TokenUsage fields (cacheReadInputTokens/cacheCreationInputTokens) the route never reads. Prompt caching is ON by default (cacheEnabled !== false everywhere; the route's query() call passes no cacheEnabled so it defaults true). Within a single tool-loop request, every provider call after the first is a cache hit, and a multi-turn conversation cache-reads the bulk of its context. Concrete: a request where the model reads 20k cached tokens + 300 fresh input tokens reports prompt_tokens: 300 (and total_tokens short by ~20k) — an order-of-magnitude understatement. OpenAI semantics require prompt_tokens to be the FULL input count (cached + uncached), with cached surfaced as the prompt_tokens_details.cached_tokens subset. The fix asked exactly 'incl cache-read tokens?' and the answer is no — an incomplete fix of M21.

**Suggested fix.** In the per-call usage accumulation add cacheReadInputTokens and cacheCreationInputTokens into the input total: callInputTokens should be (inputTokens ?? 0) + (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0), preserving last-seen-per-field semantics. Optionally emit prompt_tokens_details.cached_tokens = sum(cacheReadInputTokens). Verify against an Anthropic run with caching on across a tool loop.

<details><summary>Evidence</summary>

CONFIRMED — the mechanism is real and the offending lines are quoted.

Non-streaming branch usage accumulation in src/openai/routes/chatCompletions.ts reads ONLY inputTokens/outputTokens:
  line 510: `if (ev.usage.inputTokens !== undefined) callInputTokens = ev.usage.inputTokens;`
  line 511: `if (ev.usage.outputTokens !== undefined) callOutputTokens = ev.usage.outputTokens;`
flushed into totalInputTokens/totalOutputTokens, then:
  line 556: `const promptTokens = totalInputTokens;`
  line 582: `total_tokens: promptTokens + completionTokens`

The Anthropic usage_delta carries cache tokens in SEPARATE fields. usageToInternal (anthropic.ts:296-306) maps `input_tokens` → `inputTokens` but `cache_read_input_tokens` → `cacheReadInputTokens` and `cache_creation_input_tokens` → `cacheCreationInputTokens` (distinct TokenUsage fields, core/types.ts:39-44 confirms they are separate). Per Anthropic API semantics, `input_tokens` reports only the freshly-processed (non-cached) tokens; cache reads/writes are reported separately. The route never reads the two cache fields.

Corroboration that inputTokens excludes cache in this codebase's own model: pricing.ts estimateCostUsd (lines 68-77) adds inputTokens, cacheCreationInputTokens, and cacheReadInputTokens as separate additive cost components — if inputTokens already included them it would double-count. It does not.

Caching is ON by default on this path: query() is called with no cacheEnabled arg (buildQuery, lines 248-264), and the default is true (query.ts:58 `cacheEnabled = true`; anthropic.ts uses `req.cacheEnabled !== false`). Both the system prompt (systemToSdk, line 314) and the last few messages (messagesToSdk, line 334 `cacheFrom = messages.length - 3`) get cache markers. So in any multi-call tool loop, calls after the first cache-read the bulk of context: input_tokens captures only the newly-appended tool-result content while cache_read_input_tokens captures the large cached prefix — making prompt_tokens an order-of-magnitude understatement on cache-heavy turns.

This is an INCOMPLETE FIX of the post-audit FIX 4 / M21, introduced in commit d0c7369 ("usage accumulation (audit H/M)") which is part of the shipped 34b3fd6..eb827c8 wave. The fix added per-call accumulation but never accounted for cache tokens, so the current HEAD code does not handle it — category (c), residual issue. duplicate_of_audit = FALSE.

Severity: MEDIUM, not high. The `usage` object is observability/cost-tracking metadata on the `sov serve` OpenAI-compatible API, which binds to loopback (trusted single-user surface). It is not a security boundary, not a cross-user leak, not data loss, and does not affect the actual model response or tool execution. It is contract drift (understated prompt_tokens/total_tokens, missing prompt_tokens_details.cached_tokens) that will bite downstream cost-tracking consumers — a meaningful reporting inaccuracy, but non-functional and non-security, so MEDIUM rather than the finder's HIGH. Note: the streaming branch does not emit usage at all (no stream_options.include_usage support), so the bug is confined to the non-streaming branch where FIX 4 lives.

</details>

### F19. src/cron/lockUtil.ts:167 — `medium` · bug · CONFIRMED · _introduced-by-fix_ · area:cron

**Summary.** Residual check-then-reclaim TOCTOU in tryAcquireOnce: isLockStale() and reclaimStaleLock() are not atomic, so a stale lock that a third process legitimately replaces with a FRESH LIVE lock in between is blindly renamed-away and deleted, letting two processes hold the lock simultaneously.

**Failure scenario.** Pre-state: a stale `.tick.lock` (or `.jobs.lock`) exists from a crashed/SIGKILLed sov process (dead PID, or >6h-old mtime). Three+ processes share one $HARNESS_HOME (e.g. `sov gateway` cron ticker + an operator `sov cron add`/`run` in another shell). Process A's installLock collides (line 165→false); A's `isLockStale(lockDir)` returns true (line 167). Before A reaches `reclaimStaleLock` (line 172), Process C reclaims the same stale lock and installs its OWN fresh, LIVE lock at the path, then enters its critical section. A now runs `reclaimStaleLock`, whose `renameSync(lockDir, graveyard)` (line 138) SUCCEEDS on C's non-empty live lock dir (verified: rename of a non-empty dir to a new name is a move, NOT an ENOTEMPTY-protected overwrite), then rmSync deletes it. A loops to attempt=1, installLock now succeeds, A 'owns' the lock — while C still believes it owns it. Two ticks then run the same due job concurrently (duplicate agent run + duplicate channel delivery), or two jobs.json load→modify→save sequences interleave → lost update (a job silently dropped/duplicated). The fix's own comment at lines 168-171 only reasons about the case where A LOSES the reclaim rename; it never considers A winning a rename against a lock that became live after the staleness check.

**Suggested fix.** Make reclaim atomic with the staleness decision: have reclaimStaleLock re-verify ownership immediately before/after the rename — e.g. capture the stale owner PID + mtime in isLockStale, pass them to reclaimStaleLock, and after `renameSync(lockDir, graveyard)` re-read the graveyard's pid/mtime; if it no longer matches the snapshot the lock was replaced by a live holder, so move it BACK (renameSync(graveyard, lockDir)) and return false instead of deleting and reinstalling. Alternatively only reclaim a lock whose owner PID is provably dead AND re-stat confirms the same mtime. Add a concurrent-reclaim test (fresh live lock installed between the stale check and the reclaim).

<details><summary>Evidence</summary>

Genuine residual TOCTOU left by the audit fix (commit 1cbae27, which created reclaimStaleLock). In tryAcquireOnce the staleness decision and the reclaim are two non-atomic steps with no re-check between them:

  src/cron/lockUtil.ts:167  if (!isLockStale(lockDir, opts)) return false;
  src/cron/lockUtil.ts:172  reclaimStaleLock(lockDir);

isLockStale (lines 89-97) does statSync + readFileSync + process.kill — multiple syscalls — and reclaimStaleLock unconditionally renames lockDir away (line 138 `renameSync(lockDir, graveyard)`). Nothing re-verifies the lock is still the same stale dir at line 172.

The load-bearing claim — that the reclaim rename succeeds even on a fresh LIVE lock — is correct and I verified it empirically: renameSync of a NON-EMPTY dir to a NEW UNIQUE name is a move, not an ENOTEMPTY-guarded overwrite (test: a non-empty dir with a pid file renamed to a fresh name succeeded, source gone, pid preserved). installLock's ENOTEMPTY protection (line 109-112) only guards rename ONTO an existing dir; reclaim renames TO a brand-new graveyard name, so the protection does not apply.

Concrete race (pre-state: a stale `.tick.lock`/`.jobs.lock` from a SIGKILLed sov process — dead PID or >6h mtime — under one shared $HARNESS_HOME, with the in-process cron ticker plus a separate `sov cron add`/`run` process):
- A: installLock collides (165→false); isLockStale→true reading the OLD dead-PID lock (167).
- C interleaves: collides, isLockStale→true, reclaimStaleLock renames the stale dir away + deletes it (returns true), loops to attempt=1, installLock SUCCEEDS — C now holds a FRESH LIVE lock and enters its critical section.
- A resumes at 172: reclaimStaleLock(lockDir) now renames C's live lock to graveyard_A (succeeds — move to a new name) and rmSyncs it; A loops, installLock SUCCEEDS — A also holds the lock.
Two holders → two ticks run the same due job concurrently (duplicate AgentRunner run + duplicate channel delivery) or two jobs.json load→modify→save interleave (lost update), and the later releaseLock can rmSync the other holder's dir.

The fix's own comment confirms the gap — lines 168-171 only reason about A LOSING the reclaim rename ("another process reclaimed first ... the retry re-attempts the install and, if that fresh lock is live, returns false"). It never considers A WINNING a rename against a lock that became live after the staleness check, which is exactly the traced path (A's reclaim does not lose — it succeeds on the live dir, then the retry install lands on an absent path).

Not security-reachable (local single-user cron, one host/$HARNESS_HOME; not reachable by an untrusted channel sender) and gated behind a rare recovery state (a pre-existing stale lock from a crash) + a tight multi-process interleaving, so medium is the right rating: a rare-recovery-path data-integrity edge (duplicate job run / lost jobs.json update), not a mainline crash or boundary breach. The candidate did not overstate it. is_new_or_introduced = residual/incomplete-fix (not in the shipped audit, not a deferred #17/#50-54 item).

</details>

### F20. src/channels/adapters/telegram.ts:299 — `medium` · bug · CONFIRMED · _introduced-by-fix_ · area:mission-eval-channels

**Summary.** Telegram listener stop() only clears the interval; it does NOT await the in-flight pollOnce, so an in-flight channel turn can write to the session DB after runtime.dispose() closes it at gateway shutdown — the exact race the gateway shutdown comment claims is prevented.

**Failure scenario.** On `sov gateway` shutdown (SIGINT/SIGTERM), gatewayCommand.ts (line 276) awaits `listeners.stop()` BEFORE `runtime.dispose()` precisely so 'an in-flight poll can never race the DB close'. But TelegramListener.stop() is synchronous (`clearInterval(timer); timer=null`) and the H3 fix's `inFlight` is a bare boolean, not a retained Promise — stop() cannot drain it. If a poll is mid-turn (handleUpdate → runChannelTurn → sessionDb.saveMessage / disposeSession) when the signal arrives, stop() returns immediately, runtime.dispose() closes sessionDb, and the live turn's pending DB writes / trajectory / learning drain hit a closed DB. Contrast SessionSupervisor.stop() (sessionSupervisor.ts:168) which is `async` and `await this.inFlight`. The H3 fix added in-flight tracking for duplicate-prevention but left the shutdown-drain (L3/L4) gap open.

**Suggested fix.** Track the in-flight poll as a retained Promise (e.g. `let inFlight: Promise<void> | null`) and make TelegramListener.stop() async: clear the interval, then `await inFlight`. Make buildChannelListeners' stop() await each worker's stop() (it currently calls a sync `w.stop()`), matching the supervisor's drain-then-teardown contract.

<details><summary>Evidence</summary>

Verified at HEAD. (1) telegram.ts:212 declares the in-flight guard as a bare boolean — `let inFlight = false;` — added by commit 91a3dd8 ("telegram in-flight guard (audit H/M)") purely for duplicate-prevention; it is set true in pollOnce() and reset in a local `finally` (line 278), so no Promise is retained anywhere. (2) telegram.ts:299-304 `stop()` is fully synchronous: `function stop(): void { if (timer !== null) { clearInterval(timer); timer = null; } }` — it clears the interval but has no handle to await an in-flight pollOnce. (3) listeners.ts:235-237 `stop(): void { for (const w of workers) w.stop(); }` calls the sync stop and returns sync void (the type is declared `Promise<void> | void`). (4) gatewayCommand.ts:271-282 awaits `listeners?.stop()` BEFORE `runtime.dispose()` with a comment that explicitly claims this ordering means "an in-flight poll can never race the DB close" — but because stop() is synchronous, `await listeners?.stop()` resolves immediately and a mid-turn pollOnce (handleUpdate → runChannelTurn → sessionDb writes / disposeSession / learning+trace drain) keeps running into runtime.dispose()/sessionDb.close(). The comment's invariant is false. (5) The correct sibling is right there: sessionSupervisor.ts:49 retains `private inFlight: Promise<...> | null` and :168-182 `async stop()` does `await this.inFlight` to drain before the DB closes — the exact pattern Telegram is missing. Trigger: a Telegram poll must be mid-model-turn at the instant SIGINT/SIGTERM arrives; consequence is a write/drain against a closed DB during a one-shot shutdown (logged error / lost final write), not a cross-user leak, not security-boundary, not a mainline crash (process is exiting). Hence medium, and genuinely residual — the H/M audit fix added in-flight tracking for dedupe but left the shutdown-drain gap open, so current HEAD code does NOT correctly handle it.

</details>

### F21. src/config/rules.ts:60 — `medium` · consistency · CONFIRMED · _introduced-by-fix_ · area:extensions

**Summary.** MCP server-scope deny rule silently fails for any server alias containing a non-[a-zA-Z0-9_-] char — the M13 name-sanitization fix sanitized tool.name in toolWrapper.ts but left rules.ts building the server-scope match from the RAW mcpInfo.serverName, so the two diverge.

**Failure scenario.** Operator configures `"mcpServers": { "git.hub": { ... } }` (the alias key has no charset validation: z.record(z.string(), ...) in settings.ts). The server exposes tool `create_issue`. After M13, the wrapped tool.name = composeMcpToolName('git.hub','create_issue') = `mcp__git_hub__create_issue` (dot sanitized to `_`) — this is the ONLY name the user ever sees (tool list, system prompt). To blanket-deny the whole server the user naturally writes `deny: ["mcp__git_hub"]`. But ruleMatchesTool line 60 builds `mcp__${tool.mcpInfo.serverName}` = `mcp__git.hub` (raw, with the dot) — so `mcp__git_hub` !== `mcp__git.hub` and the server-wide deny is silently ineffective. The only string that works (`mcp__git.hub`) is undiscoverable because the raw alias never appears in any tool name. Demonstrated: composeMcpToolName('git.hub','create_issue') -> 'mcp__git_hub__create_issue' while rules.ts expects 'mcp__git.hub'; user-natural 'mcp__git_hub' does not match. Pre-M13 the raw tool name and raw server-scope rule agreed, so this is a divergence the fix introduced.

**Suggested fix.** Make the server-scope match use the SAME sanitization basis as the tool name. Either sanitize the server segment when building the line-60 comparison (e.g. `rule.tool === \`mcp__${sanitizeServerSegment(tool.mcpInfo.serverName)}\``, sharing the exact transform from composeMcpToolName), or carry the sanitized server prefix on mcpInfo so both tool-level and server-level rules key off identical strings. Add a test with a dotted/spaced alias asserting the server-scope deny matches the prefix the user sees in the tool name.

<details><summary>Evidence</summary>

CONFIRMED as an introduced/residual divergence from the M13 MCP name-sanitization fix.

Pre-audit baseline `git show f661f24:src/mcp/toolWrapper.ts` line 18:
  `const name = ` + "`mcp__${meta.serverName}__${meta.toolName}`" + `;`
— the tool NAME was built from the RAW serverName, so it agreed with rules.ts's raw key. A dotted alias gave both `mcp__git.hub__create_issue` (the name) and matched a `mcp__git.hub` server-scope deny.

Post-audit HEAD `src/mcp/toolWrapper.ts`:
  - line 25-27 `sanitizeSegment` replaces every char outside `[a-zA-Z0-9_-]` with `_`.
  - line 34-45 `composeMcpToolName` runs the server segment through `sanitizeSegment` → the wrapped tool name is `mcp__git_hub__create_issue`.
  - line 88 `mcpInfo: { serverName: meta.serverName, ... }` keeps the RAW unsanitized `git.hub`.

`src/config/rules.ts:60`:
  `if (tool.isMcp && tool.mcpInfo && rule.tool === ` + "`mcp__${tool.mcpInfo.serverName}`" + `) return true;`
— builds the server-scope comparison from the RAW `mcpInfo.serverName` = `mcp__git.hub`. Demonstrated: `sanitizeSegment('git.hub') = 'git_hub'`, so the surfaced tool name is `mcp__git_hub__create_issue` while line 60 requires `mcp__git.hub`. `'mcp__git_hub' !== 'mcp__git.hub'`, so the user-natural server-wide `deny: ["mcp__git_hub"]` silently no-ops; the only matching string `mcp__git.hub` never appears in any tool name and is undiscoverable.

Trigger is reachable: `src/config/settings.ts:117` `mcpServers: z.record(z.string(), McpServerConfigSchema)` — the alias key has NO charset validation, so `git.hub` is a valid alias. `TOOL_SELECTOR_RE = /^[A-Za-z0-9_.:-]+$/` (rules.ts:24) accepts BOTH `mcp__git.hub` and `mcp__git_hub`, so the operator gets no parse error either way. The exact-match path (rules.ts:55 `rule.tool === tool.name`) means a tool-level deny only works against the sanitized name, while the server-scope path keys off the raw name — the two diverge exactly as claimed.

Not in the 2026-06-10 audit doc and not a known-open deferred item; introduced by the M13 sanitization commit `cd9b205`. Existing tests miss it: `tests/config/rules.test.ts:60-76` only uses the clean alias `echo`, and `tests/mcp/toolWrapperSanitize.test.ts:57-62` only sanitizes the TOOL segment (`a.b`), never a dotted/spaced SERVER alias.

Severity: medium, not high. The failure is real (a permission-deny control silently no-ops), but the trigger is gated behind an uncommon operator choice — an MCP alias containing a non-`[a-zA-Z0-9_-]` char AND a server-scope deny rule — and MCP server config is operator-controlled/local (trusted surface), NOT reachable by an untrusted channel sender. Common alphanumeric aliases (`github`, `slack`) are unaffected, and there is a clean workaround (use a simple alias, or deny the exact sanitized tool name). Suggested fix is sound: key the line-60 comparison off the same sanitized server segment used in `composeMcpToolName` (e.g. share the transform or carry the sanitized prefix on `mcpInfo`).

</details>

### F22. src/memory/scope.ts:41 — `medium` · edge · CONFIRMED · _missed-by-audit_ · area:extensions

**Summary.** The M14 bundle-index shape guard (normalizeBundleIndex) only validates the TOP-LEVEL shape, not field types — a non-string `repo:` in index.yaml still crashes session boot at resolveProjectScope's `bundle.index.repo?.trim()`, defeating M14's own stated goal of surviving a typo'd bundle.

**Failure scenario.** A bundle index.yaml with a YAML-numeric or list `repo` field (e.g. `repo: 123` — a plausible typo, or `repo: [a, b]`) parses to `{ repo: 123 }`. normalizeBundleIndex passes it (it IS a plain object). Then at session boot resolveProjectScope runs `const repoName = bundle.index.repo?.trim();` — `(123)?.trim` is undefined and calling it throws `idx.repo?.trim is not a function`, crashing the first session. This fires on BOTH branches (line 41 inside the projectId path AND line 55 in the hash path), so even a valid projectId doesn't avoid it. Demonstrated by reproducing the throw on a parsed `repo: 123`. The M14 comment claims boot now 'survives a typo'd bundle' — this typo still crashes it.

**Suggested fix.** Guard the field reads in resolveProjectScope: `const repoRaw = typeof bundle.index.repo === 'string' ? bundle.index.repo.trim() : undefined;` at both line 41 and line 55. Optionally have normalizeBundleIndex coerce/drop non-string scalar fields it knows about (repo, projectId). Add a loader/scope test with a non-string repo asserting boot does not throw.

<details><summary>Evidence</summary>

Mechanism fully verified against HEAD and reproduced.

1) normalizeBundleIndex (src/bundle/loader.ts:27-35) validates ONLY the top-level shape and then blanket-casts:
   `if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) { return parsed as BundleIndex; }`
   A YAML index `{ projectId: my-proj, repo: 123 }` is a plain object, so it passes unchanged — no per-field coercion/validation.

2) resolveProjectScope (src/memory/scope.ts) reads repo on BOTH branches with only a null-guard (?.), not a type-guard:
   - line 41 (projectId path): `const repoName = bundle.index.repo?.trim();`
   - line 55 (hash path):      `const repoName = bundle.index.repo?.trim();`
   `(123)?.trim` is undefined; calling it throws. Reproduced with Bun+yaml:
   `repo: 123` → parsed {repo:123}, normalize passes → `repo?.trim()` throws `TypeError: parsed.repo?.trim is not a function`.
   `repo: [a,b]` → same TypeError. The optional chain only short-circuits null/undefined, not wrong-type scalars/lists. Because line 39 guards projectId with `typeof declared === 'string'`, a non-string projectId merely falls through to the hash branch — which STILL hits the same unguarded repo read at line 55, so a valid projectId does not avoid the crash.

3) This is on the mainline session-boot path: buildSessionContext calls resolveProjectScope({ cwd, bundle: runtime.bundle ?? null, ... }) at src/server/sessionContext.ts:314 (server/TUI/sov drive), plus dispatchCommand.ts:55 and missionRun.ts:143. So the throw crashes the first session whenever such a bundle is loaded.

4) Defeats the fix's own stated goal: the loader comment (loader.ts:20-26) and tests/bundle/loader.test.ts "FIX 6" only cover null/scalar/array TOP-LEVEL shapes ("boot survives a typo'd bundle"). There is no code path or test that coerces/guards a non-string `repo` or `projectId` field. grep confirms repo is read in exactly two places, both in scope.ts, both unguarded; no Zod schema sits between the YAML parse and these reads.

This is a genuine residual/incomplete-fix gap left by the M14/FIX-6 hardening, not an already-handled case and not a deferred known-open item.

Severity medium (not high): the trigger is a trusted operator's own hand-authored index.yaml typo (a local, trusted config artifact). Channel senders cannot influence index.yaml, so there is no security-boundary or cross-user reach; blast radius is the operator's own first session, no data loss/leak. It is a real rare-path crash that contradicts a documented robustness contract.

Suggested fix as filed is sound: type-guard the reads (`typeof bundle.index.repo === 'string' ? bundle.index.repo.trim() : undefined`) at both lines 41 and 55, optionally drop/coerce non-string scalar fields in normalizeBundleIndex, and add a scope/loader test with a non-string repo asserting boot does not throw.

</details>

### F23. packages/tui/internal/components/compactline.go:191 — `medium` · consistency · CONFIRMED · _missed-by-audit_ · area:tui-go

**Summary.** DetectToolStatus (FIX 4 error glyph) misses several is_error tool_results: orchestrator-level early-returns ('tool threw: …', 'hook denied: …', 'unknown tool: …', 'input validation failed: …') carry is_error=true but no 'status: error'/'permission denied' header, so the TUI shows NO error glyph. The fix comment even claims 'hook-denied' is handled, but it is not.

**Failure scenario.** A tool's call() throws (e.g. a transient FS/network exception). orchestrator.ts:529-538 returns a tool_result with content='tool threw: <msg>' and is_error=true, with NO observation envelope. The wire tool_result event (src/server/routes/turns.ts:1098-1110) carries output=content but does NOT include is_error (not in ServerEvent schema, src/server/schema.ts:49-57). The TUI's only error signal is DetectToolStatus, which decodes 'tool threw: …' and finds neither a 'status: error' first line nor a 'permission denied' prefix → returns (false,false) → the compact line renders with no ✗/⚠ glyph, visually identical to a successful call. Same for hook denials (content='hook denied: …', line 471 — does NOT match the 'permission denied' prefix the code checks), unknown-tool, and Zod/semantic input-validation failures. Common errors (Bash nonzero exit, FileRead/FileEdit failures) DO carry a 'status: error' envelope and glyph correctly, so the gap is the non-envelope error paths.

**Suggested fix.** Surface the authoritative is_error flag on the wire: add is_error to ToolResultEvent (schema.ts) + set it from contentBlock.is_error in turns.ts, decode it in the Go transport, and drive the glyph from it. As a stopgap, broaden DetectToolStatus to also match the 'hook denied'/'tool threw:'/'unknown tool:'/'…validation failed:' prefixes (and fix the comment that wrongly claims hook-denied is covered).

<details><summary>Evidence</summary>

CONFIRMED, with one correction to the candidate (the permission-denied path IS covered).

DROP AT THE WIRE: `src/server/schema.ts:49-57` `ToolResultEvent` has no `is_error` field, and `src/server/routes/turns.ts:1098-1110` emits `output: contentBlock.content` with no `is_error` — the authoritative `contentBlock.is_error` (available on the block) is dropped. `grep is_error` over turns.ts / schema.ts / the Go transport returns nothing. So the TUI's only status signal is the textual `DetectToolStatus`.

WHAT DetectToolStatus MATCHES (`compactline.go:191-220`): (a) a raw JSON `{status:"error"}` envelope; (b) `strings.HasPrefix(text, "permission denied")` (line 207); (c) first-line `strings.HasPrefix(..., "status: error")` (line 217). Else `return false, false` → no glyph (`compactline.go:87-98` drives the ✗/⚠ purely from these booleans).

THE UNCOVERED is_error CONTENT STRINGS (`src/core/orchestrator.ts`, all early-returns that bypass `formatToolResult`, so NO `status: error` envelope header):
- line 537: `content: result.data` = `tool threw: ${toolError.message}` (built at line 529, `is_error: true` line 538) — NOT matched.
- line 471: `content: 'hook denied: ...'` (`is_error:true`) — NOT matched.
- line 354: `content: 'unknown tool: ...'` — NOT matched.
- lines 392/437/492/515: `content: 'input validation failed: ...'` — NOT matched.
- line 415 `permission denied: ...` IS matched by line 207 (candidate's summary lists it, but the candidate's scenario correctly does not claim it's missed).

CONCRETE TRIGGER (common): the model calls `FileEdit` on a missing path. `FileEditTool.ts:66` `throw new Error(\`file does not exist: ${abs}\`)` propagates to the orchestrator catch (orchestrator.ts:527-529) → `result = { data: \`tool threw: file does not exist: ...\` }` → block `is_error:true`, content `tool threw: ...`, no envelope. Wire drops is_error. DetectToolStatus → `(false,false)` → compact line renders `Edited <path> ›` with NO ✗, visually identical to a successful edit. Same for FileRead on a missing file, Grep on a bad path, etc.

COMMENT FALSEHOOD CONFIRMED: `compactline.go:182-184` claims the failed-tool `status: error` header covers `(Bash nonzero exit, FileEdit no-match, hook-denied)` — but the hook-denied path (orchestrator.ts:471) emits plain `hook denied: ...` with no header and is not matched.

NOT A DUPLICATE / IT IS AN INCOMPLETE FIX: the 2026-06-10 audit raised this as H27 (compactline.go:168, conf 0.8), whose own failing list named "Bash nonzero exit, FileEdit no-match, hook-denied, validation failure" and whose recommended fix was either the `status: error` stopgap OR (better) add is_error to ToolResultEvent and consume it. The shipped FIX 4 took only the stopgap — it closes the envelope cases (Bash nonzero, FileEdit no-match) and permission-denied, but leaves the audit's own enumerated hook-denied + validation-failure cases (plus tool-threw and unknown-tool) still glyph-less. So this is a residual incomplete fix, not already-correct code and not a deferred known-open item.

SEVERITY: medium. The most common error path now covered is tool-threw exceptions (missing-file FileEdit/FileRead, grep errors) which users DO hit — a real correctness/consistency gap. But it is display-only on the trusted local TUI (the `tool threw: ...` text still renders in the decoded output); no crash, data loss, or security boundary. Below the audit's original H rating now that the envelope + permission cases are covered.

</details>

## LOW

### F24. src/tools/BashTool.ts:243 — `low` · security · CONFIRMED · _missed-by-audit_ · area:sec-bash

**Summary.** detectPrivilegeEscalation tokenizes on whitespace WITHOUT stripping quotes, so a quoted escalator ('sudo' rm -rf /) is not detected. Low impact: this guard is only a no-TTY hang-prevention UX aid, not a security boundary (sudo/su/etc. are not in BASH_READ_COMMANDS, so they still 'ask'/deny regardless).

**Failure scenario.** DEMONSTRATED: detectPrivilegeEscalation("'sudo' rm -rf /") returns null because the token is the literal "'sudo'" which !== 'sudo' after the basename strip. The consequence is only that a quoted sudo invocation reaches the spawn and may hang until the 120s timeout instead of being refused upfront with the friendly message — it does NOT auto-run (sudo is not read-only). Worth noting alongside the critical find bug because it shares the same root cause (quote-naive token analysis in this file) and the fix should be applied consistently.

**Suggested fix.** Reuse the quote-aware tokenizer (tokenizeSegment in shellSemantics.ts) for the escalator scan instead of seg.split(/\s+/), so quoted escalators are normalized before the basename check. Keep it conservative; this is a hang-guard, false positives are acceptable.

<details><summary>Evidence</summary>

Mechanism confirmed at src/tools/BashTool.ts:243 — `const tokens = seg.split(/\s+/).filter(Boolean);` then line 263-264 `const basename = cmd.includes('/') ? (cmd.split('/').pop() ?? cmd) : cmd; if (PRIV_ESCALATION_COMMANDS.has(basename)) return basename;`. Because the split keeps quote characters, the token for `'sudo' rm -rf /` is the literal `'sudo'` (with quotes), and basename strip only handles `/`, so `PRIV_ESCALATION_COMMANDS.has("'sudo'")` is false. Empirically verified by running detectPrivilegeEscalation's exact logic: `"sudo rm -rf /"` => `sudo` (detected), but `"'sudo' rm -rf /"` => `null` and `'"sudo" rm -rf /'` => `null` (NOT detected). By contrast the classification tokenizer tokenizeSegment (src/permissions/shellSemantics.ts:370-377) DOES strip quotes (the `'`/`"` cases `continue` without appending), which is why the candidate's suggested fix of reusing the quote-aware tokenizer is sound.

Impact is correctly bounded as a UX/hang-prevention aid only, NOT a security boundary — independently verified: the Bash auto-allow path is `isReadOnlyBashCommand` (BashTool.ts:113-116 `checkPermissions: isReadOnlyBashCommand(...) ? allow : { behavior:'ask' }`), which routes through `isReadOnlySegment` using COMMAND_LAUNCHERS (BashTool.ts:65, contains env/command/exec/nice/nohup/time/timeout/stdbuf/xargs — NOT sudo). So for `'sudo' cat /etc/passwd`, `'sudo' rm -rf /`, AND bare `sudo cat /etc/passwd`, isReadOnlyBashCommand returns false (ran all three: all `false`; genuine `cat /etc/passwd` => `true`). Result: a quoted sudo that slips past the guard still hits `behavior:'ask'` — it does NOT auto-run. The only consequence is loss of the friendly upfront refusal: if approved (or in bypass mode) it reaches `Bun.spawn(['bash','-c', input.command])` (BashTool.ts:314) and sudo hangs on the piped stdin until the 120s DEFAULT_TIMEOUT_MS, exactly the hang the guard exists to prevent. Channels are unaffected (safe-by-default ask=deny → never approved → no channel-RCE elevation).

duplicate_of_audit=FALSE: the audit's C2 fix (commit 6e55c57) closed separator-smuggling (`cat a\nsudo …`) and added tests at tests/tools/bashTool.test.ts:234-268 covering bare/flagged/launcher/pipeline/path-prefixed/post-separator sudo — but there is NO quoted-escalator test, and the current code does not strip quotes in detectPrivilegeEscalation. Genuine residual gap adjacent to but not closed by the audit. Severity low: contrived input (an agent rarely quotes the `sudo` token), no security/correctness/leak consequence, degrades only a robustness/UX guard on the trusted local surface.

</details>

### F25. src/tools/ssrfGuard.ts:88 — `low` · security · CONFIRMED · _missed-by-audit_ · area:sec-ssrf

**Summary.** Sync localhost check misses the FQDN trailing-dot form. `host === 'localhost'` and `host.endsWith('.localhost')` both fail for hostname 'localhost.' (trailing dot), which WHATWG preserves (verified: http://localhost./ => hostname='localhost.' => ALLOWED by checkUrlAllowed).

**Failure scenario.** WebFetch/@url on http://localhost./ passes the sync literal gate. On the real-fetch path the DNS guard happens to catch it on macOS (localhost. resolves to ::1/127.0.0.1, verified BLOCKED), but trailing-dot resolution is platform/resolver-dependent, and on any path where the DNS guard is disabled (injected fetch without injected lookup) the sync gate is the sole defense and leaks. The documented PRIMARY literal gate should not depend on DNS to catch 'localhost'.

**Suggested fix.** Strip a single trailing dot in bareHost before comparisons: `host = host.replace(/\.$/, '')`, so 'localhost.' and 'foo.localhost.' are recognized.

<details><summary>Evidence</summary>

The cited line src/tools/ssrfGuard.ts:88 is verbatim:

    if (host === 'localhost' || host.endsWith('.localhost')) return true;

The sync-gate gap is DEMONSTRATED. WHATWG URL preserves a trailing dot (verified: `new URL('http://localhost./').hostname === 'localhost.'`; `'http://foo.localhost./'` => `'foo.localhost.'`). Neither `=== 'localhost'` nor `.endsWith('.localhost')` matches `'localhost.'`, so the bareHost/normalizeMappedIpv4 pre-processing (lines 40-42, 87) does not strip the dot, and `checkUrlAllowed('http://localhost./')` returns `{ ok: true }` (verified by importing and running the actual functions). `checkUrlAllowed('http://localhost/')` correctly returns `{ ok: false }`. This is a residual gap in POST-AUDIT fix code: the file was created by audit fix commit cbba0fa ("close SSRF bypasses in WebFetch + add @url guard"), and the docstring at lines 80-85 claims the sync gate "Catches the `localhost` name" — so missing the FQDN trailing-dot form is an incomplete-fix residual, NOT a re-derivation of an already-fixed bug (duplicate_of_audit=false).

HOWEVER the medium severity overstates production impact, and the candidate honestly concedes this. There is NO demonstrable production SSRF bypass at HEAD:
- Both production call sites compute `dnsGuardEnabled = !injectedFetch || lookupImpl !== undefined` (WebFetchTool.ts:141, references.ts:133). Grep confirms NO production code sets ctx.fetchImpl for WebFetch/references (the cast is read-only, test-double-only); production injectedFetch is always undefined => dnsGuardEnabled === true.
- With the DNS guard enabled, `assertResolvedHostPublic('localhost.')` returns "Refusing to fetch: localhost. resolves to a private/loopback address" (verified live), blocking before fetch. Same for `foo.localhost.`.
- The sync gate is the SOLE defense only when dnsGuardEnabled === false, i.e. injected-fetch-without-injected-lookup — the hermetic-test-double path, which has zero production wiring.

So the residual gap weakens the documented "primary literal gate" invariant (it leans on DNS to catch a name it claims to catch directly), but the still-active DNS layer holds for every channel-sender-reachable production path. No cross-boundary breach is demonstrable => low, not medium. The suggested fix (strip a single trailing dot in bareHost: `host.replace(/\.$/, '')`) is correct and would also close the parallel warn-only gap in src/mcp/client.ts:350 (separate function, out of scope for this citation but same flaw).

</details>

### F26. src/tools/ssrfGuard.ts:127 — `low` · security · PLAUSIBLE · _missed-by-audit_ · area:sec-ssrf

**Summary.** DNS guard does not canonicalize the resolved IPv6 address before pattern-matching; loopback/link-local regexes anchored to compressed forms (/^::1$/, /^fe80::/) miss expanded or alternative representations a resolver may return. assertResolvedHostPublic passes r.address verbatim to isPrivateAddress.

**Failure scenario.** A hostname resolves (via a pluggable/non-glibc/attacker-influenced resolver) to expanded loopback '0:0:0:0:0:0:0:1'. Verified: assertResolvedHostPublic returning that address => ALLOWED (null), and isPrivateHost('0:0:0:0:0:0:0:1') is false because /^::1$/ does not match the expanded form. Standard node:dns returns compressed '::1' so the mainstream path is safe, but the guard must not assume canonical input from an untrusted/injectable resolver (LookupImpl is a public injection point).

**Suggested fix.** Match resolved IPv6 by numeric range over the parsed 16-byte address (test ::1, ::, fe80::/10, fc00::/7, ::ffff:0:0/96-embedded v4) rather than string-prefix regexes, or canonicalize the address string before matching.

<details><summary>Evidence</summary>

The matching gap is REAL and the cited line is correct. src/tools/ssrfGuard.ts:127 (`if (isPrivateAddress(r.address))`) passes the resolved address verbatim. isPrivateAddress (lines 72-78) only matches IPv6 against compressed-anchored regexes: `/^::1$/` (line 32), `/^::$/` (line 33), `/^fe80::/` (line 34). I ran the actual patterns: isPrivateAddress('0:0:0:0:0:0:0:1') === false (isIP returns 6, dotted-quad branch skipped, no IPv6 pattern matches) => assertResolvedHostPublic returns null => ALLOWED. Same for expanded 'fe80:0:0:0:0:0:0:1' and '0:0:0:0:0:0:0:0'.

BUT the trigger is not reachable by any untrusted party:
(1) The DEFAULT resolver (line 120: `dnsLookup as ... LookupImpl` from node:dns/promises) NEVER emits expanded forms. It routes through getaddrinfo -> inet_ntop, which always re-emits RFC-5952 canonical/compressed IPv6. I verified: dnsLookup('localhost',{all:true}) => [{address:'::1'},{address:'127.0.0.1'}] (the ::1 is compressed, AND the 127.0.0.1 is caught anyway); dnsLookup('one.one.one.one',{all:true,family:6}) => '2606:4700:4700::1111' (compressed, not '2606:4700:4700:0:0:0:0:1111'). A malicious upstream DNS server supplies 16 raw bytes, not a string, so it CANNOT inject '0:0:0:0:0:0:0:1'. The candidate concedes the mainstream node:dns path is safe.
(2) The LookupImpl injection seam the candidate calls "a public injection point" is TEST-ONLY in production. WebFetchTool.ts:137 reads `(ctx as { lookupImpl?: LookupImpl }).lookupImpl` via a cast, and references.ts:132 reads `options.lookupImpl`, but rg across src/ shows NO production code ever ASSIGNS lookupImpl on a ToolContext or passes it in options. It is not even a declared ToolContext field. Supplying a non-canonicalizing resolver requires editing source = the trusted local operator, NOT an untrusted Slack/Telegram/webhook/SMS channel sender.
(3) The most dangerous name `localhost` is caught earlier by the sync isPrivateHost (line 88, `host === 'localhost' || host.endsWith('.localhost')`) before DNS even runs.

Net: a channel sender (the only untrusted party) always drives the canonicalizing default resolver and cannot reach the gap. This is defense-in-depth hardening on a test-only seam, not a demonstrable security breach. Genuinely NEW (the 2026-06-10 audit's two-layer SSRF work only normalized the literal-IP mapped-IPv6 case via normalizeMappedIpv4, never the resolved-IPv6 canonicalization), and the suggested fix (numeric 16-byte range matching of ::1/::/fe80::10/fc00::7) is sound robustness, but with no untrusted-reachable trigger the independent severity is LOW, not the claimed medium.

</details>

### F27. src/plugins/secretScan.ts:195 — `low` · security · CONFIRMED · _introduced-by-fix_ · area:sec-config-skills

**Summary.** The `isPathShaped` exemption added by the audit fix suppresses field-targeting for ANY credential value containing a '/', so base64-standard secrets (AWS secret keys, slash-containing Bearer/HMAC tokens) baked into a plugin manifest credential field now escape BOTH the field-targeting and the content (entropy) scans — a false-negative regression vs the pre-fix scanner.

**Failure scenario.** A third-party plugin manifest bakes a literal AWS secret access key into a credential field, e.g. `{"apiKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}` (the canonical AWS example secret, base64-standard alphabet with '/'). At install time `scanObjectForSecrets` returns []: `fieldTargetFinding` now returns null because `isPathShaped` is true (value `.includes('/')`), and the content scan's `TOKEN_CHAR_RE = /[A-Za-z0-9_\-+=]{32,}/` excludes '/' so the value splits into sub-32-char segments and fails the entropy test too. Verified against the real module: every field-targeted surface (apiKey/token/secret/password/bearerToken/headers.Authorization/env.*_TOKEN) yields 0 findings for the slash variant but 1 finding for the identical no-slash value. Before the fix (`fieldTargetFinding` regex `[A-Za-z0-9_\-+=./]{8,}` which INCLUDED '/') the slash secret WAS flagged. The consent disclosure shown to the operator at plugin install no longer mentions the baked credential, weakening the disclosure aid for the untrusted-plugin ecosystem surface.

**Suggested fix.** Make `isPathShaped` only exempt values that are CLEARLY path references — require a path-like prefix (`/`, `~`, `./`, `../`, `${`) and NOT exempt arbitrary values merely because they contain an interior '/'. A bare interior-slash value (`wJalr/K7M.../...`) is far more likely a base64 secret than a path. Alternatively, keep the interior-'/' branch but split the value on '/' and still run the field-target opaque-token length check on each segment so a slash-delimited base64 secret is still flagged. Add a test for a prefix-less base64-standard secret containing '/' in a credential field.

<details><summary>Evidence</summary>

GENUINE INTRODUCED REGRESSION, demonstrated end-to-end. The audit fix (commit cd9b205) added `isPathShaped` and calls it in `fieldTargetFinding` at src/plugins/secretScan.ts:195 — `if (isPathShaped(value)) return null;`. `isPathShaped` ends with the over-broad clause at line 175: `return trimmed.includes('/');`. Combined with the content scanner's `TOKEN_CHAR_RE = /[A-Za-z0-9_\-+=]{32,}/g` (line 78, excludes `/`), a slash-fragmented opaque secret in a credential field escapes BOTH scans.

EMPIRICAL PROOF (ran the actual module): the canonical AWS secret `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` in `{apiKey}`, `{token}`, `{headers:{Authorization}}`, and `{env:{MY_TOKEN}}` all yield `[]` at HEAD; the identical no-slash value yields `[{reason:"high-entropy token..."}]`. The two slashes fragment the string into runs of 13/7/18 chars, none ≥32, so `match(TOKEN_CHAR_RE)` returns null AND `isPathShaped` returns true. Ran the pre-fix baseline at f661f24 (regex was `[A-Za-z0-9_\-+=./]{8,}` then `.replace(/[./]/g,'').length>=8`): all four surfaces WERE flagged. So the fix removed coverage.

INSTALL-PATH IMPACT: src/plugins/install.ts:264 `scanManifestSecrets` scans the manifest `hooks`+`mcpServers` surface; the MCP schema (src/config/settings.ts:64-90) carries exactly these fields (`bearerToken`, `apiKey`, `headers`, `env`). A slash-fragmented baked secret now (a) passes the install-rejection gate (`scanManifestSecrets` returns null) and (b) is absent from the consent disclosure shown to the operator. Verified against a realistic `{mcpServers:{myremote:{apiKey,bearerToken,headers:{Authorization:'Bearer '+secret},env:{SERVICE_TOKEN}}}}` surface → `[]`.

TWO CORRECTIONS TO THE FINDER: (1) Breadth is overstated as "ANY '/' value escapes both scans" — a value with a single interior slash leaving a ≥32-char run is STILL caught by the entropy content scan (verified: a 40-char base64 secret with one mid-slash still flags). The real escape is slash-FRAGMENTED secrets (multiple slashes, or one positioned so neither half ≥32). The AWS canonical example the finder chose IS such a case and is accurate. (2) Severity: this is a TTY-ONLY local-operator install path (S3 — unreachable from channels/remote), and the module header (lines 5-11) explicitly states it is best-effort "disclosed-not-made-safe," WILL miss secrets, and the real boundary is the consent gate, not the scanner. The leaked value is the plugin author's own baked credential (a hygiene/disclosure warning), not an attacker exfiltration vector reachable by an untrusted channel sender. That caps real impact below the claimed medium: it is a bounded degradation of a by-design-lossy disclosure aid. Rated LOW. The finder's suggested fix (narrow `isPathShaped` to clear path PREFIXES, or split on `/` and re-check segments for opaque-token length) is correct.

</details>

### F28. src/config/store.ts:11 — `low` · leak · CONFIRMED · _missed-by-audit_ · area:sec-config-skills

**Summary.** The redaction fix added `botToken`, `signingSecret`, `authToken`, `secret` to SECRET_KEYS but omitted `accountSid` — which the schema explicitly documents as a Twilio 'secret' — so `sov config show` and `/config get gateway.channels.sms.accountSid` print the Twilio Account SID in clear while its sibling `authToken` is redacted.

**Failure scenario.** With `gateway.channels.sms.accountSid = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"` configured, `sov config show` emits `"accountSid": "ACxxxx..."` verbatim (verified: redactSecrets leaves it untouched while `authToken` becomes `***`). schema.ts line 525 states 'The Twilio creds (accountSid/authToken/fromNumber) are secrets', so redaction is inconsistent with the schema's own stated intent. Severity is low because the truly sensitive `authToken` IS redacted, the Account SID is a public-ish account identifier (visible in Twilio console URLs), and the leak only occurs on trusted local config surfaces (a channel sender cannot run /config). It is a consistency/contract-drift defect, not a cross-boundary breach.

**Suggested fix.** Add `'accountSid'` (and consider `'fromNumber'` if treating it as sensitive) to the SECRET_KEYS set in src/config/store.ts to match the schema's documented intent. Optionally reconsider whether accountSid truly needs redaction; if not, update the schema comment to stop calling it a secret so the two stay consistent.

<details><summary>Evidence</summary>

CONFIRMED at code level. src/config/store.ts:11-20 defines `SECRET_KEYS = new Set(['apiKey','token','botToken','signingSecret','authToken','secret'])` — `accountSid` is absent while its sibling `authToken` (line 18) is present. redactSecrets (store.ts:213) only redacts on `SECRET_KEYS.has(k)`, so `accountSid` is recursively passed through unredacted (line 220). The schema comment at src/config/schema.ts:525-526 explicitly states "The Twilio creds (accountSid/authToken/fromNumber) are secrets". This object-key redactor feeds `sov config show` (src/main.ts:425 `JSON.stringify(redactSecrets(settings)...)`), `sov config get` (main.ts:440 `getAt(redactSecrets(settings), dotpath)`), and the `/config` slash (src/commands/configOps.ts:308/359/1178/1184). So with `gateway.channels.sms.accountSid = "ACxxxx..."` set, `sov config show` prints it verbatim while `authToken` becomes `***` — a real, demonstrable inconsistency with the schema's own stated intent and a residual gap from the 2026-06-10 audit fix that added the channel secrets but omitted accountSid (genuinely new/residual, not a re-derivation of an already-fixed bug).

SEVERITY = LOW (agreeing with the finder, on independent grounds): (1) the truly load-bearing credential `authToken` IS redacted; the Account SID alone is the Basic-Auth USERNAME (src/channels/adapters/sms.ts:340 `Buffer.from(`${accountSid}:${authToken}`)`) and a semi-public account identifier (appears in Twilio console URLs), not a standalone access grant; (2) the only affected surfaces — `sov config show`/`get`, `/config` slash — are trusted local single-user surfaces; a channel sender (untrusted) cannot run `/config` (channel turns return only the model's final text and run the safe-by-default posture), so this does NOT cross to the channel boundary that would elevate it. It is a consistency/contract-drift leak, not a security-boundary breach.

ONE CORRECTION to the candidate's suggested fix: do NOT add `fromNumber`. src/channels/listeners.ts:37-38 explicitly documents `fromNumber` as "not a secret (and has no env var)" — only `accountSid` (env-backed via SOV_TWILIO_ACCOUNT_SID, listeners.ts:40, exactly like the other true secrets) is the genuine inconsistency. Correct fix: add only `'accountSid'` to SECRET_KEYS.

</details>

### F29. src/commands/effortControl.ts:13 — `low` · consistency · CONFIRMED · _introduced-by-fix_ · area:multiuser

**Summary.** Stale doc comment after the #57 fix: the header still says setEffort 'mutates runtime.effort so the next turn's provider request carries the level.' setEffort now mutates the per-session sessionCtx.effort (commandContext.ts:189), never runtime.effort. The comment misdescribes the load-bearing isolation behavior.

**Failure scenario.** A future maintainer reads effortControl.ts:13-16 ('The behavioral effect lives in ctx.setEffort (Slice B), which mutates runtime.effort') and reasons that effort is global/shared — the exact mental model the #57 fix exists to prevent. They could 'fix' a perceived inconsistency by reverting setEffort to mutate runtime.effort, reintroducing the cross-principal depth leak on a multi-user gateway.

**Suggested fix.** Update the comment to state setEffort mutates the per-session SessionContext.effort (not the shared runtime.effort), matching commandContext.ts:179-190.

<details><summary>Evidence</summary>

CONFIRMED as a real, residual (incomplete-fix) doc-comment bug.

Offending lines — src/commands/effortControl.ts:13-14 (current HEAD):
  "// The behavioral effect lives in ctx.setEffort (Slice B), which mutates
   // runtime.effort so the next turn's provider request carries the level..."

Actual current behavior — src/server/commandContext.ts:188-191:
  "setEffort: (level: ReasoningEffort): void => {
     sessionCtx.effort = level;
     sideEffects.effortChanged = level;
   },"

setEffort now mutates the PER-SESSION sessionCtx.effort, NOT the shared runtime.effort, so the effortControl.ts header comment is factually wrong about the load-bearing isolation behavior.

Chronology proves this is an incomplete-fix residual, not a re-derived/already-fixed bug:
- effortControl.ts last edited at 9472408 (2026-06-09), comment intact.
- The #57 fix (7bfffcc, 2026-06-14 "make /effort per-session, not process-global") changed setEffort in src/server/commandContext.ts from runtime.effort -> sessionCtx.effort and updated the comment THERE (the new lines 179-191 explicitly explain the multi-user isolation rationale), but `git show 7bfffcc --name-only | grep effortControl` confirms effortControl.ts was NOT among the 11 files touched. The duplicate description left in effortControl.ts:13-14 was missed.
- `git diff f661f24..HEAD -- src/commands/effortControl.ts` is empty, so the 2026-06-10 audit did not touch this file either.

The candidate's cited path/line ("commandContext.ts:189") is slightly off — the file is src/server/commandContext.ts and the mutation is line 189 with the signature at 188 — but the substance is exactly correct.

Severity: low is correct. Comment-only; the runtime code is correct and the authoritative definition in commandContext.ts is heavily and correctly documented with the isolation rationale + has #57 regression tests, so the revert-the-comment-back-to-global scenario requires a maintainer to ignore all of that. No runtime/behavioral impact; within-org maintainability nit at most.

</details>

### F30. src/tasks/manager.ts:230 — `low` · consistency · CONFIRMED · _missed-by-audit_ · area:scheduler

**Summary.** A user-cancelled or scheduler-timed-out subscription-executor task is recorded as 'failed' instead of 'cancelled'/'timed_out', because the subprocess executor returns an error terminal in-band (reason:'error') for both cancel and timeout, and mapTerminalToState's `case 'error'` ignores userAborted.

**Failure scenario.** User runs task_stop on a subscription-executor (claude -p) task. controller.userAborted=true and the abort propagates to the composed signal. runSubprocessExecutor catches the abort and returns an IN-BAND error terminal (`errorResult` => terminal.reason:'error', subprocessExecutor.ts:332-340,659), so scheduler.delegate() RETURNS normally (no throw). In manager.runDelegation the success-branch runs `mapTerminalToState(result.terminal, controller.userAborted)`; `case 'error'` (manager.ts:230-232) returns 'failed' unconditionally — userAborted is only consulted under `case 'interrupted'` (line 228-229). The native AgentRunner path instead throws on abort -> scheduler returns reason:'interrupted' (scheduler.ts:451) -> correctly maps to 'cancelled'/'timed_out' (confirmed by tests/tasks/manager.test.ts:155-172). So the documented contract in manager.ts:14-17 ('our terminal-mapping distinguishes cancelled from timed_out') is broken specifically for subscription-executor tasks: both a user cancel and a scheduler-timeout collapse to 'failed'. No test covers this subprocess cancel mapping.

**Suggested fix.** Distinguish the subprocess cancel/timeout terminal so the manager can map it correctly. Either: (a) have the scheduler translate a subprocess error terminal whose underlying cause was the parentSignal/timeout into reason:'interrupted' before returning, or (b) in mapTerminalToState, when userAborted is true, return 'cancelled' for the 'error' case as well (and detect timeout via the executor's distinguishable error message). Option (a) keeps native vs subprocess parity cleanest.

<details><summary>Evidence</summary>

Mechanism is real and reachable. The subprocess executor returns an error terminal IN-BAND (never throws) on both cancel and self-timeout:
- `src/runtime/subprocessExecutor.ts:332-340`: `if (aborted) { return errorResult(timedOut() ? new Error('...timed out...') : new Error('...cancelled by scheduler signal')); }` and `errorResult` (`:657-665`) builds `terminal: { reason: 'error', error }`.
Because it returns rather than throws, the scheduler's `catch` block — the ONLY place a terminal is re-mapped to `'interrupted'` (`src/runtime/scheduler.ts:451` `terminal: { reason: 'interrupted', error: new Error(message) }`) — is never entered for the subprocess path. The scheduler success-tail returns the error terminal unchanged: `src/runtime/scheduler.ts:568` `terminal: result.terminal`. The file comment at scheduler.ts:373-376 explicitly confirms this design ("returns an error terminal IN-BAND (never throws), so it flows through the success tail").

In the manager, the success branch runs `mapTerminalToState(result.terminal, controller.userAborted)` (`src/tasks/manager.ts:163`). The offending mapping:
```
228  case 'interrupted':
229    return userAborted ? 'cancelled' : 'timed_out';
230  case 'error':
231  case 'max_tokens':
232    return 'failed';
```
`userAborted` is consulted ONLY under `'interrupted'` — under `'error'` it returns `'failed'` unconditionally. So a user `task_stop` (sets `controller.userAborted = true; controller.abort.abort('user_cancel')` at manager.ts:102-103) or a scheduler per-child timeout on a subscription-executor task is recorded as `'failed'`, breaking the documented contract at manager.ts:12-17 ("our terminal-mapping then distinguishes 'cancelled' (userAborted=true) from 'timed_out'").

Reachability: `task_create { subagent_type: 'subscription-executor' }` is accepted whenever the agent is in the FULL registry — `src/tools/TaskCreateTool.ts:48` checks `ctx.agents.byName.has(...)` (the full registry, NOT the model-narrowed `computeToolVisibleAgents` set), and the subscription-executor agent is present when `subscriptionExecutor.enabled: true`. No test covers the subprocess cancel/timeout mapping: `tests/tasks/manager.test.ts:155-172` exercises only the native `'interrupted'`→`'cancelled'` path.

This is genuinely new code (subprocess-executor spike, commits 9686029..4a5902b — post-audit), not an already-fixed audit item.

Severity downrated to low (finder said medium): the only observable effect is a cancelled/timed-out task showing state `'failed'` in task_get/task_output. It is reachable ONLY on a local, trusted, opt-in (`subscriptionExecutor.enabled: true`) interactive surface — NOT channels (the executor is bound to the interactive seam; channels keep their own bypass rejection). No data loss, crash, leak, or security-boundary breach — a reporting/contract-consistency drift on a rare opt-in spike path.

</details>

### F31. src/runtime/subprocessExecutor.ts:286 — `low` · bug · CONFIRMED · _introduced-by-fix_ · area:scheduler

**Summary.** When BOTH the scheduler signal (opts.signal) and an internal config.timeoutMs are set and the scheduler signal fires first (user cancel), `timedOut()` can still report a self-timeout if the internal AbortSignal.timeout has also elapsed by the time the abort-result branch is read, misattributing a cancel as a timeout in the error message.

**Failure scenario.** With config.timeoutMs set, composed = AbortSignal.any([opts.signal, timeoutSignal]). If opts.signal aborts (cancel) at roughly the same wall-clock as timeoutSignal expires, the Promise.all drain completes and line 337 evaluates `timedOut()` = `timeoutSignal?.aborted === true`. If the internal timeout already fired (even though the cancel was the true first cause), the error reads 'timed out after Nms' for what was actually a cancel. This is message-only (terminal.reason is 'error' either way) and a narrow race, so impact is limited to operator-facing diagnostics.

**Suggested fix.** Capture which signal aborted at the moment onAbort fires (e.g. record `timeoutSignal?.aborted` inside the onAbort handler / on the spawn-time composed.aborted check) rather than re-reading both signals' aborted flags after the drain, so the attribution reflects the first cause.

<details><summary>Evidence</summary>

The defect is real and reproducible by inspection. `src/runtime/subprocessExecutor.ts:286` defines:

  const timedOut = (): boolean => timeoutSignal?.aborted === true;

This is invoked at line 337 inside the `if (aborted)` branch, which only runs AFTER the drain at lines 326-330 (`await Promise.all([readCapped(stdoutReader), readCapped(stderrReader), proc.exited])`). It re-reads `timeoutSignal.aborted` rather than capturing the first cause of the abort.

`timeoutSignal` (line 279, `AbortSignal.timeout(timeoutMs)`) and `opts.signal` are INDEPENDENT signals composed via `AbortSignal.any` (line 282). If `opts.signal` (scheduler cancel) aborts first, `onAbort` (lines 310-321) kills the proc and cancels the readers; the drain resolves at some later instant T+δ. The internal `AbortSignal.timeout` timer keeps running independently — if it elapses anywhere in [cancel, T+δ], then at line 337 `timedOut()` returns true and the error reads `subscription-executor timed out after ${timeoutMs}ms` (line 338) even though the TRUE first cause was the scheduler cancel (which should produce `subscription-executor cancelled by scheduler signal`, line 339).

The code comment at lines 284-285 ("True when the abort originated from OUR internal timeout (vs. the scheduler's signal)") overstates the guarantee — re-reading post-drain `.aborted` does not establish first-cause ordering, so the stated invariant does not hold under the near-simultaneous race.

Triggering state matches the candidate exactly: `config.timeoutMs` explicitly set, both signals present (so `composed = AbortSignal.any([...])`), and `opts.signal` firing at roughly the same wall-clock as the internal timeout (or the timeout elapsing during the kill/drain window after the cancel).

Impact is message-only: `errorResult` (lines 657-665) always returns `terminal: { reason: 'error', error }` regardless of message, and no caller inspects the message text (scheduler at scheduler.ts:393-405 just stores the in-band error terminal). No data loss, crash, or leak. The subscription-executor is off-by-default and wired ONLY to the attended interactive sub-agent seam (NOT cron/channels/gateway), so no untrusted channel sender can reach it — no security boundary. Narrow race + diagnostic-only misattribution on an opt-in feature ⇒ low. This is genuinely new post-audit spike code (commits 9686029..4a5902b), not a re-derived audit finding or a known-open deferred item.

</details>

### F32. src/server/commandContext.ts:169 — `low` · bug · CONFIRMED · _missed-by-audit_ · area:router

**Summary.** /effort reports wrong reasoning-support in router mode: ctx.apiMode is undefined and ctx.model is the synthetic "a | b" string, so modelSupportsReasoning() returns false even when the frontier lane (e.g. Claude 4) does reason

**Failure scenario.** RouterProvider implements only LLMProvider (name + stream); it has no `apiMode` property, yet runtime.ts:925 casts it `as unknown as Transport`. commandContext.ts:169 sets `apiMode: runtime.resolvedProvider.transport.apiMode` → undefined in router mode, and ctx.model is the synthetic `"qwen2.5:14b | claude-sonnet-4-6"`. effortControl.ts:42 calls `modelSupportsReasoning(ctx.model, ctx.apiMode)`; effort.ts:60 switch(apiMode) falls to `default: return false`. So `/effort status` reports e.g. 'qwen2.5:14b | claude-sonnet-4-6 does not support reasoning depth' even though the frontier lane attaches thinking params correctly on the wire (the anthropic adapter hardcodes modelSupportsReasoning(req.model,'anthropic') against the real recovered model). Misleading status only; on-wire behavior is correct. Sibling exists at dispatchCommand.ts:114.

**Suggested fix.** In router mode resolve apiMode/model from the frontier lane's resolved metadata (the lane that can actually reason) rather than from the RouterProvider pseudo-transport. Threading the metadata.apiMode (which exists: 'router') or the frontier child's real apiMode + model into ctx would fix the report.

<details><summary>Evidence</summary>

All cited code confirmed at HEAD. (1) src/router/provider.ts:43 `export class RouterProvider implements LLMProvider` — grep for `apiMode` over the whole file returns ZERO hits, so the instance has no apiMode property. (2) src/server/runtime.ts:925 `transport: routerProvider as unknown as Transport` launders the missing field past the type checker; runtime.model is set at line 929 to the synthetic ``model: `${localResolved.model} | ${frontierResolved.model}` `` (e.g. "qwen2.5:14b | claude-sonnet-4-6"). (3) src/server/commandContext.ts:169 `apiMode: runtime.resolvedProvider.transport.apiMode` therefore reads `undefined` in router mode, and `model: runtime.model` (line 168) is the synthetic "a | b" string. (4) src/commands/effortControl.ts:42 `return modelSupportsReasoning(ctx.model, ctx.apiMode)` → src/providers/effort.ts:60 `switch (apiMode)` with `apiMode===undefined` hits `default: return false` (line 72-73). Note `ApiMode = 'anthropic' | 'openai' | 'ollama' | 'sov'` (types.ts:46) has no 'router' case, so even the metadata.apiMode:'router' value (runtime.ts:933, which is never threaded into ctx anyway) would also hit default→false. (5) statusReport (effortControl.ts:54-60) then emits `"<model> does not support reasoning depth …"`. CONCRETE TRIGGER: router config enabled with frontierModel=claude-sonnet-4-6; user runs `/effort status` → reports the Claude-4 frontier lane cannot reason. WIRE BEHAVIOR IS UNAFFECTED — src/providers/anthropic.ts:48 `modelSupportsReasoning(req.model, 'anthropic')` re-derives against the REAL recovered child model at stream time, so thinking params still attach correctly to the frontier lane; this is a misleading status line only. Sibling confirmed at src/cli/dispatchCommand.ts:118 `apiModeRef: { current: resolved.transport.apiMode }` (same undefined-in-router-mode). Genuinely new/residual: not in #58 (that is runtime.model-is-global mutation, a different axis), not an already-fixed audit item, and the metadata fix is never wired into ctx. Re-rated to LOW (not medium): the off-by-default router surface only mis-prints an advisory status string; no functional/on-wire impact, no leak, no crash.

</details>

### F33. src/router/provider.ts:160 — `low` · consistency · PLAUSIBLE · _introduced-by-fix_ · area:router

**Summary.** Pathological empty delegatedModel makes the audit log / route_decision event report an empty model while the child actually receives the synthetic string

**Failure scenario.** When recoverLaneModel returns '' (model not in synthetic form and no per-lane override), delegatedModel='' . The audit record (line 134 `model: delegatedModel`) and the route_decision StreamEvent (line 148 `delegatedModel`) both report the empty string, but childReq (line 160 `delegatedModel ? {...req, model: delegatedModel} : req`) passes the ORIGINAL req.model through. So observability (audit log, TUI route card) shows '' while the child actually saw the real/synthetic req.model — they disagree. Requires the rare unparseable-model-with-no-override path.

**Suggested fix.** Compute the model the child will actually receive once and report THAT in both the audit record and the route_decision event (e.g. `const childModel = delegatedModel || req.model;` and use childModel everywhere), so observability matches the wire.

<details><summary>Evidence</summary>

The mechanism is real and the quoted lines are accurate. In src/router/provider.ts:122 `const delegatedModel = configuredModel ?? recoverLaneModel(req.model, decision.lane);`. recoverLaneModel returns '' when `parts.length !== 2` (line 176) — i.e. req.model is not in synthetic `"<local> | <frontier>"` form. On that empty-string path the three sites diverge: the audit record reports the empty model (line 134 `model: delegatedModel`), the route_decision StreamEvent reports the empty model (line 148 `delegatedModel`), but the child receives the ORIGINAL req because line 160 `const childReq: ProviderRequest = delegatedModel ? { ...req, model: delegatedModel } : req;` falsy-guards on '' and passes `req` through unchanged. So observability ('') disagrees with what the child actually saw (req.model). Correctly described.

However the trigger is non-production. In every production router path req.model is the synthetic string built at src/server/runtime.ts:928 `model: \`${localResolved.model} | ${frontierResolved.model}\``, and both resolved models are guaranteed non-empty (src/providers/resolver.ts:95-96 falls through `model ?? providerConfig?.model ?? settings.defaultModel ?? registry.defaultModel`). So in production recoverLaneModel always parses a length-2 synthetic string and returns a non-empty model, making the empty branch unreachable and observability == wire. The empty path is hit only by a test/non-production caller passing a single plain model id with no per-lane localModel/frontierModel override — exactly the case the code comment (lines 156-159, 173) labels "pathological."

Not introduced by the fix: `git diff f661f24..HEAD -- src/router/provider.ts` shows the prior code was `localModel ?? ''` / `frontierModel ?? ''`, which had the identical audit/event-vs-wire divergence whenever no per-lane override was configured. The post-audit recoverLaneModel change NARROWED the empty surface (now only the non-synthetic path) — it neither introduced nor fully closed the drift. So is_new_or_introduced is honestly false for the underlying inconsistency; it is a residual on a freshly-touched function rather than a regression.

Severity: correctly self-rated low. It is a cosmetic observability inconsistency on a non-production/pathological path — no crash, no data loss, no leak, no security boundary; channel senders never reach router model selection. duplicate_of_audit=false because the current code does NOT correctly handle it (the divergence still exists on the empty path) and it is not a known-open deferred item — but it is a benign residual, hence PLAUSIBLE (mechanism real, production trigger absent) rather than CONFIRMED.

</details>

### F34. src/router/classifier.ts:91 — `low` · consistency · CONFIRMED · _introduced-by-fix_ · area:router

**Summary.** After the M26 fix, reasonFor's 'classified as frontier-only' branch is dead code — no non-override path produces classifierLane='frontier' except context overflow, which is named just above it

**Failure scenario.** classifyRaw's only non-override `return 'frontier'` is the context-overflow branch (line 53). reasonFor handles userOverride first (line 82-84), then for classifierLane==='frontier' it returns the context-overflow reason when isContextOverflow(opts) is true (line 88-90). Since overflow is the ONLY way to reach a non-override 'frontier' classifierLane, the fallthrough `return 'classified as frontier-only'` (line 91) is unreachable. Harmless, but it advertises a frontier-only classification mode that no longer exists, which can mislead future maintainers into thinking such a path is wired.

**Suggested fix.** Drop the dead 'classified as frontier-only' return (the isContextOverflow branch fully covers non-override frontier), or add an explanatory comment that it is defensively unreachable.

<details><summary>Evidence</summary>

The dead-branch claim is correct. In `classifyRaw` (src/router/classifier.ts) the only two non-loop `return 'frontier'` statements are:
- line 45: `if (opts.userOverride === 'frontier') return 'frontier';`
- line 53: `if (isContextOverflow(opts)) { return 'frontier'; }`

In `reasonFor`, line 82 intercepts ALL override paths: `if (opts.userOverride !== undefined) { return ... }`. Since `userOverride?: Lane` (types.ts:49) is strictly `'local' | 'frontier' | undefined` — no falsy-but-defined value exists — this fully catches the override-`'frontier'` case before line 85. Therefore the ONLY way to reach line 85 (`if (classifierLane === 'frontier')`) with `classifierLane === 'frontier'` is the context-overflow path. At that point line 88 re-evaluates the identical pure predicate `isContextOverflow(opts)` on the same unchanged `opts`, so it is guaranteed `true` and line 89 returns. The fallthrough at line 91:

    return 'classified as frontier-only';

is genuinely unreachable. (It was in fact already dead before the M26 fix too, since pre-fix the overflow path produced `'local-with-escalation'`, leaving userOverride as the only route to a `'frontier'` lane — also short-circuited at line 82.)

This is NOT in the audit. Audit M26 (docs/07-history/audits/2026-06-10-full-codebase-audit.md:313) flagged only the wrong return value (`'local-with-escalation'` instead of `'frontier'`); its fix (commit 4e09883) changed the lane and added the matching `isContextOverflow` reason branch (line 88-90) but left the now-dead `'classified as frontier-only'` fallthrough behind — a residual artifact introduced/left by the fix, not a re-derivation of a fixed bug. Severity low: zero behavioral impact (the emitted reason string is never wrong on any real path); purely a maintainer-clarity / dead-code concern that advertises a frontier-only classification mode the code no longer wires.

</details>

### F35. src/providers/anthropic.ts:368 — `low` · bug · PLAUSIBLE · _missed-by-audit_ · area:core

**Summary.** Cross-provider thinking blocks (no signature) are replayed to Anthropic with signature:'' → 400. The audit's new ContentBlock 'thinking' + signature support fixed the same-provider round-trip but left this cross-provider path live and now type-valid.

**Failure scenario.** A reasoning-capable OpenAI-API / sov-local / ollama model emits an assistant message containing { type:'thinking', thinking:... } with NO signature (src/providers/openai.ts:311). That block is persisted to sessionDb (JSON.stringify of content) and lives in history. The user then switches provider to Anthropic via /model mid-session, the router mixes providers, or a resume routes the next turn to Anthropic. buildKwargs() calls messagesToSdk(req.messages) UNCONDITIONALLY (anthropic.ts:125) — no stripping of thinking blocks when thinking is off. blockToSdk emits { type:'thinking', thinking, signature: block.signature ?? '' } = signature:'' . Anthropic rejects a thinking block with an empty/invalid signature with HTTP 400 (messages.N.content.M.thinking.signature invalid), breaking the turn. Note: the empty-signature behavior is pre-existing (baseline f661f24 also did signature:''), but the audit's new type makes the OpenAI-origin thinking block type-valid in history and thus far more likely to reach this path.

**Suggested fix.** In blockToSdk (or messagesToSdk), drop a 'thinking' block when its signature is empty/absent (or drop all thinking/redacted_thinking blocks from history when the current request does not have thinking enabled). Anthropic ignores prior-turn thinking blocks when thinking is off, so stripping them is safe and avoids the 400; only the most-recent assistant turn's signed thinking needs to be replayed on the continuation call.

<details><summary>Evidence</summary>

The plumbing the finder describes is real and verified at HEAD. An OpenAI-family reasoning model emits an unsigned thinking block — `src/providers/openai.ts:311`: `content.push({ type: 'thinking', thinking: reasoning })` (no `signature`). It is type-valid in history — `src/core/types.ts:22`: `{ type: 'thinking'; thinking: string; signature?: string }` (comment: "Optional so non-Anthropic providers and pre-signature history stay valid"). It persists (`sessionDb.ts:615` `JSON.stringify(msg.content)`), reloads verbatim (`sessionDb.ts:1050` `JSON.parse(row.content)`), hydrates via `loadHistoryAsMessages` (`server/sessionId.ts:37` `content: m.content`) into `query()` → `provider.stream({ messages: history })` (`core/query.ts:158-161`), and `buildKwargs` calls `messagesToSdk(req.messages, ...)` UNCONDITIONALLY with no thinking-block stripping (`anthropic.ts:125`). `blockToSdk` then emits the offending line — `src/providers/anthropic.ts:368`: `return { type: 'thinking', thinking: block.thinking, signature: block.signature ?? '' };`. No code anywhere strips thinking blocks on the Anthropic path (grep of `src/` for thinking-filtering found none; `transcriptRepair` only touches tool_use/tool_result). So an unsigned cross-provider thinking block DOES reach Anthropic with `signature:''`.

What is REFUTED is the consequence — that this yields a 400 that breaks the turn. Per the authoritative claude-api skill (`shared/model-migration.md`): for prior-turn thinking blocks when continuing, "echo thinking blocks back unchanged when continuing on the same model; OTHER MODELS SILENTLY IGNORE THEM." The hard-reject-on-bad-signature behavior the finder relies on was an early-access build that "broke workflows and was reverted before launch." And "The API rejects blocks whose content has been MODIFIED, not blocks you have read." The 400 `...thinking.signature invalid` the finder cites is the INTERLEAVED-THINKING CONTINUATION path — a signed thinking block on the LATEST assistant turn during an active tool-use continuation with thinking ON. In this harness thinking + the interleaved beta are attached only when `thinkingApplies(req)` is true (`anthropic.ts:44`, `148-150`). The finder's own trigger (`/model` switch / resume routing the NEXT turn to Anthropic) makes the OpenAI block a PRIOR turn — the silently-ignored class — never the most-recent assistant turn of an Anthropic-initiated interleaved continuation (Anthropic didn't generate that block, so it never opened a continuation expecting it back signed). 

Net: the cross-provider unsigned-thinking-block path is genuinely reachable and not flagged by the 2026-06-10 audit (new/residual), but the documented current Anthropic behavior is to silently drop/ignore such prior-turn blocks rather than 400. At most a latent contract concern (a future API tightening could resurrect the reject behavior; stripping unsigned/prior-turn thinking blocks would be defensively correct), not a real break users will hit today. Severity: low.

</details>

### F36. src/server/routes/turns.ts:504 — `low` · bug · CONFIRMED · _unsure_ · area:core

**Summary.** The hydrate/resume path runs repairMissingToolResults but never merges consecutive same-role messages, so a session whose persisted history was corrupted by the pre-H7-fix bug (a standalone trailing guidance user message) still 400s on resume.

**Failure scenario.** Before the H7 fix shipped, a content-only first-strike loop pushed a standalone guidance user message into history that the caller persisted, leaving the timeline ending on (assistant, user). When that session is later resumed, loadHistoryAsMessages returns the raw history and the freshly-persisted new user message is appended → two consecutive user messages. repairMissingToolResults only synthesizes missing tool_result blocks (transcriptRepair.ts) — it has no consecutive-user-message coalescing — so Anthropic rejects the messages array with 'roles must alternate' and the session is unrecoverable. The H7 fix prevents NEW corruption but does not heal sessions already corrupted by the old bug.

**Suggested fix.** Add a consecutive-same-role coalescing pass to repairMissingToolResults (or a sibling repair invoked in hydrate()): when two adjacent messages share a role, merge their content arrays into one message. This is purely additive (no adjacent same-role pair → identical output) and heals legacy-corrupted histories on resume.

<details><summary>Evidence</summary>

Mechanism fully verified against HEAD.

1) Pre-H7 code DID persist a standalone trailing guidance user message. `git diff f661f24..HEAD -- src/core/query.ts` shows the removed first-strike content-only branch: `const guidance: Message = { role: 'user', content: [{ type: 'text', text: pendingGuidanceText }] }; history.push(guidance); yield guidance;`. The yielded user message is persisted by the turns route — turns.ts:1087 handleUserMessage: "Persist all user-role messages (tool_result and guidance) so resume reconstructs exact prior context." `sessionDb.saveMessage(sessionId, { role: msg.role, content: msg.content })`. The turn then terminates at the content-only branch (query.ts:318 `if (toolUseBlocks.length === 0) ... return { reason: 'completed' }`), so history ends on (assistant, user-guidance). The H7 fix (commit 554d1b4) only set pendingGuidanceText when `toolUseBlocks.length > 0` — preventing NEW corruption, not healing old.

2) On resume, the new user message is persisted FIRST (turns.ts:461 `runtime.sessionDb.saveMessage(...)`) then `hydrate()` runs (turns.ts:512). hydrate calls `loadHistoryAsMessages` (turns.ts:503) which returns raw rows verbatim (sessionId.ts:33-40, no normalization) → [..., assistant, user-guidance, user-new].

3) repairMissingToolResults does NOT coalesce consecutive same-role messages (transcriptRepair.ts:15-53). Non-assistant messages are pushed verbatim: `if (message.role !== 'assistant') { repaired.push(message); continue; }` (lines 24-27). It only synthesizes missing tool_result blocks. So the two consecutive user messages survive.

4) query() passes `messages: history` straight to `provider.stream({ ... messages: history ... })` (query.ts:161) with no merge; memory/recall injection only edits the latest user message's text, not message structure. No provider-side coalescing exists (grep of src/providers found none). Anthropic therefore rejects the array (roles must alternate) → session unrecoverable.

Severity rated low (not high): trigger requires a session persisted by PRE-554d1b4 code AND a content-only loop-detector first strike (content-loop heuristic firing exactly once on a no-tool turn that then ends) AND that specific session being resumed against Anthropic. New sessions cannot reach this state (H7 closed the producer). It is genuinely RESIDUAL — the audit's H7 fix stopped new corruption but added no healing for already-corrupted histories — and is not a known-open deferred item (#17/#50-54) nor a re-derived already-fixed bug. The finder's "purely additive" framing of the fix is approximately right (the OpenAI mapping path at requestToMessages.ts:52 already runs a separate consecutive-tool-result merge before calling repair, so a shared coalescing pass would be defensible), though that is a fix-design detail, not a refutation.

</details>

### F37. src/openai/routes/chatCompletions.ts:692 — `low` · bug · CONFIRMED · _missed-by-audit_ · area:openai-api

**Summary.** buildProviderErrorResponse credential classifier matches the error MESSAGE with a broad regex, so non-auth provider errors whose text contains 'forbidden'/'api key'/'credential' are misreported as 401 invalid_api_key. FIX 2 widened the surface that hits this classifier.

**Failure scenario.** The classifier tests message against /credential|api[\s_-]?key|unauthorized|forbidden/i (line 692) BEFORE checking the structured HTTP status. An Anthropic 400 such as 'your prompt references a forbidden token' or a 429 whose message mentions 'api key' is classified as 401 invalid_api_key instead of mirroring the real upstream status. FIX 2 (line 121) now routes synchronous model-resolution failures through this same classifier, and FIX 3 (lines 337/343) routes pre-stream provider errors through it — both broadening the set of errors subject to the message-substring false positive. SDK clients then raise AuthenticationError for what is actually a rate-limit/bad-request, masking the true cause.

**Suggested fix.** Prefer the structured signal: check isCredentialUnavailable(err) and an explicit 401/403 from extractUpstreamStatus(err) first; only fall back to the message regex when no structured status is present, and tighten the regex (e.g. require 'unauthorized'|'invalid api key' rather than bare 'forbidden').

<details><summary>Evidence</summary>

The ordering flaw is real and the cited line is exact. In `buildProviderErrorResponse` (src/openai/routes/chatCompletions.ts), the message-substring regex is tested BEFORE the structured HTTP status:

Line 690-693:
```
  if (
    isCredentialUnavailable(err) ||
    /credential|api[\s_-]?key|unauthorized|forbidden/i.test(message)
  ) {
    return c.json({ error: { message, type: 'invalid_api_key' } }, 401);
```
Only afterward (line 705-716) is `extractUpstreamStatus(err)` consulted to mirror the upstream status. So any error reaching this function whose `.message` contains `credential|api key|unauthorized|forbidden` is forced to 401 `invalid_api_key` regardless of its true structured `.status`.

FIX-2/FIX-3 widening confirmed:
- Line 121: `return buildProviderErrorResponse(c, err);` for synchronous `resolveModelForRequest` failures (FIX 2).
- Line 337 (`buildProviderErrorResponse(c, err)`) and Line 343 (`buildProviderErrorResponse(c, firstStep.value.error)`) for pre-stream provider errors / error-terminals (FIX 3).
Both feed raw `ProviderHttpError`/SDK errors (which carry a real `.status` per src/providers/anthropic.ts:67 `new ProviderHttpError('anthropic', err.status, err.message, ...)`) into the classifier, where the regex pre-empts `extractUpstreamStatus`.

Demonstrated trigger (node regex test): a 429 message `'429 your API key has exceeded its rate limit'` and a 400 message `'... the api_key parameter must not appear in the body'` both match the regex -> returned as 401 invalid_api_key instead of 429/400. SDK clients then raise AuthenticationError, masking a rate-limit/bad-request. (Common messages — 429 rate_limit_error, 400 prompt-too-long, 404 not_found, 529 overloaded — do NOT contain the tokens and correctly mirror their status, which is why the existing test at tests/openai/chatCompletions.nonstreaming.test.ts:213 passes: it uses the message 'rate limited', avoiding the regex.)

Not duplicate: the audit (docs/07-history/audits/2026-06-10-full-codebase-audit.md:290-291 and :307) introduced exactly the FIX-2/FIX-3 routing but never flagged that funneling structured non-auth errors through the regex-first classifier mis-fires; this residual is new/introduced by those fixes, not a known-open deferred item.

Severity low: this is a rare-path error-envelope contract drift on `sov serve`, a trusted loopback OpenAI-compatible surface (not a channel). Requires a non-auth provider error that BOTH carries a structured status AND has message text containing a regex token. No security boundary breach, no cross-user leak, no data loss — the verbatim message is still returned; only the `type`/HTTP-code classification is wrong. The finder's suggested fix (check `isCredentialUnavailable` + explicit 401/403 from `extractUpstreamStatus` first, fall back to a tightened regex only when no structured status is present) is sound.

</details>

### F38. src/openai/streaming/sseTranslator.ts:131 — `low` · consistency · CONFIRMED · _missed-by-audit_ · area:openai-api

**Summary.** FIX 4 fixed usage accumulation only for the non-streaming branch; the streaming branch emits no usage object at all, so streaming clients that request usage get none and there is no parity with the (now-fixed) non-streaming totals.

**Failure scenario.** translateStream never emits an OpenAI usage chunk. A client sending stream: true (and, per OpenAI's spec, stream_options: { include_usage: true }) receives the content stream + final-stop + [DONE] but no usage payload — and the harness silently ignores stream_options (it is stripped by the schema). After FIX 4 the non-streaming branch now reports accurate per-call totals, but the streaming branch reports nothing, so cost-tracking clients see a hard inconsistency between the two transport modes. This is a pre-existing v0 limitation the M21 fix did not extend to streaming.

**Suggested fix.** Either honor stream_options.include_usage by accumulating usage_delta across the tool loop (same logic as FIX 4) and emitting a final usage chunk on the empty-choices terminal chunk, or document explicitly that streaming usage is unsupported so clients don't silently get zeros.

<details><summary>Evidence</summary>

CONFIRMED but rated low. The streaming translator emits no usage object. translateStream (src/openai/streaming/sseTranslator.ts:84-126) only writes role/content-delta/tool_calls/final-stop/[DONE] chunks; usage_delta is explicitly listed as dropped at sseTranslator.ts:31 ("`message_stop`, `thinking_delta`, `usage_delta`, `tool_use_delta`,") and there is no buildUsageChunk anywhere in src/openai/streaming/ (chunks.ts has no usage builder; grep finds usage only in that drop comment). By contrast FIX 4 lives ONLY in the non-streaming branch: chatCompletions.ts:470-517 accumulates per-call usage and lines 579-583 emit `usage: { prompt_tokens, completion_tokens, total_tokens }`. So a client sending stream:true gets accurate behavior nowhere for usage while the non-streaming branch now reports correct totals — a real parity gap.

Not a duplicate of an already-fixed audit finding: the audit's matching finding (docs/07-history/audits/2026-06-10-full-codebase-audit.md:294) was explicitly scoped to "the non-streaming drain" and FIX 4 fixed only that; the streaming branch was never filed. The translator is byte-unchanged from baseline f661f24 (empty git diff), so this is a pre-existing v0 design limitation, not introduced/residual.

One factual nuance in the finder's writeup: stream_options is NOT "stripped by the schema." ChatRequestSchema uses `.passthrough()` (src/openai/mapping/schema.ts:67) and does not define stream_options, so the field survives parsing but is simply never read by the route — silently ignored, exactly the symptom claimed. This doesn't change the verdict.

Severity downgraded rationale: the sov serve OpenAI surface defaults to loopback 127.0.0.1 (trusted local), so no security boundary / cross-user leak / crash / data loss. The emitted content stream is fully correct; only the opt-in OpenAI stream_options.include_usage feature is unsupported, which most clients never request, and the translator header documents the v0 scope. Narrow contract/doc gap → low, not medium.

</details>

### F39. src/cli/missionRun.ts:215 — `low` · edge · CONFIRMED · _missed-by-audit_ · area:mission-eval-channels

**Summary.** No boundary validation of perWakeTurnBudget — a missing/non-numeric/zero value in a hand-edited or pre-field state.json yields maxTurns NaN/0, so query()'s loop never runs: the wake silently calls the model zero times yet still advances wakeCount and writes state.

**Failure scenario.** loadMissionState/readState (src/mission/state.ts:60) casts JSON to MissionStateJson with NO schema validation (only fsmState is checked). If state.json lacks `perWakeTurnBudget` (an older mission dir) or it was hand-edited to 0/non-numeric, then `resolveWakeMaxTurns(undefined, agentMaxTurns)` returns `Math.min(undefined, n)` = NaN, and `Math.min(NaN, Infinity)` = NaN. query()'s `for (let turn = 0; turn < NaN; turn++)` (core/query.ts:132) never executes — the model is never invoked — yet runMissionWakeLocked still writes wakeCount+1 and appends a wake-log entry, so a scheduled mission burns wakes making zero progress with no error surfaced.

**Suggested fix.** Validate perWakeTurnBudget in readState/loadMissionState (must be a finite integer >= 1; coerce to DEFAULT_PER_WAKE_TURN_BUDGET otherwise) and add a defensive floor in resolveWakeMaxTurns (treat undefined/NaN/<1 as the default), so a corrupt state.json fails loudly or falls back rather than silently no-op'ing the wake.

<details><summary>Evidence</summary>

Mechanism verified end-to-end at HEAD. resolveWakeMaxTurns (src/cli/missionRun.ts:52-54): `if (agentMaxTurns === undefined) return perWakeTurnBudget; return Math.min(perWakeTurnBudget, agentMaxTurns);`. The scheduled-mission agent always defines maxTurns (e.g. 20), so line 54 runs. With perWakeTurnBudget === undefined → Math.min(undefined, 20) = NaN; with perWakeTurnBudget === 0 or negative → Math.min(0, 20) = 0. The result is then `Math.min(..., userSettings.maxTurns ?? Infinity)` (missionRun.ts:215-218), so Math.min(NaN, Infinity) = NaN and Math.min(0, Infinity) = 0 both survive.

query() loop (src/core/query.ts:132): `for (let turn = 0; turn < maxTurns; turn++)` — `0 < NaN` is false and `0 < 0` is false, so the body never executes and the model is never invoked. The drain loop in runMissionWakeLocked (missionRun.ts:225-243) then immediately gets step.done and breaks with empty turnMessages.

Consequence is unconditional (missionRun.ts:266-280): `writeMissionState(stateDir, { fsmState: stateAfter, wakeCount: wakeNumber, updatedAt: ... })` advances wakeCount, and `appendWakeLog(...)` records a wake — regardless of whether any turn ran. So a scheduled `sov mission run` wake burns, advances wakeCount, logs a wake, and returns `{ transitionedTo }` with no error while doing zero work.

readState (src/mission/state.ts:60-68) does `JSON.parse(...) as MissionStateJson` with NO schema validation; only fsmState is checked in loadMissionState (state.ts:37). A missing, 0, negative, or non-numeric perWakeTurnBudget passes straight through.

This is a residual bug INTRODUCED by the M36 fix (FIX 1b / resolveWakeMaxTurns), which shipped in f661f24..HEAD (`git diff` confirms the helper and the new `maxTurns: Math.min(...)` are net-new). The audit's M36 flagged the opposite symptom (budget ignored → 100 turns); the fix added a Math.min with no floor for absent/non-positive input. The `mission run` subcommand was also re-registered (main.ts:708-729), so the path is live (launchd/cron unattended).

Severity low: parsePositiveInt (main.ts:143-149, `n <= 0` throws) blocks 0/non-numeric at the supported `sov mission init` boundary, so the trigger needs a hand-edited state.json or an older/foreign mission dir predating the field. Local trusted single-user surface, no security boundary, graceful degrade (silent no-op, not crash/corruption). Realistic but narrow upgrade-path hit; finder's low rating is correct.

</details>

### F40. src/cron/lockUtil.ts:29 — `low` · edge · PLAUSIBLE · _missed-by-audit_ · area:mission-eval-channels

**Summary.** Mission wake reuses cron's lock with the cron-tuned 6h staleness ceiling — a mission wake legitimately running longer than 6h has its lock reclaimed (mtime ceiling reclaims regardless of PID liveness), allowing a concurrent scheduled wake to mutate the same state.json.

**Failure scenario.** tryAcquireOnce's DEFAULT_STALE_CEILING_MS (6h) was sized for cron's sub-minute ticks. A mission wake holds the lock for an entire agent turn (up to perWakeTurnBudget tool-use turns running slow tools — long builds, web research). installLock stamps the lock dir's mtime once at acquire and never refreshes it. If one wake runs past 6h, the next launchd-scheduled wake's isLockStale() returns true via the mtime branch EVEN THOUGH the holder's PID is still alive, reclaims the lock, and runs a second wake concurrently — two wakes racing writeMissionState on the same state.json. Low probability but a real correctness window the shared-with-cron ceiling introduces.

**Suggested fix.** Either pass a mission-specific (larger) staleCeilingMs via tryAcquireOnce's opts for mission acquireLock, or refresh the lock dir's mtime periodically during a long wake (heartbeat). PID-liveness already guards the common case; only the mtime ceiling needs the longer bound for mission durations.

<details><summary>Evidence</summary>

The cited mechanism is real and correctly quoted, but the trigger requires a confluence that makes it uncertain — hence PLAUSIBLE, not CONFIRMED.

VERIFIED FACTS:
1. `src/mission/state.ts:81` — `export function acquireLock(dir: string): boolean { return tryAcquireOnce(lockPath(dir)); }` passes NO `staleCeilingMs`, so it falls to `DEFAULT_STALE_CEILING_MS = 6 * 60 * 60 * 1000` (lockUtil.ts:29). The ceiling's own doc comment is explicitly cron-sized: "A cron tick completes in well under a minute and the jobs lock is held for a single load→modify→save; 6h is comfortably longer than any legitimate hold" — NOT sized for a multi-turn agent wake.
2. `installLock` (lockUtil.ts:104-127) stamps the lock dir mtime once via the temp-dir `renameSync` and never refreshes it.
3. `isLockStale` (lockUtil.ts:92-96): `const mtime = lockMtimeMs(lockDir); if (mtime !== null && now - mtime > ceilingMs) return true;` — the mtime branch returns stale BEFORE the PID-liveness check, so a lock held by a LIVE process is reclaimable once >6h old. The candidate quotes this correctly.
4. The mission wake holds the lock across the full agent turn: `runMissionWake` acquires at missionRun.ts:97 then runs `runMissionWakeLocked` inside try/finally (lines 101-105). The turn is bounded only by turn count (`resolveWakeMaxTurns`, default `perWakeTurnBudget`=10) — there is NO wall-clock timeout / AbortController anywhere in the wake path (grep confirmed). So a wake on slow tools (builds, web research) could in principle exceed 6h.

WHY ONLY PLAUSIBLE (trigger uncertain):
- The launchd template uses `StartInterval` (ops `template.plist`). launchd does NOT start a second instance of a single job label while the prior is still running; it serializes. So the NORMAL single-mission launchd path cannot itself produce two concurrent wakes — the concurrent second wake must come from OUTSIDE launchd serialization (operator manually running `sov mission run --state-dir <same dir>` mid-wake, or a misconfigured duplicate job). That is on top of the already-rare >6h single-wake precondition.
- The overlap guard (`acquireLock`/`lockHeld`) IS designed for concurrent wake attempts, so the race window exists in code — but the realistic everyday trigger is thin.

SEVERITY (low per rubric): missions are reachable ONLY from `sov mission run` (src/main.ts) + launchd — confirmed NOT channel/server-reachable (grep: only main.ts and missionRun.ts reference runMissionWake; channels/server have no mission path). It is a trusted local/operator surface. Worst case is two concurrent `writeMissionState` on one state.json (last-writer-wins, atomic `renameSync` so no torn file), a rare-path correctness edge — no security-boundary crossing, no cross-user leak.

NOT a duplicate: the 2026-06-10 audit's mission findings (H21, M6) were about the wake being UNREACHABLE dead code and the maxTurns budget; none addressed the lock-staleness-ceiling mismatch. The fix `91a3dd8` ("reachable mission run") made this latent mismatch live, so it is a genuinely new/residual issue, not a re-derived or known-open item.

Suggested fix is sound: pass a mission-specific larger `staleCeilingMs` (the option already exists on `LockAcquireOptions`) or heartbeat the lock mtime — PID-liveness already covers the common dead-holder case; only the mtime ceiling needs a longer bound for mission wake durations.

</details>

### F41. src/hooks/runner.ts:77 — `low` · usability · CONFIRMED · _introduced-by-fix_ · area:extensions

**Summary.** The 'awaiting consent' notice (the post-audit signal for a transient 'skip') is logged on EVERY matching tool call with no de-duplication, so a `matcher: "*"` PreToolUse hook with no recorded consent floods stderr with one identical line per tool invocation per turn.

**Failure scenario.** User declares a PreToolUse hook with matcher `*` but never populates ~/.harness/shell-hooks-allowlist.json (the only way to enable it, since the runtime is always non-interactive). Every tool call in every turn hits the consent check, returns 'skip', and logs `[hook PreToolUse] awaiting consent: <cmd> (allow it in ...)`. A turn with 20 tool calls emits 20 identical lines; a long gateway session emits thousands. The runner is constructed once per long-lived runtime, so it could hold a 'already-warned' Set keyed by (event, command) but does not.

**Suggested fix.** Dedupe the awaiting-consent notice per (event, command) for the lifetime of the runner closure: keep a `const warnedSkips = new Set<string>()` in buildHookRunner and only log when `warnedSkips.add(consentKey(event, spec.command))` is newly added.

<details><summary>Evidence</summary>

The mechanism is fully present in current HEAD code and is post-audit feature code (introduced in the f661f24..HEAD fix wave, not a re-derived old bug).

OFFENDING CODE — src/hooks/runner.ts:72-80, inside the per-spec loop of the run() closure returned by buildHookRunner():
```
      if (decision === 'skip') {
        ...
        log(
          `[hook ${event}] awaiting consent: ${spec.command} (allow it in ~/.harness/shell-hooks-allowlist.json to enable this hook)`,
        );
        continue;
      }
```
There is no de-duplication keyed on (event, command); the line is emitted unconditionally every time the consent check returns 'skip'.

TRIGGER CHAIN (all verified in current code):
1. consent.ts:116,125 — `const interactive = opts.interactive ?? false;` then `if (!interactive) return 'skip';`. runtime.ts:1154-1160 builds the checker WITHOUT `interactive`, so it defaults false; every deployed surface is non-interactive. Therefore any (event, command) with no recorded allowlist entry returns 'skip' on EVERY call (nothing is persisted — consent.ts:122-125 returns before any write).
2. matcher.ts:26-28 — `matcher === '*'` (or undefined/'') returns true for every PreToolUse/PostToolUse event, so a `matcher:"*"` hook fires on every tool call.
3. orchestrator.ts:449-453 invokes `hookRunner('PreToolUse', ...)` per tool call → runner.ts:69-80 walks matching specs → 'skip' → log(). runner.ts:64 early-returns only when NO hook matches, so the flood is gated on the user having actually declared a matching hook.
4. buildHookRunner (runtime.ts:1161) is constructed once per long-lived runtime, so the closure could trivially hold a warned-set keyed by consentKey(event, command) — but does not.

Net: a user who declares a `matcher:"*"` PreToolUse hook and never populates shell-hooks-allowlist.json gets one identical stderr line per tool invocation per turn (20-tool turn = 20 lines; a long gateway session = thousands).

SEVERITY = LOW: stderr log spam on a self-inflicted misconfiguration (hook declared but never enabled, the only enable path being a hand-edited allowlist since the runtime is always non-interactive). No security boundary, no leak, no correctness break, no crash. The suggested fix (a `const warnedSkips = new Set<string>()` in buildHookRunner, log only on newly-added consentKey) is correct and matches the once-per-runtime closure lifetime. duplicate_of_audit=FALSE: this is residual log-spam in the very code the audit fix introduced, not an already-fixed bug nor a #17/#50-54 deferred item.

</details>

### F42. src/mcp/client.ts:191 — `low` · leak · PLAUSIBLE · _missed-by-audit_ · area:extensions

**Summary.** On a connect TIMEOUT, connectAndList tears down via `transport.close()` while the losing `client.connect(transport)` promise is still in-flight (it lost the Promise.race but is never awaited again); for a stdio transport whose child is still spawning, this can race the close against the spawn and leave/late-reap an orphan, and any later rejection of the abandoned connect promise is unhandled.

**Failure scenario.** A stdio MCP server whose process starts but never completes the MCP handshake within connectTimeoutMs. connectWithTimeout's race rejects via the timeout branch; connected stays false; connectAndList calls `transport.close()`. But the underlying `client.connect()` is still running (mid-spawn / mid-handshake) and is now orphaned: if close() runs before the child is fully spawned the child can survive, and when the abandoned connect promise eventually settles it does so with no awaiter (potential unhandledRejection). This is the exact orphan-subprocess class the M12 fix set out to close; the transport-close path narrows but doesn't fully eliminate it for the in-flight-connect timeout case.

**Suggested fix.** Drive cancellation through an AbortSignal threaded into client.connect so the in-flight connect is actually cancelled (not just raced), and attach a `.catch(() => {})` to the abandoned connect promise to swallow a late rejection. At minimum, after transport.close() on timeout, await the original connect promise (guarded by catch) before returning so the child is reaped deterministically.

<details><summary>Evidence</summary>

Verified at HEAD in src/mcp/client.ts. The candidate has two sub-claims; one is REFUTED and the core one is PLAUSIBLE-but-minor.

UNHANDLED-REJECTION (real, residual): connectWithTimeout races the connect against a timeout without ever re-attaching to the loser —
  client.ts:151  `await Promise.race([client.connect(transport), timeout]);`
On timeout the `timeout` promise wins; `client.connect(transport)` is left pending with NO `.catch`. connectAndList then tears down via the transport-close branch and re-throws, never re-referencing that promise —
  client.ts:190-192  `try { if (connected) await client.close(); else await transport.close(); } catch { ... }`
Per the SDK, Client.connect() can REJECT after start() (the `initialize` handshake over a now-closed transport): node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:323-326 `catch (error) { void this.close(); throw error; }`. With no global unhandledRejection handler in src/ (grep returned none), a late rejection of the abandoned connect surfaces as an unhandledRejection warning. The harness's own test even acknowledges this dangling-connect leak and manually settles it: tests/mcp/connectTimeout.test.ts:96-97 `// Let the dangling connect settle so it doesn't leak past the test. \n resolveConnect?.();`.

ORPHAN-SUBPROCESS (REFUTED): the claim that close() can race the spawn and leave an orphan does not hold. StdioClientTransport.start() assigns `this._process` synchronously as its FIRST statement (stdio.js:65 `this._process = spawn(...)`), before any async/event boundary; close() guards on `if (this._process)` (stdio.js:138) and runs the full SIGTERM→SIGKILL reap with a 'close' listener. So once connect() has entered start(), a subsequent transport.close() reliably reaps the child — the audit's connectAndList fix DID close the subprocess-leak it targeted.

SCOPE/SEVERITY: MCP servers come only from operator config (config/settings.ts:117 `mcpServers: z.record(...).optional()`; plugin MCP is disclosed-but-inert). Not reachable by an untrusted channel sender — no security boundary. Trigger is a misbehaving stdio/remote server that spawns but stalls the handshake past connectTimeoutMs (default 15s) then errors. Impact is at most a stray stderr unhandled-rejection warning on a rare operator-config path; the pool already logs "connection failed — disabled this session" and continues; no leak, no crash. duplicate_of_audit FALSE (the dangling-promise pattern was introduced by the post-audit connectAndList fix, cd9b205), but severity is genuinely LOW (matches the finder's rating); the finder's orphan-subprocess sub-claim is overstated.

</details>

### F43. packages/tui/internal/components/liveregion.go:213 — `low` · edge · CONFIRMED · _post-audit-feature_ · area:tui-go

**Summary.** reasoningView wraps at a fixed width=80 when the live width is <20, but the 8-line cap (reasoningSliverLines) is applied on the 80-col-wrapped lines. On a genuinely narrow terminal the terminal re-wraps each of those long lines, so the sliver can occupy far more than 8 visual rows and push the prompt off-screen.

**Failure scenario.** Terminal at width 12. A model streams a long chain-of-thought as thinking_delta. reasoningView() sees width=12 (<20) so it substitutes width=80, wraps the body into up to 8 lines of ~80 visible columns each, then the host terminal re-wraps each 80-col line into ~7 rows → up to ~56 rows of reasoning in the bottom live region, shoving the prompt/status below the visible viewport while the model thinks. The cap was meant to bound the sliver height but is computed against the wrong (80) width, not the real one.

**Suggested fix.** Wrap at the actual terminal width (clamp to a small floor like max(width,1)) instead of substituting 80, or cap on rows after wrapping at the real width. The reasoning sliver is ephemeral so correctness of height matters more than line length.

<details><summary>Evidence</summary>

Offending code confirmed verbatim at packages/tui/internal/components/liveregion.go:213-216 inside reasoningView():
  width := l.width
  if width < 20 {
      width = 80
  }
  wrapped := lipgloss.NewStyle().Width(width).Render(body)
The 8-line cap (const reasoningSliverLines = 8, line 48) is applied at lines 222-224 against this possibly-80 width, not the real terminal width.

Width flow is unguarded: app.go:886 `m.width = msg.Width` takes the raw terminal width with NO minimum-size guard; recomputeLayout() at app.go:693 calls `m.live.SetWidth(m.width)` → l.width. A 12-column terminal therefore yields l.width=12, triggering the substitution to 80.

Consequence confirmed: View() (lines 291-292) appends reasoningView()+"\n" into the bottom builder, and app.go View() (lines 2509-2514) writes that `live` string verbatim, then appends prompt/status BELOW it. There is no height clamp on the live region (inline non-altscreen mode; committed history goes to native scrollback). So 8 logical lines wrapped at 80 cols, displayed on a 12-col terminal, get re-wrapped by the host terminal into ~ceil(80/12)=7 physical rows each = up to ~56 visual rows, pushing the prompt/status off-screen while the model streams thinking_delta. The cap bounds logical lines at the wrong width, not visual rows at the real width.

Reasoning-specific: the answer-stream path passes the REAL l.width to render.Markdown (liveregion.go:135, only guarding width<=0 → Plain fallback at markdown.go:45-55), so it does NOT have this over-height defect. reasoningView is the only place substituting 80 for narrow widths.

Not a duplicate/deferred: `git diff f661f24..HEAD` shows the entire reasoning sliver (reasoningSliverLines, reasoning buffer, reasoningView) was INTRODUCED in the audit fix wave. The audit doc (docs/07-history/audits/2026-06-10-full-codebase-audit.md) covered liveregion.go for M44 (80ms perf re-render) and the ESC-unfinalized-buffer issue but never flagged the `width < 20 → 80` substitution (grep for `width < 20`/`width = 80`/`narrow`/`re-wrap` returns no match in the audit). M43 is a different over-width-fold bug in markdown.go. This is a residual edge-case in audit-introduced code.

Severity low: local trusted TUI surface only, no security boundary / data leak / crash / channel exposure; the sliver is ephemeral (ClearReasoning on answer start / turn end, lines 197-199); trigger requires a sub-20-column terminal (extremely rare) plus active long chain-of-thought streaming. Matches the finder's low rating.

</details>

### F44. packages/tui/internal/app/app.go:2421 — `low` · edge · PLAUSIBLE · _introduced-by-fix_ · area:tui-go

**Summary.** submitQueuedTurn (FIX 8) guards on m.baseURL but not m.ctx.Err(); a queued turn fired from a terminal turn_error/turn_complete after the user has quit (Ctrl+C) still issues a POST /turns on the cancelled context.

**Failure scenario.** User queues a second message mid-stream (pendingSubmission set), then presses Ctrl+C/ESC to quit while the first turn is still wrapping up. The turn_complete/turn_error handler runs submitQueuedTurn(), which checks only baseURL!='' and then calls submitTurn(text). submitTurn builds the request with m.ctx (now cancelled) so http.DefaultClient.Do fails immediately and returns turnSubmitErrMsg, printing a stray 'submit error: context canceled' line at shutdown. Harmless data-wise but surfaces a confusing error during teardown.

**Suggested fix.** Add `if m.ctx.Err() != nil { return nil }` at the top of submitQueuedTurn (mirroring the sseDoneMsg/sseReconnectMsg guards) before dispatching the queued POST.

<details><summary>Evidence</summary>

The code claim is accurate. submitQueuedTurn (app.go:2421-2441) guards only on pendingSubmission and baseURL — no ctx check:

  func (m *Model) submitQueuedTurn() tea.Cmd {
      if m.pendingSubmission == "" { return nil }
      ...
      if m.baseURL == "" { return nil }      // line 2428 — only guard
      ...
      return tea.Batch(m.submitTurn(text), spinCmd)   // line 2440
  }

submitTurn (line 2618) builds the request on m.ctx: `req, err := http.NewRequestWithContext(m.ctx, http.MethodPost, turnsURL, ...)`; a cancelled m.ctx makes http.DefaultClient.Do return "context canceled" -> turnSubmitErrMsg, which the handler at line 1585-1589 prints as `"submit error: %v"`. m.cancel() (line 1204, on Ctrl+C) cancels exactly m.ctx (created `context.WithCancel(context.Background())` at line 509).

The cited "mirror" pattern is real and confirms submitQueuedTurn is the outlier: sseDoneMsg (line 1534) and sseReconnectMsg (line 1579) both guard `if ... m.ctx.Err() != nil || m.baseURL == ""`, with the explicit comment at line 1529: "app context is cancelled (user pressed ESC / Ctrl+C)". So the missing ctx guard is a genuine inconsistency.

WHY ONLY PLAUSIBLE (trigger uncertain, partly self-defeating): The finder's LITERAL ordering — "press Ctrl+C while the first turn is still wrapping up (before turn_complete/turn_error)" — does NOT fire the bug. Ctrl+C returns `m.cancel(); return m, tea.Quit` (lines 1204-1205); tea.Quit stops the Bubble Tea event loop, so the later terminal SSE event is never delivered to Update and submitQueuedTurn never runs. The bug can only fire in a sub-millisecond goroutine race: the terminal SSE event must be processed FIRST (handleEvent at 1469 -> submitQueuedTurn returns the submitTurn Cmd, dispatched via m.respond/tea.Batch at 1474 on its own goroutine), then Ctrl+C lands in a SUBSEQUENT Update calling m.cancel() before that goroutine reaches http.DefaultClient.Do. Even when it wins the race, Ctrl+C also returns tea.Quit, so whether the stray "submit error: context canceled" line is rendered before teardown is itself racy.

IMPACT: trusted local single-user TUI surface; no data corruption, no leak, no security boundary — at worst a cosmetic stray error line at shutdown in a tight race. Correctly rated low. New/residual: post-audit FIX 8 introduced submitQueuedTurn without the ctx guard its two SSE-handler siblings carry; not a re-derivation of an already-fixed audit finding.

</details>

### F45. packages/tui/internal/render/markdown.go:316 — `low` · edge · CONFIRMED · _introduced-by-fix_ · area:tui-go

**Summary.** tryFoldIntoNextLine (FIX 5) drops the next line's leading indentation when folding an orphan word DOWN into it, and its width check right-trims the merged content while the stored line is not right-trimmed — both can produce slightly mis-measured / re-indented output.

**Failure scenario.** When an orphan word can't fold UP without exceeding width, tryFoldIntoNextLine prepends it to lines[i+1] as `orphanWord + ' ' + nextLeftTrimmed` (line 322). nextLeftTrimmed has its LEADING whitespace stripped (line 316), so an indented continuation line loses its left margin in the merged result, shifting alignment within a paragraph. Separately, the fit check measures `TrimRight(nextLeftTrimmed)` (line 318) but the stored value keeps any trailing spaces, so a line with trailing padding can be stored slightly wider than the width check approved. Both are cosmetic (guarded by isStructuralLine so list/table chrome is skipped) and only hit the rare width-overflow fold-down branch.

**Suggested fix.** Preserve the original leading indentation of lines[i+1] when prepending, and measure the exact string that will be stored (don't right-trim only in the check). Or skip fold-down entirely when the next line is indented relative to the orphan's paragraph.

<details><summary>Evidence</summary>

Both mechanical claims are literally accurate against the current code in tryFoldIntoNextLine (introduced post-audit by commit 3143126, the FIX 5 "wrap width" item — so this is fix-introduced residual code, not a re-derivation of an already-corrected bug).

Claim 1 (re-indentation): line 316 `nextLeftTrimmed := strings.TrimLeft(next, " \t")` strips the next line's leading whitespace, and line 321 stores `lines[i+1] = orphanWord + " " + nextLeftTrimmed`. So when an orphan folds DOWN, the next line's left margin is dropped. For an indented non-structural prose continuation line (e.g. a glamour list-body/blockquote continuation whose trimmed content is not a bullet, so it passes the `isStructuralLine(nextTrim)` guard at line 313), the merged line is re-emitted at column 0 — losing the paragraph's uniform indent. Real, observable, but cosmetic.

Claim 2 (width mismatch): the fit check at line 318 measures `lipgloss.Width(orphanWord)+1+lipgloss.Width(strings.TrimRight(nextLeftTrimmed, " \t"))` (right-trimmed), while line 321 stores the un-right-trimmed `nextLeftTrimmed`. If `next` carries trailing spaces, the stored line is wider than the check approved. The trigger (trailing-space-padded NON-structural prose from glamour) is uncertain — glamour pads table cells (excluded as structural) but not generally plain prose — and trailing spaces at the wrap column are visually inconsequential.

Severity is low: this is the TUI markdown renderer, a local trusted single-user surface (TUI / sov drive). Worst case is subtle mis-indentation or a few invisible trailing spaces on the rare prev-overflow fold-DOWN branch. No crash, no cross-user leak, no data-path correctness break. The finder's own low/cosmetic framing is correct.

duplicate_of_audit is FALSE: the divergence genuinely exists in current HEAD code, it is not already-correctly-handled, and it is not a known-open deferred item (#17/#50-54/#58). It is a residual cosmetic defect inside the audit's FIX 5 helper.

</details>

### F46. src/cli/driveCommand.ts:336 — `low` · bug · PLAUSIBLE · _introduced-by-fix_ · area:sweep

**Summary.** DriveSseManager.advanceCursor's session-pairing guard is non-functional — its two operands are updated in lockstep by pivot(), so residual old-bus events after a mid-turn compaction pivot poison the reconnect cursor and the new child session bus skips low-seq events.

**Failure scenario.** In `sov drive`, a turn triggers compaction. The server emits `compaction_complete` (with `activeSessionId` = the child session) on the OLD parent bus, then the parent bus keeps streaming the remainder of the turn before it closes. The drain loop (drainSseStream lines 800-810) processes EVERY complete SSE block already buffered in one network chunk synchronously, with NO abort recheck. For `compaction_complete`: advanceCursor runs first (activeSessionId===cursorSession===OLD, advances cursor to its seq), then onEvent calls pivot() which sets activeSessionId, cursor=null, and cursorSession ALL to the child session id and aborts the connection. For the NEXT old-bus event still in the same buffered chunk: advanceCursor runs, and its guard `if (this.activeSessionId !== this.cursorSession) return` is now FALSE because pivot() set BOTH fields to the child id — so it executes `this.cursor = ev.seq`, writing an OLD-bus (high) seq. On reconnect to the child bus (its own seq space starting at 1) the loop sends `Last-Event-ID: <stale-high-old-seq>`; the child bus treats it as above-window and the fresh subscriber SKIPS the child's lower-numbered events. The code comment (lines 320-323, 329-334) explicitly claims this is prevented ('advanceCursor only advances within the current session'), but the guard compares activeSessionId against cursorSession, which pivot() always sets equal — the intended comparison is against the CONNECTION's session (connSessionId, captured at run() line 349 but never passed into advanceCursor).

**Suggested fix.** Pass the connection's session id (connSessionId from run()) into advanceCursor and guard on `if (ev's connection session !== this.activeSessionId) return` (i.e. drop cursor advances for events arriving on a connection whose session is no longer active), OR record the session a cursor belongs to at advance time and compare the EVENT's originating connection session rather than this.cursorSession. Functionally: residual events from the pre-pivot connection must never bump the post-pivot cursor.

<details><summary>Evidence</summary>

The candidate's MECHANISM is verifiably real but its claimed HARM (fresh child subscriber skips the child bus's low-seq events on reconnect) is NOT demonstrable with concrete state.

VERIFIED MECHANISM (real):
- src/cli/driveCommand.ts:291-296 `pivot()` updates the two guard operands in lockstep: `this.activeSessionId = newSessionId; this.cursor = null; this.cursorSession = newSessionId;`
- src/cli/driveCommand.ts:335-338 `advanceCursor`: `if (this.activeSessionId !== this.cursorSession) return; this.cursor = ev.seq;` — after a pivot both fields equal the child id, so the guard is FALSE and a residual old-bus event processed in the same buffered chunk DOES execute `this.cursor = ev.seq`, writing an old-bus seq after the reset-to-null. The drain inner loop (lines 800-810) processes every buffered SSE block synchronously with no abort recheck, so `onEvent`→`pivot()` (line 324-326) and a following residual event are processed before the abort takes effect at the next `reader.read()`. So the guard at line 336 is indeed an ineffective no-op for the case its own comment (lines 320-323, 329-334) claims it prevents.

WHY THE CLAIMED HARM DOES NOT MANIFEST:
1. ALL turn events stream on the PARENT bus, not the child. `bus` is captured once at turns.ts:223 (`getOrCreateBus(sessionId)` at the parent id) and passed to `runTurnInBackground`; the local `sessionId` is reassigned to the child after compaction (turns.ts:582) but the `bus` parameter never changes — every text_delta/tool/turn_complete publishes to the parent bus (turns.ts:783, 820-821, 877). tests/server/turns.proactiveCompact.test.ts:104-110 proves compaction_complete AND the subsequent text_delta all appear on the single parent `GET /sessions/{parent}/events` stream.
2. Therefore at the post-pivot reconnect to `GET /sessions/CHILD/events`, the child bus ring is EMPTY (its events come only from a future turn POSTed to the child id). eventBus.ts:224 `this.ring.filter((ev) => ev.seq > lastEventId)` over an empty ring replays nothing — no events to skip.
3. The poisoned cursor is OVERWRITTEN, not max'd: advanceCursor does `this.cursor = ev.seq` (line 337), so the first live child-bus event (seq 1) the subscriber processes self-corrects the cursor away from the stale-high value before any replay-based resume could occur.
4. The real residual hazard in a mid-turn compaction is that drive pivots/reconnects to the child bus immediately and thus ABANDONS the parent bus where turn_complete fires (handle() resolves the turn only on turn_complete/turn_error/session_summary, lines 458-469) — a DIFFERENT issue (drive's mid-turn-pivot diverges from the TUI, which app.go:823-825 deliberately keeps on the original bus until turn end). The candidate did not identify this.

The existing FIX-1b test (tests/cli/driveCommand.pivot.test.ts:134-156) only exercises an explicit `pivot()` with no residual event, so the dead-guard case is genuinely uncovered post-audit feature code — not a re-filed audit item. Net: a latent ineffective guard / dead-code-smell with no demonstrable event loss; rated low.

</details>
