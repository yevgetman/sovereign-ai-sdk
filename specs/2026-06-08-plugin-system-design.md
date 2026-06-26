# Plugin System — Design Spec

**Date:** 2026-06-08
**Status:** DRAFT FOR FOUNDER REVIEW (spec + plan only — NOT approved for build). **Revised after two adversarial reviews** (architecture + security); see §12 for what they found.
**Arc:** **D** of the harness ecosystem-openness work — A (CC-skill import) + B (tool-scope enforcement) shipped v0.6.29; C (remote MCP transport) shipped v0.6.30. D is the strategic piece: a single installable unit bundling multiple extension types.

---

## 0. Executive summary (read this first)

A plugin bundles **skills + sub-agents + slash-commands + hooks + MCP servers** as one installable unit. The *plumbing* is genuinely low-risk: each extension type already has exactly one composition seam, so a plugin layer just produces five contributions and injects them (§3). **The security model is the entire problem**, and the first-draft spec got it wrong. Adversarial review (§12) confirmed two false premises against the code:

1. **Plugin skills are NOT model-mediated.** A skill body runs shell at *expansion time* (`` `!cmd` `` → `Bun.spawn`, `src/skills/loader.ts:323-364`), outside the permission layer. The guard that was supposed to catch this is a thin keyword denylist — review broke it with 9/10 trivial exfil payloads. **A plugin skill is unmediated shell.**
2. **There is no load-time consent gate.** Discovery is directory-presence; a plugin dropped into `~/.harness/plugins/` loads with no consent. And consent has no architectural home (the server is headless; the only consent primitive is a per-tool TTY prompt at execution time).

