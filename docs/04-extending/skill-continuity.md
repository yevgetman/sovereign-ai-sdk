# Skill guidance across turns and compaction

`createSkillContinuity()` is an optional SDK lifecycle port. It keeps the
expanded instructions of an explicitly activated skill separate from the
model's reducible conversation history. SOV binds the same port to its private
session database. A bare SDK agent still opens no store or filesystem.

These APIs belong to the skills-hardening review branches. They are not in the
public SDK 0.14.0 / SOV 0.6.77 artifacts.

## A programmatic SDK host

The host selects the profile, owner, session and persistence adapter. A memory
store is useful for a process-local session. Supply your own `SkillContinuityStore`
for durable private storage. Never share scope keys between different owners.

```ts
import {
  createAgent,
  createSkillContinuity,
  createSkillRuntime,
  InMemorySkillContinuityStore,
  InMemorySkillStore,
} from '@yevgetman/sov-sdk';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';

const sessionId = 'my-session';
const skills = createSkillRuntime({ store: new InMemorySkillStore() });
// Populate this explicit catalog with skills.mutate(), then discover it.
await skills.discover();
const records = new InMemorySkillContinuityStore();
const continuity = createSkillContinuity({
  scope: { profile: 'my-profile', owner: 'my-owner', session: sessionId },
  store: records,
  lifetime: 'session',
});
const agent = createAgent({
  provider: myProvider,
  model: myModel,
  cwd: projectRoot,
  tools: [SkillTool],
  skillRuntime: skills,
});
const toolContext = { cwd: projectRoot, sessionId, skillContinuity: continuity };
for await (const event of agent.run('Use the workflow', { sessionId, toolContext })) {
  // Render progress and handle the final result.
}
```

`query()` accepts the same port through `toolContext`. Manual activation uses
`activateSkill()` or `skills.activate()` with that context and a fresh
`createSkillActivationState()`. Only successful expansion creates a record.
The host permission callback still decides guard and inline shell approvals.
Approved shell effects and continuity persistence are not one transaction.

## Lifetime and outcomes

- `turn`: expires when the query finishes, fails or is cancelled. It does not
  pass to a child session.
- `session`: the default. Expanded guidance remains until replacement activation
  or `continuity.complete(name)`.
- `workflow`: persists through authorized host resume/delegation. The host calls
  `complete(name)` when the workflow ends.

Query records successful, failed and cancelled turn outcomes. A successful turn
is not proof that an entire workflow finished. Session/workflow records can
retain the outcome for a later recovery turn. Completion is explicit.
Provider output truncation (`max_tokens`) records a failed turn. Its guidance
remains available for recovery, including when an incomplete tool call did not run.

Guidance retention never restores a permission grant, tool pool, approval or
resource-root authority. A resumed turn creates fresh activation state. A native
SDK child receives guidance only through the optional trusted
`forkSkillContinuity(childSessionId, parentSessionId)` factory. That factory must
validate child ownership and lineage. The scheduler supplies the actual parent
session ID for nested children. The child still inherits the parent's tool floor.

## Revisions and resources

Records retain the expanded guidance and original revision digest. On resume,
the current catalog is checked. Edited, missing and unchecked revisions emit
explicit diagnostics; they do not replace the active workflow text. Activate
again to adopt changed instructions.

Viewing a reference through `skill_view` pins its text, logical reference key,
content hash and opaque canonical target identity. Reading the same reference
with changed contents or a new physical target refuses replacement until a new
activation. The original reference remains available. Main-body inspection,
including `SKILL.md`, relative spelling and canonical aliases, is inert and is
never appended as a reference to old guidance. This prevents mixed revisions and
raw inline templates from replacing an approved expansion.

The composed runtime supplies resource identities. A memory host needs no
filesystem lookup. Custom resource adapters must keep identity stable for their
logical namespace and explicitly distinguish body inspection from references.

## Model budgets and request authority

The shared budget uses the frozen effective model window, reserved output and
current history/tool input. No model-name table controls retention. Each request,
including one after reduction, selects whole workflows within that allowance.
Small or unknown windows can drop guidance. A `budget-dropped` diagnostic explains
that choice; no partial workflow is presented as complete.

Retained text is added to a copy of the provider request's user message. It never
becomes a system instruction. Existing tool-result blocks stay first, including
on the Anthropic wire. The stored transcript and original history remain intact.
Activation source is labeled. Arguments, command output and references are
encoded as quoted data with a fixed current-user/host-policy priority rule.
This framing does not grant authority to imported tool data.

Default storage limits are 16 records, 64 KiB per record, 32 references per record
and 256 KiB aggregate private guidance. Host options are bounded by fixed ceilings.
Diagnostics retain at most 64 safe events. Record validation verifies hashes and
strips unknown fields; store failures leave accepted in-memory state unchanged.

## Private state and SOV lineage

Expanded guidance and reference contents can contain private arguments or command
output. Treat `exportRecords()` and the store as private transcript data. Do not
publish them through diagnostics, telemetry or session lists. Diagnostics include
safe skill identity, hashes, byte counts and outcomes. Opaque persisted record IDs
and non-digest revisions are hashed before reporting. Observer failures do not
change workflow state.

SOV database schema 7 stores this data in a session-scoped private table. Trusted
SessionContexts derive the profile and owner from host state. Session creation
freezes a same-owner parent's non-turn snapshot in its existing transaction.
Empty snapshots stop inheritance after completion. Legacy lineage lookup is
bounded to eight ancestors and rejects owner changes and cycles. Deleting a
session cascades its private records. Public session metadata, transcript search
and remote catalogs do not expose this table.

## Evidence and limits

Deterministic checks drive real SDK query, native delegation, SOV database reopen
and forced `compactSession`. They verify pinned revisions, bounded windows,
permission expiry, cancellation, failed writes, altered references, main-body
aliases, owner isolation, nested child scopes and provider block ordering.

The [controlled evaluation](../06-testing/skill-continuity-eval-2026-10-11.json)
uses one public 82-message manufactured history and a deterministic summary which
omits its workflow. A fresh manager resumes the private record. Four small live
requests compare summary alone with user-role retained guidance on native Claude
and an OpenRouter model. Both retained runs return all three labels in order;
both controls return none. This is one repetition per route. It does not establish
production long-turn accuracy or a longitudinal success rate. No release action
or tool executes in the evaluation.

The runner is `scripts/evals/skill-continuity.ts`. It requires explicit `--live`,
local provider configuration, a catalog report and an output path. It caps requests
at four, with 192 output tokens and a 30-second timeout per request. Saved output
contains counts, costs and redacted lifecycle decisions; no credentials or prompts.
