# Kernel skill compatibility in native SOV

Date: 2026-10-15
Status: approved by Owner in Telegram on 2026-10-15
Source request: “SOV build plan — complete Kernel skill compatibility” (2026-10-15).
Code baseline: `b34f3cdd8800027c40f403b3730b9e70e7f74d14` (`origin/master`).
Branch: `feat/kernel-skill-compatibility-20261015`.

## Outcome and scope

SOV can discover, inspect and activate approved Kernel skill files through its existing native skill system. Kernel's `context: kernel` domain label remains metadata. It grants no execution mode or host authority. Existing host permissions, filesystem containment, invocation controls and session isolation remain in force.

This change covers descriptor interpretation, local discovery diagnostics, compatibility fixtures and documentation. It uses the existing activation and continuity ports. It adds no Kernel shell adapter, automatic Skill Set execution, default external-root approval, migration or new dependency.

## Current behavior

`packages/sdk/src/skills/descriptor.ts` rejects every defined `context` except `inline`. Thus a Kernel domain label produces an unsupported-execution error even when the rest of a skill is compatible. Original frontmatter is already retained by the descriptor.

Discovery already accepts host-approved external targets through `skills.discovery.allowedLinkRoots`. Canonical path deduplication and bounded traversal already exist. The bounded reader checks canonical paths and file identity before and after reads. The local doctor exposes discovery decisions, but a generic `scope-denied` message does not explain the external-link setting.

SOV already stores activated guidance in its private session database. A resumed turn creates fresh activation state. This work must prove that behavior for linked Kernel fixtures; it must not introduce a second persistence system.

## Descriptor contract

| Frontmatter value | Interpretation |
| --- | --- |
| `context` absent | Existing inline behavior |
| `context: inline` | Supported inline execution label |
| `context: kernel` | Recognized domain metadata; existing inline behavior |
| `context: fork` | Unsupported execution request; inspection allowed, activation denied |
| Any other defined `context` value | Continue to fail closed, including malformed types |

Only the exact string `kernel` is newly accepted. Do not accept arbitrary strings as metadata. Preserve the original value in `descriptor.frontmatter.context`; no descriptor schema-version change is needed for this rule.

Kernel `version`, `tier`, `harnesses`, composition declarations and unknown vendor fields remain data. They do not select a model, install hooks, dispatch agents, approve commands or add tools. Existing unsupported-control checks remain active even when `context: kernel` is present.

Existing native `allowedTools` restrictions and portable `allowed-tools` request semantics remain unchanged. “Kernel metadata does not change tools” applies to the domain and vendor metadata; it does not disable explicit native restrictions.

## Approved linked skills

Keep the general link guard. A projection may resolve outside the project only beneath a canonical root explicitly approved by the host through `skills.discovery.allowedLinkRoots`. Documentation must use a narrow skill-storage directory, never a home directory, filesystem root or the entire Kernel state tree.

Approval does not increase a skill's trust classification. Discovery and activation must retain bounded reads, exclusions and identity checks. Retargeting a discovered link must reject that stale candidate, even if the replacement is also within an approved tree. A fresh discovery may consider the replacement under the normal rules.

No real user's settings, links, installed skills or credentials change during validation. Test nodes and approved roots live in temporary directories.

## Local diagnostic contract

Keep existing decision codes and their security meaning. Add a structured approval hint only when an external-link containment failure is established. Local JSON must identify the projected `path`, the blocked canonical target and `skills.discovery.allowedLinkRoots` as the settings field. The hint is a suggestion for Owner inspection; it never writes settings or approves a target.

Use additive optional diagnostic fields for the approval hint, with the exact canonical target that the resolver has actually observed (a directory or an individual file). File projections must not suggest approving an enclosing directory. Do not guess or recommend an enclosing private tree. Other scope failures, such as excluded internal storage, must not imply that this setting can bypass them.

Reduce repeated local doctor entries for the same canonical skill reached through `.harness/skills` and `.agents/skills`. Keep a deterministic representative path and bounded alias information where useful. Preserve discovery precedence, candidate selection and distinct failures. Never hide a retarget, guard failure or duplicate-name conflict by grouping it with a successful alias.

Only local doctor output may expose these path details. Keep remote diagnostics redacted. No diagnostic may contain bodies, resource contents, expanded arguments, private session guidance or credentials. Keep existing discovery and diagnostic bounds.

## Invocation, composition and catalogs