The consequence: the safe v1 is **much narrower** than first drafted, and is built as a **staged roadmap** — a hardened *foundation + declarative core* first, then each higher-risk extension type layered in with its specific hardening. This is the same incremental, independently-shippable pattern A/B/C followed. The honest CC-compatibility position: **opportunistic in v1** (load a CC plugin's supported components, disclose+skip the rest), full compat only when agents/MCP/hooks land.

**The founder decisions are in §11.** The headline one: build the staged foundation (recommended), or treat plugins as not-yet-worth-it and instead extend A (skill import) to multi-skill bundles. Because a *safe* v1 is close in value to the shipped `/skills import`, the value of the plugin system is realized across v2/v3 (agents, MCP, hooks) — v1's worth is the **foundation** (manifest, loader, composition seams, the consent + integrity infrastructure) that makes those safe to add.

## 1. Goal

One installable, distributable unit that contributes multiple extension types, so the harness can consume capability packs (and, compatibility permitting, the Claude Code plugin ecosystem) — per ADR H-0010 ("rent the commodity engine + ecosystem, own the differentiators"). The non-negotiable constraint: **installing a plugin must not silently grant third-party code unmediated execution or network reach.**

## 2. What exists today (verified)

Five extension types load à la carte, each with one composition seam; no plugin unit, manifest, or registry exists.

| Type | Contribution shape | Seam (`file:line`) |
|---|---|---|
| Skills | ordered search-path roots | `src/skills/loader.ts:103-130` |
| Agents | ordered search-path roots | `src/agents/loader.ts:59-77` |
| Slash commands | `[...COMMANDS, ...buildSkillCommands(...)]` (two sites) | `src/server/commandContext.ts:127` + `src/cli/dispatchCommand.ts:112` |
| Hooks | additive `hooksByEvent` (collision/enable logic inline, not callable) | `src/config/settings.ts:193-213` |
| MCP servers | `Record<alias, McpServerConfig>` (collision checks inline) | `src/config/settings.ts:224-259` |

Reused from A+B+C: `src/skills/frontmatter.ts` (CC alias), `installSkill`/`copySkillTree`/`assertNoSymlinkEscape` (`src/skills/install.ts`, `symlinkGuard.ts`), the guard (`src/skills/guard.ts`), tool-scope (`src/commands/toolScope.ts`), MCP auth/redaction/safe-fetch (`src/mcp/auth.ts`, `safeFetch.ts`), and — importantly — `src/channels/permission.ts`, the strongest safe-by-default precedent (never inherits local allow-rules, auto-denies, rejects bypass).

## 3. Architecture (the plumbing — low-risk, unchanged by review)

A pure-aggregator `src/plugins/` module: discover installed+**consented**+enabled plugins, validate manifests, resolve contributions, expose them in the five seam shapes. It does not run hooks, connect MCP, or expand skills.

```
src/plugins/{types,manifest,loader,compose,install,consent,guard,integrity}.ts
src/commands/pluginOps.ts            # the /plugins command
```

- **Manifest** (CC-compatible location `.claude-plugin/plugin.json`): identity (`name`/`version`/`description`/`author?`), convention-discovered component dirs (`skills/`, `commands/`; `agents/` at v2), inline `hooks`/`mcpServers` (deferred types — declared, disclosed, inert). Parsed with a **strict known-subset schema**; unknown/CC-only keys collected into an explicit `ignored[]` and **shown in the consent disclosure** (never silently dropped). Re-verify CC's current format at build time.
- **Composition + precedence:** plugin roots splice into the loaders **after user, before bundle** → `project > user > plugin > bundle` (a plugin can override the ambient bundle but NEVER shadow a user/project skill/agent — H2; add a test asserting this). Built-in slash commands always win over plugin commands. Inter-plugin order is **deterministic (alphabetical by plugin name)**. First-wins + realpath dedupe inherited; collisions log a provenance-stamped warning.
- **Wiring:** one `loadPlugins(...)` in `buildRuntime`, threading `extraRoots` into `loadAgents`/`loadSkills`; `dispatchCommand` gets plugin skills/agents/commands **only** (it has no MCP/hooks seam — H4). Restart-to-apply.
- **`${CLAUDE_PLUGIN_ROOT}`** must be a first-class interpolation var threaded through **skills, commands** (and agents at v2) — not just hooks/MCP (H1). v1 alias it to the plugin's install dir; a plugin skill referencing it resolves its bundled files; otherwise CC-compat is silently broken.

## 4. Security model (CORRECTED — the crux)

The model now rests on facts, not the two false premises:

**S1 — Load-time consent gate, integrity-bound (fixes C1 + H4, the consent bypass + TOCTOU).** A plugin contributes **nothing** unless a valid `.consent.json` record exists AND a recomputed **content hash of the whole plugin tree** matches the hash recorded at consent. No record, or hash mismatch (tree edited after consent) ⇒ the **entire plugin is inert + flagged** "needs consent — run `/plugins install`". Directory-presence may *discover* a plugin (to list it) but never *enable* it. This is the load-bearing control; it lives in `src/plugins/loader.ts` + `integrity.ts`, enforced at boot, independent of the install path.

**S2 — Plugin skills are declarative-only: inline shell disabled (fixes C2, the highest-leverage fix).** A new `allowShellInterpolation: false` on the skill record, forced for `source:'plugin'`, so `` `!cmd` `` is NOT expanded for plugin skills (they emit prompts/templates, never run shell at expansion). The guard remains a supplementary tripwire that escalates the consent disclosure — **never the boundary** (it is demonstrably porous, §12).

**S3 — Install-time disclose-and-consent, with a real architectural home (fixes C2-arch).** v1: `/plugins install` is **TTY-only** (the CLI path has a terminal; install is a local operator action). It renders a single capability-framed disclosure — "contributes N skills, M commands; declares (inert in v1) K hooks running shell X, J MCP servers connecting to Y; ignores CC-only feature Z" — guard findings escalated (⚠/⛔); decline = nothing lands; accept = persist `.consent.json` (per-component decisions + tree hash + `pluginId`). The gateway/web-UI **cannot install plugins in v1** (no TTY); deferred with the registry. (A two-phase `preview`→`accept` route is the later cross-surface design.)

**S4 — Opt-in default (fixes L1).** Given S1/S2, the v1 config default is **opt-in**: a plugin is inert until consented; there is no "installed = enabled." `plugins: { enabled?: string[] }` is an allow-list; the deny-list form is secondary.

**S5 — Lowest tier, guard-scan all prompt-bearing content** (skills/commands at `community`), plus scan/disclose **bundled scripts** (M2-sec — a Bash-allowed user could run an unscanned plugin script). A `block` finding disables that component; the disclosure shows "N of M components disabled by policy" so the user can decline the whole.

**S6 — Install-time enforcement:** strict-schema manifest (reject literal secrets across **headers/bearerToken/apiKey/url-userinfo/url-query/env/bodies** — H2, a specified entropy+prefix+URL-parse scan, best-effort + disclosed-not-made-safe); **contain every manifest-declared path** + `${CLAUDE_PLUGIN_ROOT}` result against the install root (M1, not just symlink-escape); symlink-reject (`assertNoSymlinkEscape`); path-contain; reject absolute manifest refs.

**S7 — Uninstall revokes everything** (components + consent + enable records, `pluginId`-stamped); uninstall is restart-bounded + must not break a live supervisor session mid-flight (M4): refuse-while-live or degrade gracefully (documented).

## 5. Staged scope — the heart of the revised plan

### v1 — Foundation + safe declarative core
The plugin **infrastructure** + the only types that are safe today:
- `src/plugins/` module: manifest (strict subset schema + `ignored[]`), loader (consent-gated + integrity-hashed, S1), compose (skills + commands; `${CLAUDE_PLUGIN_ROOT}` threaded, H1), install/uninstall/enable/disable (TTY consent, S3), integrity (tree hash), guard (community).
- Composition for **skills + commands** only. **Inline shell disabled for plugin skills (S2).**
- `/plugins` command (TTY install/uninstall/enable/disable/list/info); `plugins` config (opt-in, S4).
- Precedence + collision (H2); restart-to-apply; HarnessInfo reports plugins; CC-only features disclosed-as-ignored.
- **Opportunistic CC import:** a CC plugin installs; its skills/commands work; its hooks/MCP/agents are **disclosed + inert** (not silently — the disclosure says so).
- Ends with a **hard adversarial security review** (the consent flow + integrity + inline-shell-disable are the attack surface).

### v2 — Agents + remote MCP (each with named hardening)
- **Plugin agents** ONLY with the full ceiling (H3): force `inheritParentTools=false` + `allowedSubagents=[]` at compose (never trust the manifest); intersect `allowedTools` against a **plugin-agent tool ceiling** excluding `Bash`/`Write`/`Edit`/`AgentTool` (the channels safe-by-default posture); extend the guard to agents (new `community` agent tier + prose scan, **advisory not boundary**); close the top-level recursion-guard gap (`parentAgentName === undefined`).
- **Remote MCP from plugins** ONLY with: **reject (not warn) private/loopback hosts** + require `https` + harden `isPrivateHost` to decode non-dotted IPv4 (H1-sec — a plugin URL is adversarial, unlike operator config); origin disclosure; never auto-supply secrets; ride `buildSafeFetch`; namespace MCP aliases with a **non-`__` separator** + teach the permission grammar a plugin-scoped rule form (C1) or keep flat-namespace-on-collision.

### v3 — Hooks, stdio MCP, registry
- **Plugin hooks** (the worst component) only with hardened, per-hook, install-time, guard-escalated, provenance-stamped consent — or kept inert indefinitely (founder call, D-legacy/D1).
- **stdio MCP** (session-long subprocess = hook-grade) under the same bar.
- **Registry/marketplace + remote install** → requires signing + content-pinning + the marketplace's own trust; CC `marketplace.json` consumption pairs here.

### Never in scope without a separate decision
In-process native `Tool<I,O>` via `import()` (executing plugin JS in-process) — MCP is the escape hatch for "I need real code."

## 6. CC compatibility — honest position

The harness consumes the **subset** of CC's plugin format it supports; in v1 that's skills + commands (+ opportunistic disclose-and-ignore of the rest). **Do not advertise "Claude Code plugin compatibility" as a v1 headline** — a large fraction of real CC plugins derive their value from hooks/MCP, which are inert until v2/v3. v1's honest claim: "install Claude-Code-format skill/command packs; richer plugins import with their advanced components disclosed and deferred." Full compat is a v2/v3 outcome. (Reconfirm CC's `plugin.json`/`marketplace.json`/path-var format against official docs at build time — §12 M3.)

