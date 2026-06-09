# State snapshot — 2026-06-09 — Plugin System v1 (consent-gated skill/command packs)

**Canonical current-state snapshot.** Release **v0.6.35** (2026-06-09). HEAD on `master`.

This snapshot is also the **catch-up** for the whole wave of work since the last written snapshot (Phase F / v0.6.23, 2026-06-06): SMS channel, subscription-executor spike, remote MCP transport, Claude-Code skill import + tool-scope enforcement, and the `sov` local-engine provider all shipped between snapshots and are summarized below.

---

## Headline — Plugin System v1 shipped (arc **D** of harness ecosystem-openness)

A **consent-gated plugin system** (`src/plugins/`) that bundles **skills + slash-commands** as one installable, distributable unit — per ADR H-0010 ("rent the commodity engine + ecosystem, own the differentiators"). It is the strategic piece after the ecosystem-openness arc: **A** (Claude-Code skill import) + **B** (tool-scope enforcement) shipped v0.6.29; **C** (remote MCP transport) shipped v0.6.30; **D** (this) is a single installable unit bundling multiple extension types.

**Founder-approved scope (the recommended v1 from the spec §5):** the plugin *foundation* (manifest, loader, composition seams, consent + integrity infrastructure) plus the only extension types safe to ship today — **skills + slash-commands**. A Claude-Code-format skill/command pack installs and works; a richer CC plugin's **hooks / MCP servers / agents are disclosed but inert** (deferred to v2/v3). The honest CC-compat position: *opportunistic* — "install Claude-Code-format skill/command packs; richer plugins import with their advanced components disclosed and deferred." Do NOT headline full CC compatibility.

Spec: `docs/specs/2026-06-08-plugin-system-design.md` (§4 security model S1–S7, §5 staged scope, §11 founder decisions). Plan: `docs/plans/2026-06-08-plugin-system-v1.md` (T1–T9). No new in-repo ADRs (built per ADR H-0010, canonical in `sovereign-ai-docs`); no bundle changes.

### The security model — the entire problem, and what holds

Two adversarial reviews of the first-draft spec found the naive design unsafe; v1 rests on three load-bearing controls (verified end-to-end against an adversarial plugin in the **integrated** system — see the security verdict):

- **S1 — load-time consent gate, integrity-bound.** A plugin contributes **nothing** unless a valid `.consent.json` exists AND a fresh recompute of the whole-tree content hash matches the hash recorded at consent. No record / hash mismatch (tree edited after consent) ⇒ the **entire plugin is inert + flagged** `needs-consent`/`tampered`. Directory-presence may *discover* a plugin (to list it) but NEVER *enable* it. Enforced at **every boot** at the wiring layer (`loader.ts` `evaluateGate` → `verifyConsent` → `hashPluginTree`), independent of the install path — a hand-dropped plugin is inert.
- **S2 — plugin skills are declarative-only: inline shell disabled.** Skill bodies can carry `` `!cmd` `` which expands via `Bun.spawn` *outside* the permission layer. For `source:'plugin'` skills this is **forced off** at the skill-loader chokepoint (`allowShellInterpolation:false`, not manifest-controlled) and double-gated in `expandSkillText` (`allowShellInterpolation && source !== 'plugin'`). The guard remains a supplementary tripwire, never the boundary.
- **S3 — install-time disclose-and-consent, TTY-only.** `installPlugin` is the **only** legitimate `writeConsent` caller. `/plugins install <dir>` runs every gate (manifest secret-scan, path-containment, symlink-reject, guard-scan of skill/command content + bundled scripts) **before** rendering a capability-framed disclosure, then a `y/N` consent. The TTY `confirm` is wired ONLY when `process.stdin.isTTY` (the CLI/`sov drive` path); the server / gateway / web-UI / channel command contexts never set it, so install **refuses everywhere except a local terminal**. Accept → `copySkillTree` + mint `.consent.json` (tree-hash + per-component decisions + `pluginId`).

Composition + precedence: plugin skills splice into the loader **after user, before bundle** → `project > user > plugin > bundle` (a plugin can override a bundle skill but NEVER shadow a user/project skill); built-in slash commands always win over plugin commands (`[...COMMANDS, ...pluginCommands, ...buildSkillCommands]`, first-wins registry). `${CLAUDE_PLUGIN_ROOT}` resolves to the install dir in plugin skill/command bodies (carried on the `Skill`, preserved through `reloadSkill`). Plugins load at boot — **restart-to-apply**. Opt-in config `plugins: { enabled?: string[], disabled?: string[] }` (`.strict()`); `disabled` wins, `enabled` (when set) is an allow-list.

### How it was built — subagent-driven, two-stage + adversarial review

Built with `superpowers:subagent-driven-development`: a fresh **Opus** implementer per task + **two-stage review** (spec-compliance, then code-quality) per task, TDD RED→GREEN throughout. The three security-trio tasks (T3 consent gate, T5 inline-shell-disable, T6 install-consent) each got an **additional dedicated adversarial security review**; the integrated feature got a **whole-feature adversarial review** at T9.

