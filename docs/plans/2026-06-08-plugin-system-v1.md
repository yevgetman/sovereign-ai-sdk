# Plugin System v1 (Foundation + Safe Declarative Core) — Implementation Plan

> **For agentic workers:** execute with superpovers:subagent-driven-development (fresh subagent per task + two-stage review), TDD throughout. **PENDING FOUNDER SCOPE-APPROVAL** — this plan implements the *recommended* v1 from the spec (`docs/specs/2026-06-08-plugin-system-design.md` §5: foundation + skills + commands, consent-gated + integrity-hashed, inline-shell-disabled, opt-in, TTY-install). If the founder pulls plugin agents into v1 (spec D2) or changes scope, adjust before executing.

**Goal:** the plugin *foundation* (manifest, loader, composition seams, consent + integrity infrastructure) plus the only extension types safe to ship today — **skills + slash-commands** — installed as one consent-gated unit.

**Architecture:** a pure-aggregator `src/plugins/` module produces skill-roots + command contributions and injects them at the existing loader seams; the load-bearing security is a **load-time consent gate bound to a plugin-tree content hash** (no consent / hash mismatch ⇒ the whole plugin is inert), plus **disabling inline-shell expansion for plugin-sourced skills**.

**Tech stack:** TypeScript on Bun; Zod for the manifest; reuses `copySkillTree`/`assertNoSymlinkEscape`/`guard`/`frontmatter` from the skills subsystem.

---