## 7. Config + install surface

`plugins: { enabled?: string[], disabled?: string[] }` (`.strict().optional()`; opt-in via `enabled`). Install dir `~/.harness/plugins/<name>/` (profile-aware, survives `sov upgrade`). `/plugins install <local-dir>` (TTY-consented) → validate → secret-scan → path-contain → symlink-reject → guard-scan → disclose → on-accept copy via `copySkillTree` + write `.consent.json` (decisions + tree hash + pluginId). `.consent.json` schema, manifest schema, and load-failure semantics (skip-with-warn, inherit the skill-loader policy) are specified in the plan (M2). `harness.minVersion` needs a small semver comparator that strips the `-<sha>` suffix from `VERSION` (M3).

## 8. File-change outline (v1)

**New:** `src/plugins/{types,manifest,loader,compose,install,consent,guard,integrity}.ts`; `src/commands/pluginOps.ts`; `tests/plugins/*`.
**Modify:** `src/skills/loader.ts` (+`extraRoots?`, `source:'plugin'`, **`allowShellInterpolation:false` for plugin skills** — S2, the key edit), `${CLAUDE_PLUGIN_ROOT}` threading; `src/config/schema.ts` (`plugins` block) + `src/config/settings.ts` (export schemas; extract `mergeMcpServers`/`mergeHookEvents` with the inline collision checks — H3; needed even though hooks/MCP are inert, for the disclosure + future); `src/server/runtime.ts` (boot wiring + HarnessInfo); `src/server/commandContext.ts` + `src/cli/dispatchCommand.ts` (plugin command spread; skills/commands only in dispatch); `src/commands/registry.ts` (register `/plugins`); the TTY consent UX in the CLI install path.

