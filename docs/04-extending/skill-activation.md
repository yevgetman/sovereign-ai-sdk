# Permissioned skill activation

Skill inspection and activation have different contracts. `skill_view` returns
the raw body or reference text. It performs no argument substitution, inline
shell execution or workflow activation. Reference paths are resolved to real
filesystem paths and confined to the skill's real directory. A link to a file
outside that directory is rejected.
Reference reads use an opened regular-file handle and a one-megabyte byte limit.
The tool rechecks canonical containment and file identity after reading, before
it returns content. It pins canonical directory identities and the leaf's
metadata before opening, then compares the opened handle before and after the
read. A replaced file or a tested temporary ancestor swap fails the read.

## One activation contract

`packages/sdk/src/skills/activation.ts` exports `activateSkill`,
`createSkillActivationState`, `skillRestrictionRules` and `resolveSkillResource`.
These exports also exist in the SDK barrel.

An activation reloads the current file, rejects a changed resolved path, checks
the current guard decision, applies the native tool restriction and expands
the approved instructions. It returns an activation envelope with the skill
name, exact content revision, origin, arguments, restriction rules and allowed
resource roots. State is recorded only after expansion succeeds.

The host owns each turn's state and permission callback. An absent callback
cannot approve guarded skills or inline shell. SDK hosts can create state
explicitly without writing files or resolving an ambient home directory.
A trusted `resolveSkill` callback can resolve an in-memory descriptor. Passing
`allowedResourceRoots: []` grants no filesystem resource authority and performs
no root lookup. Without that explicit empty list, roots resolve physically.

`query` creates its own turn-local state. Model `SkillTool` activation narrows
subsequent provider tool schemas and tool dispatch, including calls later in
the same tool batch. A model-activated scope does not mutate the host's shared
tool pool or survive into its next ordinary turn. Model activation is serial
because it changes the effective capability floor.

Parallel host activations on the same state also run in request order. The next
activation observes the prior activation's complete restriction before it
checks permissions or expands inline shell. Failed or cancelled requests release
the queue. Independent turn states never wait on each other.

## Native restrictions and host policy

Native `allowedTools` keeps its established restriction meaning:

- Missing or empty rules leave the existing host pool unchanged.
- Declared valid rules narrow the host pool and input-pattern gate.
- Invalid entries are dropped without granting their tools.
- A declared list with no valid entries fails closed.
- Repeated activations intersect the current restrictions.

Portable metadata normalization is tracked separately in issue #46. This
permission fix preserves the existing legacy alias behavior until that
descriptor migration lands. A skill never overrides a host denial.

Children inherit the current pool and permission floor. An external
subscription executor is refused when a native skill restriction is active,
because its tools cannot be bounded by SOV's in-process gate. The scope floor
is checked against final inputs after permission or hook transformations.
Hook rewrites also pass through the host gate again before execution.

## Dynamic context

`expandSkillPrompt` and `expandSkillText` no longer spawn shell processes by
themselves. An author inline-shell expression requires an explicit
`runShellCommand` port. The shared activation implementation supplies that
port through the scoped host Bash tool and ordinary tool orchestrator. This
preserves permission prompts, denials, hooks, validation, cancellation and
tool observations. Plugin inline shell remains inert.

Native HTTP activation creates a separate host evidence identity before inline
context can reach the conduct policy. It settles that identity on success or
failure. The context-only evidence row omits delivered text. Later provider
drives retain their own identities under the session they actually run in,
including after compaction. This keeps activation decisions attributable
without treating context expansion as a delivered model response.

Dynamic context runs in the skill directory with a ten-second timeout and a
bounded output. User arguments are merged last and never rescanned as shell.
Permission failure stops activation and produces no activation record.

Activated instructions, arguments and shell output are not rescanned for
`@file:`, `@folder:`, `@url:`, `@diff` or `@staged` context references. These
remain literal text. The skill must use its permitted tools to obtain context
through the host gate. Ordinary explicit references in non-skill user turns
retain their existing expansion behavior.

Environment placeholders in inline shell preserve their exact data in ordinary
bare, single-quoted and double-quoted words. Shell metacharacters in a directory
or session id cannot become new substitutions. ANSI-C/localized quotes, nested
expansions and here-documents with environment placeholders fail closed. Use an
ordinary quoted word or an explicit host adapter for those contexts.

Direct callers that previously relied on ambient loader execution must use
`activateSkill` with a host gate, or explicitly supply a controlled runner.
No invocation path should use a read-only preview to perform activation.

## Client transport

`POST /commands` previews skill commands without running dynamic context. It
returns the original slash request in `promptToSend` and `turnKind: "skill"`.
Drive and the TUI post this identity as a skill turn. Scheduled cron skills
activate inside the scheduled turn, with the same restricted tool pool and
auto-denying approval callback. Plain HTTP and `sov run` requests also activate
a known leading slash skill. Spaces, tabs and newlines can separate its
arguments. Unknown slash names and file paths remain ordinary text; explicit
`kind: "skill"` requests reject unknown names. The server resolves the
descriptor and permissions from its own registry at activation time. A client
does not supply permission rules or trusted resource roots.

Plugin `commands/` workflows keep a host-owned descriptor in the canonical
command registry. They use the same activation gate while remaining outside
the model's skill catalog. Command-origin requests preserve the normal
built-in → plugin command → catalog skill precedence. A plugin cannot use
this path to shadow a built-in command or execute inline shell.

The protocol's optional `skillSource` records `user` or `command` origin; it
does not grant authority. Existing non-skill prompt commands retain their
expanded text transport.

## Verification

`tests/skills/activation.test.ts` checks actual shell effects and negative
permissions, raw inspection, linked references, hooks and transformations,
model continuation schemas, turn expiry and child inheritance.
`tests/skills/activationConcurrency.test.ts` checks concurrent host requests,
native tool effects, inline shell, failure recovery and independent states.
`tests/server/skillActivationClients.test.ts` drives the actual command/HTTP
and line-driver paths. TUI tests check that the command activation POST keeps
the skill identity. Existing skill scope tests retain the legacy native rule
and empty-list contracts.
The client tests also join inline conduct decisions to one settled host
evidence row on success and denial.

## Read next

- `docs/04-extending/extending.md` — skill and tool extension recipes.
- `docs/03-cli-reference/usage.md` — skill commands and permission modes.
- `packages/sdk/README.md` — embedded SDK setup and host responsibilities.