- **Prerequisite (`79a1b7f`): backlog #55 fixed first** to clean the gate. Root cause was bigger than scoped — `buildRuntime` accepted `harnessHome` but didn't thread it into `SessionDb.open` (opened the global 1.18 GB `~/.harness/sessions.db` → contention → turn timeout → the learning observer never drained → the #55 false failures) nor `readConfig`. Threaded `harnessHome` through both (backward-compatible `readConfig` overload). Resolves the previously-documented "3 known env-only learning-test fails."
- **T1–T9 chain (`85ff11e … 76171d9`).** Module: `types`/`manifest` (strict known-subset Zod, unknown CC keys → `ignored[]`) + `secretScan` (field-targeted literal-secret detector); `integrity` (deterministic NUL-separated path-sorted SHA-256 tree-hash, excludes `.consent.json`) + `consent` (record + atomic write + strict `verifyConsent`); `loader` (the consent gate; default-deny); `compose` (active plugins → `skillRoots` + `commands` + inert disclosures; M1 path-containment; `${CLAUDE_PLUGIN_ROOT}`); the skills-loader S2 edit + `extraRoots`; `install`/`disclosure` (TTY consent); `pluginOps` (`/plugins install|uninstall|enable|disable|list|info`) + the opt-in config + H3 hook/mcp merge extraction; runtime wiring (`loadPluginRuntime` into `buildRuntime` + `dispatchCommand`, HarnessInfo surfacing, single-readline TTY confirm); `pathContainment` consolidation + a manifest drift-guard.