## 9. Testing (v1)

TDD + the patterns A/B/C established. Must include: the **consent-bypass test** (drop a plugin into the dir without install → it loads NOTHING, flagged needs-consent); the **integrity test** (edit the tree after consent → inert); the **inline-shell-disabled test** (a plugin skill with `` `!cmd` `` → shell does NOT execute at expansion); precedence (plugin cannot shadow a user/project skill); path-traversal via manifest refs; secret-rejection across the H2 surface; bundled-script scan/disclose; and a hard **adversarial security review at the end** (the repo's security-review-≠-holistic-review rule — and the consent flow itself is the primary attack surface).

## 10. Risks

- **Value-vs-safety tension (the real one):** a *safe* v1 (skills+commands) is close in value to the shipped `/skills import`; the plugin system's payoff is v2/v3. v1's worth is the reusable **foundation** (consent + integrity + composition). The founder must accept this framing or choose a different path (§11 D0).
- **CC format drift** (tracking an Anthropic-controlled format; mitigate with lenient-but-disclosed ignore + build-time re-verification).
- **Consent UX is net-new** and is the security boundary — the biggest single piece of v1 work (S3).
- **The guard is porous** — it must never be sold as the boundary; S1/S2 (consent + inline-shell-disable) are the real controls.

## 11. Decisions reserved for the founder

| # | Decision | Recommendation |
|---|---|---|
| **D0 (strategic)** | Build the staged plugin foundation (v1 = safe declarative core + the consent/integrity infra), or judge plugins not-yet-worth-it and instead just extend A (`/skills import`) to multi-skill bundles? | **Build the staged foundation.** It's the reusable base that makes agents/MCP/hooks safe to add, and matches the A/B/C increment pattern. But know v1's standalone value is modest. |
| **D1 (positioning)** | CC compatibility: opportunistic-in-v1 (recommended), or hold the plugin system until it can honor full CC compat (hooks/MCP)? | **Opportunistic.** Ship the foundation; grow compat as v2/v3 land. Don't headline CC-compat in v1. |
| **D2 (scope)** | Pull **plugin agents** into v1 (with the full H3 ceiling) for real multi-type value, or keep v1 to skills+commands and do agents in v2? | Founder's call. v2 is safer/cleaner; pulling agents into v1 (with the ceiling) materially raises v1's value at the cost of the agent-guard + ceiling work now. |
| **D3 (scope)** | **Remote MCP** in v1 (with private-host-reject) or v2? | v2 — it connects out + demands secrets; keep v1 purely declarative. |
| **D4 (security, later)** | Plugin **hooks** ever (v3, hardened consent), or permanently inert? | Defer to v3; decide then. |
| **D5 (UX)** | Consent UX: TTY-only install in v1 (recommended), or build the cross-surface `preview→accept` route now? | TTY-only v1; cross-surface with the registry. |

## 12. Due-diligence appendix (what the adversarial reviews found)

Two parallel Opus reviews (architecture + security) attacked the first-draft spec. Verdicts: **not implementation-ready as drafted; v1 security model does NOT hold for an adversarial plugin.** Confirmed findings, all folded into §3–§5 above:

- **C1 (CRITICAL) — consent bypass via directory drop.** No load-time consent gate exists; directory-presence loads components. → **S1** (load-time gate + tree-hash integrity).
- **C2 (CRITICAL) — plugin skills run shell at expansion time** outside the permission layer; the guard allowed 9/10 trivial exfil/RCE payloads. → **S2** (disable inline shell for plugin skills; guard is supplementary).
- **C-arch — consent has no architectural home** (headless server; no install-time consent UX). → **S3** (TTY-only install v1).
- **C1-arch — MCP `<plugin>__<alias>` breaks the `mcp__server__tool` permission grammar.** → non-`__` separator / plugin-scoped rule (v2).
- **H1 — `${CLAUDE_PLUGIN_ROOT}` doesn't reach skills/agents/commands.** → thread it (§3).
- **H1-sec — remote-MCP localhost masquerade defeats the stdio defer** (`isPrivateHost` only warns). → reject private hosts for plugin MCP (v2).
- **H2 — "reject literal secrets" unspecified/incomplete.** → enumerated surface + scan (S6).
- **H2-arch — precedence ordering unspecified** (a security property). → splice after-user-before-bundle + no-shadow test (§3).
- **H3 — agent-guard extension insufficient** (declaration-based escalation; recursion-guard bypass). → full ceiling, agents deferred to v2 (§5).
- **H3-arch / H4 — hooks/MCP merge is inline-not-callable; inert-hook state is new; dispatch has no MCP/hooks seam.** → extract merges; scope dispatch (§3, §8).
- **H4-sec — TOCTOU (consent install-time, reload at use-time).** → tree-hash at load (S1).
- **M1–M4 (both)** — manifest-path containment, bundled-script scanning, strict-schema-vs-ignore tension, uninstall lifecycle, minVersion machinery, namespacing/env-fragment collision — folded into S5–S7 + the plan.
- **Value verdict (architecture):** with hooks+MCP deferred, v1 is "barely more than `/skills import`" and CC-compat is aspirational — hence the staged framing + the honest §6 + D0.

**No code is written for D until the founder approves §11 — especially D0 (build the foundation), D2 (agents in v1 or v2), and the corrected security model.** The implementation plan (next) covers the v1 foundation + safe declarative core as specified here.
