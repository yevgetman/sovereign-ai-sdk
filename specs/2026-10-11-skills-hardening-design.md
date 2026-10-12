# SDK/SOV skill hardening

The Owner authorized implementation of issues #44–#51 and one PR per issue.
The existing eight issue contracts and their native GitHub dependency graph are
the accepted scope. Telekit, Kernel runtime and Mac app feature changes are outside
this build. No release publication, consumer deployment or live upgrade is part
of this request.

Shared contracts:

- Activation keeps identity, revision, source, arguments and turn policy together.
  Inspection is inert. Dynamic context uses host tool permission checks.
- Discovery is portable, bounded and confined to explicit trust roots.
- Descriptor version 1 retains vendor data and separates invocation, execution,
  native restrictions and portable pre-approval requests.
- Store mutations validate and stage before publish. Committed revisions and
  events trigger atomic registry generation replacement.
- Optional SDK composition stays no-disk unless a store/discovery adapter is
  explicitly selected. SOV consumes the same public interfaces.
- Catalog and continuity budgets use effective model limits, with conservative
  unknown limits. Guidance persists separately from expired turn permissions.

Implement roots #44/#45/#47 in parallel. Finalize #46 on #44. Assemble #48 after
#45/#46/#47. Implement #49/#50 in parallel after #48. Finalize #51 after both.
Independent drafting may overlap; integration and PR closure follow these edges.

Validation includes denied effects, symlink escapes, invalid writes, revision
conflicts, live refresh, model/manual controls, catalog completeness, packed
Node/Bun consumers and forced compaction/resume. The configured repository gate
remains mandatory. Repeatable simulated provider tests do not claim live-provider
quality or a paid longitudinal soak.

## Cross-references

- Issues #44–#51 in `yevgetman/sovereign-ai-sdk`
- `plans/2026-10-11-skills-hardening.md`
- `docs/04-extending/skill-compatibility.md`