**Notable review catches (found + fixed before ship):** T3 review caught a **symlink-to-directory EISDIR DoS** that would crash the whole `loadPlugins` scan (a boot-time DoS once wired) — fixed `c873f68`. T5 proved **C2** RED→GREEN: a plugin skill's `` `!echo PWNED` `` *executed* on the pre-fix code and is inert after. T6 review caught a **disclosure-fidelity gap** (install scanned `.md` bodies independently while the loader aggregates a directory-skill's reference files — a malicious `payload.txt` invisible at consent but blocking at load) — fixed `8aa437a` (install now reuses the loader's aggregating `guardSkillLoad`, parity exact).

### Security verdict — SECURE-TO-SHIP

Whole-feature adversarial review of the integrated, wired feature: **no Critical/High.** Every cross-task / emergent attack is blocked at the wiring layer, not just in isolation — drop→load→invoke (unconsented contributes nothing), post-consent tamper (re-verified every boot), cross-seam shell laundering (single gated sink, `source:'plugin'` forced + double-gated), command-precedence shadowing (built-ins win; plugin can't shadow user/project), consent minting (sole `writeConsent` caller; TTY-only, unreachable from remote surfaces), multi-user/channel leakage (operator-shared install surface, no per-user namespace to cross, no remote install path), and DoS (symlink-cycle-safe walks; per-plugin fail-soft `evaluateGateSafe`). Two accepted-risk LOWs remain bounded: the scan-then-copy TOCTOU (consent binds the copied bytes; execution can't diverge from consent) and the lone-symlink-add-post-consent gap — *narrower* than feared, since a symlink is invisible to BOTH the tree-hash AND the skill enumeration, so it never loads.

### Known v1 limitations (documented, not bugs)

- **Plugin agents / remote MCP / hooks / stdio-MCP are NOT active** — disclosed-and-inert in v1 (v2 = agents + remote MCP with named hardening; v3 = hooks + stdio-MCP + registry/marketplace). v1's standalone value is close to the shipped `/skills import`; the payoff is the reusable **foundation** that makes those safe to add later.
- **Restart-to-apply** — plugins load at boot; `enable`/`disable`/`install` take effect next session.
- **TTY-only install** — the gateway / web-UI cannot install plugins in v1 (no TTY); deferred with the cross-surface `preview→accept` route + a registry.
- **Secret-scan is best-effort + disclosed-not-made-safe** — the consent gate, not the scanner, is the boundary (e.g. a pure-hex blob in a non-credential field can slip the standalone entropy check; field-targeting covers credential-named fields).
- A `GET /sessions/:id/commands` discovery route lists built-in `COMMANDS` only (not plugin commands) — TUI autocomplete of plugin commands is a clean follow-up.

### Gate

`bun run lint` clean (740 files) · `bun run typecheck` clean · `bun run test` **3555 pass / 0 fail / 16 skip** (clean `HARNESS_HOME`; 3571 across 390 files, ~61 s). Docs: `docs/usage.md` (`/plugins` section), `docs/architecture.md` (plugin layer + consent/integrity model), `docs/extending.md` (authoring a plugin).

---

## Catch-up — the wave since Phase F (v0.6.23 → v0.6.34), un-snapshotted until now

These shipped between snapshots. Each has a spec under `docs/specs/`; none has its own state snapshot (this is their record):

- **SMS channel (Twilio) — v0.6.26.** A post-Phase-F channel: Twilio webhook (signature + sender allow-list) → safe-posture harness turn → async reply via the Messages REST API. Allow-listed, per-sender-isolated, safe-by-default. Spec `2026-06-06-sms-channel-design.md`. (iMessage feasibility spiked → **NO-GO by default**; `2026-06-06-imessage-channel-feasibility.md`.)
- **Subscription-executor spike — v0.6.27 (bypass-default v0.6.32).** Opt-in (off by default) sub-agent executor that branches `SubagentScheduler.delegate()` to a headless `claude -p` subprocess (Claude Code's own agentic loop), returning the native `drainRunner` shape so the scheduler tail is byte-unchanged; per-tool work replayed into the learning corpus/trace, canonicalized to the native tool vocabulary. Wired ONLY to the interactive sub-agent seam (NOT cron/channels/gateway — driving a Claude *subscription* credential as an automated backend crosses the personal-use ToS boundary). `permissionMode` default flipped to `bypass` (v0.6.32: a headless `claude -p` has no approver; bounded to the attended seam). Spec `2026-06-08-subscription-executor-spike.md`.
- **Claude-Code skill import + tool-scope enforcement — v0.6.29** (ecosystem-openness arcs **A** + **B**). `/skills import` of CC-format SKILL.md (the `allowed-tools` alias + comma-split normalization) + enforcement of a skill's `allowedTools` on the `/skill` dispatch path. Spec `2026-06-08-skill-import-and-tool-scope-enforcement-design.md`. (A review-cluster of fixes F1/F2/F9/F10/F14 followed.)
- **Remote MCP transport (HTTP / SSE) — v0.6.30** (arc **C**). Remote MCP servers over HTTP + legacy SSE with `SOV_MCP_*` env-first auth; cross-origin redirect header-stripping (secret-leak fix), SSRF heuristic, alias env-fragment collision rejection. Spec `2026-06-08-remote-mcp-transport-design.md`.
- **`sov` local-engine provider, Bucket A — v0.6.34.** A first-class keyless `sov` provider so the harness can use our own L1 inference engine (`~/code/sovereign-ai-inference`, a standalone OpenAI-compatible MLX server on `127.0.0.1:8000`) as a local lane. Bucket A = zero engine changes (consume what the engine already emits): the shared OpenAI stream translator now maps `delta.reasoning_content` → `thinking_delta` (reasoning no longer contaminates `content`; benefits `openai`/`openrouter` too); `SovProvider` = keyless `OpenAIProvider` (apiMode `sov`, loopback default, no auth); `sov` selectable as `router.localProvider`. **Buckets B (`/sov/*` control-plane reads) + C (engine-fork residue) remain** (separate plans; B is cross-repo co-design, C is dogfood-gated). T4-live (`fd6a096`) verified the lane against a running engine. Spec `2026-06-08-sov-provider-design.md`, plan `2026-06-08-sov-provider-bucket-a.md`.
- **v0.6.33 — CRITICAL fix: infinite turn re-stream.** TUI/`sov drive` clients reconnected the SSE stream WITHOUT `Last-Event-ID`, so a post-`turn_complete` reconnect replayed the just-completed turn forever. Fixed client-side (send `Last-Event-ID` on reconnect; server unchanged). Two new test-isolation backlog items filed: **#55** (learning tests leak into global `~/.harness` — **now FIXED this session** as the plugin-build prerequisite) and **#56** (stale Go `TestM9_ThemeSwitchAltersRender` + Go tests not run in CI — still **OPEN**).

---

## Learning-loop soak — standing #1, untouched

The portable four-port learning layer (`src/learning-layer/`, ADR H-0010) remains closed and running by default: **recall ON by default** (since v0.6.16) splices synthesized instincts into the latest user message; capture + background synthesis on. This session's #55 fix actually *helped* the soak — the learning observer no longer races the giant global DB. Keep observing recall relevance + synthesis quality during normal work; record in `docs/testing-log.md`. The founder-reserved calls (Phase-2 rented engine, go/no-go, auto-promote-by-default) are unchanged.

---

## What's next / open

- **Cross-repo `sovereign-ai-docs` sync** still pending (a docs session): the run-anywhere roadmap (A–F) COMPLETE, the post-Phase-F wave (SMS / sub-executor / MCP-remote / skill-import / sov-provider), and now **Plugin System v1** + the `plugin-system` arc. Mark the plugin spec Status and the ecosystem-openness arc (A/B/C/D shipped).
- **Plugin v2** (when warranted): plugin agents (full ceiling) + remote MCP (private-host-reject) — the spec §5 stages them.
- **`sov` provider Buckets B + C** — control-plane reads (cross-repo) + engine-fork residue (dogfood-gated).
- **Backlog #56** (P4) — the stale Go theme test + adding `go test ./...` to CI preflight. Still open.
- Plugin v1 follow-ups: surface plugin commands in the TUI `/commands` discovery route; a TUI `/plugins install` verb (the CLI TTY path suffices today).