An approved compatible skill appears through existing catalog APIs subject to model-invocation rules. `disable-model-invocation: true` stays manual-only. `user-invocable: false` stays unavailable to user/slash activation. Both restrictions must be checked at activation as well as catalog presentation.

Composition is metadata in SOV. A compound parent and its separately projected members remain separately discoverable and activatable. Loading a parent or a Skill Set must not activate its members, execute commands, or create tool grants. Parent prose may guide later explicit actions, each checked under the current host policy.

Catalog paging must return each eligible canonical skill once, preserve cursor behavior and omit manual-only skills from model results. Inspection remains inert; full-body/resource checks still run when required.

## Session continuity

Activate a linked fixture, finish its turn, close its host/database and reopen the same stored session in a fresh host. The intended retained guidance must reach a mock provider on the later turn. This is the native continuity path that CLI `--resume` uses.

Session guidance retains the existing pinned-revision and lifetime semantics. Reopening must not replay activation commands or restore permissions, approvals, resource-root access or the previous turn's tool pool. A `turn` record must expire. A distinct session and a distinct owner must not receive the prior guidance. Existing explicit child-lineage rules remain unchanged.

Do not add a database migration or change how edited/missing revisions are handled unless a demonstrated compatibility defect requires a scoped correction within these invariants.

## Acceptance evidence

Use synthetic fixtures for bundled, added, learned, ordinary and compound Kernel styles. Include integer and string version data, `context: kernel`, composition metadata and unknown nested vendor fields. Use temporary directories, isolated configuration and mock providers; no paid model calls are needed.

- Descriptor: `kernel` succeeds without a context warning; `inline` still succeeds; fork, unknown/malformed contexts and unsupported authority controls still refuse activation.
- Discovery: exact approved storage root loads; absent approval blocks; sibling/prefix targets stay blocked; both directory and file link changes are rejected against stale discovery.
- Diagnostics: blocked projection, observed canonical target and safe setting are present locally; bodies and unrelated paths are absent; remote output stays redacted; duplicate projections do not multiply skill entries.
- Metadata and activation: header-only loading is inert; inspection does not activate; invocation flags govern both user and model routes; tool policy is unchanged by Kernel/vendor metadata.
- Catalog and composition: paged model results are complete and unique; compound members remain independent; set/parent loading never executes members.
- Continuity: database reopen retains permitted guidance for the same session; turn-only guidance expires; tools and approvals reset; unrelated sessions/owners remain isolated.
- CLI smoke: run the actual `sov skills doctor --json` command against an isolated Kernel-style node, with and without its narrow approved root.

Record focused failed-before and passing evidence in the testing log. Before implementation commits, run repository lint, root/browser type checks and the full test gate. Final validation also runs the strict SDK build, packaged Node/Bun consumer checks and supported engine-floor checks required by the repo. Do not describe fixture success as production provider certification.

## Producer dependency and delivery

Kernel owns projection layout, stable skill identity and the storage roots it asks the host to approve. SOV owns compatibility interpretation, host-policy enforcement and session continuity. Fixtures must be checked against the matching Kernel Runtime producer plan before claiming complete cross-product support.

The matching producer plan was not included with this attachment and was not located in the inspected runtime plan/spec paths. Runtime PR249 is related on-demand skill work, not a verified match for this build. Resolve the exact producer plan and matching PR during implementation; report that dependency explicitly if it remains unavailable. Do not invent a match or broaden SOV's filesystem authority to accommodate it.

After design approval, write the repository build plan and implement in small coherent commits in this isolated feature worktree. Update the compatibility and continuity guides, testing log and final state record. Push the branch and open the delivery PR with the verified matching Runtime PR link, validation and remaining limits.

The implementation handoff stops with an open PR. Merge, publication, installed binary updates, consumer pins and Runtime claims of complete learned-skill support require their applicable separate authorization and release procedure.

## Design review

Self-review: exact-value compatibility exception; unsupported controls remain blocked; no root defaults or trust promotion; no body exposure in diagnostics; no automatic composition execution; no persisted host authority; no change to existing continuity revision rules. No new strategic, cost or dependency choice is proposed.

## Cross-references

- [Portable skill compatibility](../docs/04-extending/skill-compatibility.md)
- [Native skill continuity](../docs/04-extending/skill-continuity.md)
- [Build procedure and approval gate](../docs/05-conventions/autonomous-feature-builds.md)
- [Related Runtime on-demand skill work](https://github.com/yevgetman/kernel-runtime/pull/249)
