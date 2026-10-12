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
and `model: inherit` are supported. No tool executes merely from loading or
importing these controls.

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

## Cross-references

- [Extending the harness](extending.md)
- [SDK README](../../packages/sdk/README.md)
- [Testing log](../06-testing/testing-log.md)
