# Portable skill compatibility

Loader-produced skills carry a `descriptor` with `schemaVersion: 1`. Older injected
`Skill` objects remain valid. The descriptor preserves the original normalized
frontmatter, including unknown vendor fields. Nested metadata is retained.
Unknown data never grants permissions or changes execution.

## Invocation controls

`disable-model-invocation: true` makes a skill manual-only. It is absent from the
model's skill catalog and model activation refuses it. `user-invocable: false`
makes a skill model-only. It does not become a slash command and user activation
refuses it. Both controls require real YAML booleans. The shared
`isSkillInvocable` and `assertSkillInvocable` helpers enforce these decisions.

Fork contexts, per-skill model overrides, agent routing, hooks and skill-supplied
permission or sandbox controls are unsupported. The loader records actionable
diagnostics. Such skills remain inspectable but cannot activate. `context: inline`
and `model: inherit` are supported. Kernel's exact `context: kernel` label is
also accepted as domain metadata; SOV still uses its normal inline path. The
original label remains in `descriptor.frontmatter.context`. Every other defined
context value remains unsupported, including unknown strings and malformed types.
No context value changes the model, tools, permissions, hooks or agent routing.
No tool executes merely from loading or
importing these controls.

## Kernel metadata and composition

Kernel version fields, `tier`, `harnesses`, composition declarations and unknown
vendor fields are retained as data. A compound skill and its separately projected
members can be discovered and activated independently. Composition metadata does
not dispatch members. Skill Sets are Kernel grouping metadata; availability or
assignment does not activate members or execute their procedures in SOV.

Native invocation controls still apply to every compatible Kernel skill. The
`kernel` label never promotes a projected project skill's trust tier or bypasses
the normal body/resource guard. Explicit native tool restrictions keep their
existing meaning below.

## Approving managed external links

Project projections under `.harness/skills` or `.agents/skills` can point to
externally stored skills only when the host explicitly approves the target.
Merge a narrow canonical skill directory into `skills.discovery.allowedLinkRoots`
in the selected profile's `config.json`, for example this configuration fragment:

```json
{
  "skills": {
    "discovery": {
      "allowedLinkRoots": ["/srv/kernel/skills/release-check"]
    }
  }
}
```

Approve only reviewed storage. Do not approve a filesystem root, a home directory
or all Kernel state. An individual file projection can use its exact canonical
file as the approval target; it does not require approving the containing tree.
Embedded hosts use the existing discovery `allowedLinkRoots` option. No Kernel
path is implicitly trusted and no setting is written by discovery or doctor.

From the target project, `sov skills doctor --json` reports blocked links with
their projected `path`, canonical `realpath`, and a local-only `approval` hint:
`settingsField` is `skills.discovery.allowedLinkRoots` and `canonicalRoot` is the
exact observed target. Inspect that target before approving it. Excluded internal
storage and vendor trees do not get an approval hint. Such a hint cannot bypass
an exclusion. The scan-only CLI option `--allowed-link-roots <exact-target>` lets
an operator check a reviewed target without persisting configuration.

The local doctor groups equivalent blocked projections, keeps the first path and
up to 16 additional `aliases`, omits routine duplicate-realpath rows, and avoids
repeating a structured discovery failure as a loader warning. Distinct targets,
trust classifications, guard failures and duplicate-name conflicts remain
separate. Remote diagnostics omit paths, aliases, approval hints and raw messages.

Link approval preserves the existing identity checks. A discovered link that
changes target is rejected by loading/reload, even when both targets are approved.
Refresh the catalog to inspect a replacement through the normal checks.

## Guidance when resuming SOV

An explicitly activated linked skill uses native SOV continuity. Session guidance
can survive later turns and `sov --resume <session-id>` through the private session
store. A resumed turn starts with fresh activation and host permission state.
Guidance does not restore tool grants, approvals or resource-root access, replay
activation commands, or pass to an unrelated session. Turn-only guidance expires.
Pinned revision and owner/profile isolation rules remain in force. See
[skill continuity](skill-continuity.md) for lifetime and revision details.

## Tool policy

Native `allowedTools` restricts SOV's turn tool pool. Portable `allowed-tools`
requests pre-approval in its originating harness. SOV retains that request in
`descriptor.toolPolicy.preapprovedTools`; it does not bypass host permissions or
silently turn the request into a restriction. A portable-only skill therefore has
an empty native `allowedTools`. This corrects the earlier alias behavior.

Both fields may coexist without overwriting either meaning. Portable string or
list formats accept comma and whitespace separators outside tool argument groups.
`Read Grep Bash(git log --format:%h,%an)` retains three entries. Claude colon-glob
patterns remain unchanged and receive an import warning rather than a guessed
translation.

## Arguments and paths

Bodies support `{{args}}`, `$ARGUMENTS`, zero-based `$ARGUMENTS[n]` and `$n`.
Positional parsing handles quoted groups and backslash escapes as data. Arguments
are inserted after dynamic context expansion, so a command-shaped argument cannot
run during interpolation. If the body has no argument placeholder, nonempty
arguments are appended as `User arguments`. Argument-like tokens inside an inline
shell command do not suppress this fallback. Only supported placeholders in the
original prose consume arguments; shell output remains literal data.

`${CLAUDE_SKILL_DIR}` and `${SKILL_DIR}` alias `${HARNESS_SKILL_DIR}`.
`${CLAUDE_SESSION_ID}` aliases `${HARNESS_SESSION_ID}`. `${CLAUDE_PLUGIN_ROOT}`
remains available only from the source's plugin root. These values use the same
display and command-context escaping as native placeholders.

## Import and future metadata

Direct loading and import use the same normalization. Import can synthesize
`whenToUse` from a description but retains `license`, `argument-hint`, model,
hooks and future vendor data. Preserving a field does not claim support for it.
Read `descriptor.execution.diagnostics` to distinguish compatible metadata from
execution controls that prevent activation.

## Migrating to SDK 0.16.1

No source, session-schema or configuration migration is required. Older injected
`Skill` objects remain valid. Exact `context: kernel` now loads as domain metadata
without requesting a new execution mode. Do not remove host link approvals or
replace them with broad storage roots. Inspect local doctor hints before adding
a narrow canonical target. Optional `approval` diagnostic data is local-only;
remote integrations must keep their existing content-free allowlist.

Previously rejected unknown contexts, malformed controls, unsupported execution
modes and changed link targets remain rejected. Existing session guidance uses
native continuity and fresh permissions on resume. Kernel producer integration
has not been verified by this source compatibility release.

## Cross-references

- [Extending the harness](extending.md)
- [SDK README](../../packages/sdk/README.md)
- [Testing log](../06-testing/testing-log.md)