### Task 1 — Plugin types + manifest schema
**Files:** create `src/plugins/types.ts`, `src/plugins/manifest.ts`, `tests/plugins/manifest.test.ts`.
- `PluginManifest` (strict known-subset Zod: `name` `^[a-z][a-z0-9-]*$`, `version`, `description`, `author?`, optional component-dir overrides; **collect unknown/CC-only keys into `ignored: string[]`** rather than `.strict()`-rejecting — so CC plugins parse and the disclosure can list ignored features). Import (don't redefine) `HooksSettingsSchema`/`McpServerConfigSchema` from `config/settings.ts` (export them) to validate the **declared-but-inert** hooks/mcpServers blocks for disclosure.
- `LoadedPlugin`, `PluginContributions` (v1: `skillRoots`, `commands`, plus `disclosedHooks`/`disclosedMcp`/`ignored` for surfacing), `PluginRegistry`.
- **Tests (RED→GREEN):** valid manifest parses; unknown CC keys land in `ignored[]` (not rejected); bad `name` rejected; a manifest with a literal secret in an mcp `headers`/`bearerToken`/`apiKey`/`url`-userinfo flagged (the secret-scan helper, shared with Task 6).

### Task 2 — Integrity (tree hash) + consent record
**Files:** create `src/plugins/integrity.ts`, `src/plugins/consent.ts`, `tests/plugins/integrity.test.ts`, `tests/plugins/consent.test.ts`.
- `hashPluginTree(dir): string` — deterministic content hash over all files (sorted paths + contents), excluding `.consent.json` itself.
- `.consent.json` schema: `{ pluginId, version, treeHash, decisions: {...}, consentedAt }` (timestamp passed in, not `Date.now()` in a pure fn). `readConsent(dir)` / `writeConsent(dir, record)` (atomic temp+rename, mirror `hooks/consent.ts:53-62`).
- **Tests:** hash is stable + changes when any file changes; consent round-trips; a record whose `treeHash` ≠ recomputed hash is detected as invalid.

### Task 3 — Loader (consent-gated + integrity-checked)
**Files:** create `src/plugins/loader.ts`, `tests/plugins/loader.test.ts`.
- `loadPlugins({ harnessHome, config, warn })`: scan `~/.harness/plugins/*/.claude-plugin/plugin.json`; for each, validate manifest, **require a valid `.consent.json` whose `treeHash` matches** `hashPluginTree` AND `pluginId` matches — else the plugin is **discovered-but-inert**, flagged `needsConsent`/`tampered` (NOT loaded). Apply opt-in `enabled`/disabled config. Deterministic alphabetical order. Returns `PluginRegistry`.
- **Tests (the security-critical ones):** a plugin dropped in the dir with **no `.consent.json`** → contributes NOTHING, listed `needsConsent` (the C1 consent-bypass test); a consented plugin whose tree is edited after consent (hash mismatch) → inert, `tampered` (the H4 TOCTOU test); a properly consented plugin loads; disabled config → inert.

### Task 4 — Compose (skills + commands → contributions)
**Files:** create `src/plugins/compose.ts`, `tests/plugins/compose.test.ts`.
- From each loaded plugin produce a `SkillRoot` (new `source:'plugin'`, `trustTier:'community'`, carrying `pluginName` for provenance) for its `skills/` dir, and `PromptCommand[]` from `commands/` via the existing `buildSkillCommands` path. Thread `${CLAUDE_PLUGIN_ROOT}` → the install dir into skill/command interpolation (H1).
- Merge across plugins; surface `disclosedHooks`/`disclosedMcp`/`ignored` (inert, for HarnessInfo + future).
- **Tests:** two plugins' skills both contribute; provenance is set; `${CLAUDE_PLUGIN_ROOT}` resolves; a plugin's declared hooks/mcp appear in `disclosed*` but produce NO hook/mcp contribution (inert).

### Task 5 — Skills loader changes (the key security edit)
**Files:** modify `src/skills/loader.ts`, `src/skills/types.ts`; tests in `tests/skills/`.
- Add `extraRoots?: SkillRoot[]` to `LoadSkillsOptions`, spliced **after user, before bundle** (precedence; H2). Add `'plugin'` to `SkillSource`.
- **Add `allowShellInterpolation` to the skill record, forced `false` for `source:'plugin'`** (S2): `expandSkillPrompt`/`interpolateShellCommands` must NOT run `` `!cmd` `` for plugin skills. This is the single highest-leverage security edit.
- **Tests (RED→GREEN):** a plugin skill with `` `!echo PWNED` `` in its body → the shell does **not** execute at expansion (the C2 test); a non-plugin skill still expands shell (unchanged); a plugin skill canNOT shadow a user/project skill of the same name (H2 no-shadow test).

### Task 6 — Install / uninstall (TTY disclose-and-consent)
**Files:** create `src/plugins/install.ts`, `tests/plugins/install.test.ts`.
- `installPlugin({ source, pluginsRoot, confirm })`: resolve source dir; validate manifest; **secret-scan** the manifest surface (headers/bearerToken/apiKey/url-userinfo+query/env/bodies — H2) → reject on literal secret; **contain every manifest-declared path + `${CLAUDE_PLUGIN_ROOT}` result** against the source root (M1); `assertNoSymlinkEscape`; guard-scan all prompt-bearing content **+ bundled scripts** (S5/M2) → escalate disclosure; build the capability-framed disclosure (skills/commands counts; declared-inert hooks/mcp with their shell/host; ignored CC features; guard ⚠/⛔); call `confirm(disclosure)` (the TTY prompt, injected for tests); on accept → `copySkillTree` to `<pluginsRoot>/<name>/` + `writeConsent` (tree hash + decisions + pluginId). `uninstallPlugin` removes the dir + consent (path-contained, mirror `installSkill`).
- **Tests:** install writes `.consent.json` with a matching hash; decline → nothing lands; literal-secret manifest → rejected; manifest path `../escape` → rejected; symlink-escape → rejected (reuses the symlinkGuard tests' shape); a guard-blocked skill is disclosed as "disabled by policy."

### Task 7 — `/plugins` command + config
**Files:** create `src/commands/pluginOps.ts`; modify `src/config/schema.ts` (`plugins: { enabled?, disabled? }`.strict().optional() — opt-in) + `src/config/settings.ts` (export `HooksSettingsSchema`/`McpServerConfigSchema`; extract `mergeMcpServers`/`mergeHookEvents` with the inline collision checks — H3, for disclosure + future); register in `src/commands/registry.ts`; tests.
- Subcommands: `install <dir>` (TTY-consented), `uninstall <name>`, `enable`/`disable <name>`, `list` (name/version/enabled/`needsConsent`/`tampered` + contribution counts), `info <name>` (manifest + disclosed/ignored + which components are disabled-by-guard).
- **Tests:** the dispatcher verbs; config opt-in semantics (a non-listed plugin inert when `enabled` is set); `enabled`+`disabled` both present precedence rule (M2).

### Task 8 — Runtime wiring
**Files:** modify `src/server/runtime.ts` (call `loadPlugins` near the bundle/skills load; thread `extraRoots`+plugin commands; surface plugins in `HarnessInfoTool`), `src/server/commandContext.ts:127` + `src/cli/dispatchCommand.ts:112` (spread plugin commands; dispatch gets skills/commands only — H4), `tests/server/*`.
- **Tests:** a consented plugin's skill is invocable via `/skillname` end-to-end (mock provider); HarnessInfo lists installed plugins + their disclosed/ignored components; an unconsented plugin is absent from contributions but present in the list as `needsConsent`.

### Task 9 — Hardening review, docs, gate, ship
- **Hard adversarial security review** (per the repo rule + spec §9): the consent flow + integrity + inline-shell-disable are the attack surface. Fix any Critical/High before ship.
- Docs: `docs/usage.md` (a `/plugins` section — install/consent/opt-in + the honest CC-import note + "v1 = skills+commands; agents/MCP/hooks are disclosed+deferred"), `docs/architecture.md` (the plugin layer + the consent/integrity model), `docs/extending.md` (authoring a plugin). Append `docs/testing-log.md`.
- Gate: `bun run lint && bun run typecheck && bun run test` green (no new failures beyond known env-flakes); Go untouched (no TUI verb in v1 unless the founder wants `/plugins` in the TUI too — the CLI/`sov drive` path suffices for the TTY consent; a TUI install verb is a clean follow-on).
- Atomic commits; push; `sov upgrade`; cut a release.

---

## Sequencing + review
T1→T2→T3 are the foundation (types/integrity/loader); T4→T5 the composition (compose + the skills-loader security edit); T6→T7 the install/command surface; T8 wiring; T9 ship. Two-stage review (spec compliance, then quality) after each task; a security-focused review on T3, T5, T6 (the consent/integrity/inline-shell trio) and the whole-feature adversarial review at T9.

## Out of scope (this plan) — per spec §5
Plugin agents (v2, with the full ceiling), remote MCP (v2, private-host-reject), hooks + stdio-MCP (v3), registry/marketplace + remote install (v3), in-process `Tool<I,O>`, hot-reload, a TUI install verb (clean follow-on), the cross-surface `preview→accept` consent route (with the registry).
