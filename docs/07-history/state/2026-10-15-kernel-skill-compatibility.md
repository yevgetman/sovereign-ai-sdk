# Native Kernel skill compatibility — source implementation

Date: 2026-10-15. Source feature in [PR95](https://github.com/yevgetman/sovereign-ai-sdk/pull/95); not a public release.

SOV accepts the exact `context: kernel` domain label without treating it as an
execution-mode request. Descriptors retain the original frontmatter. Unknown or
malformed contexts, fork isolation, per-skill hooks/models/agents and unsupported
permission controls still block activation. Native invocation flags and tool
restrictions retain their prior meaning.

Managed external projections still require host approval through
`skills.discovery.allowedLinkRoots`. The general containment, file identity and
retarget checks are unchanged. A local doctor rejection now identifies the exact
canonical approval target and settings field. Equivalent blocked aliases are
grouped with at most16 extra paths. Routine canonical-duplicate rows and repeated
loader warnings are omitted from the local presentation. Remote diagnostics retain
only their prior content-free allowlist.

Synthetic bundled, added, learned, ordinary and producer-shaped compound fixtures
exercise metadata-only loading, inert inspection, native user/model activation,
invocation flags, catalog paging and independent composition members. Vendor group
metadata is inert; no native Kernel Skill Set executor was added. A real private
SessionDb reopen plus native query with a mock provider proves retained guidance,
turn-only expiry and fresh tool, permission and reference-root policy. These checks
prove mechanisms, not installed Kernel producer support or real-provider quality.

The matching producer plan/PR for this compatibility extension remains unidentified.
Related [Runtime PR249](https://github.com/yevgetman/kernel-runtime/pull/249) and its
on-demand loading plan describe thin registries, explicit loads, managed projections
and scope checks, but do not establish the missing `context: kernel`/learned-skill
producer contract. Do not call cross-product support complete from this SOV source
change alone. No real profile approval, consumer pin, installed binary, public
version, release manifest or daemon was changed.

## Cross-references

- [Approved design](../../../specs/2026-10-15-kernel-skill-compatibility-design.md)
- [Implementation plan](../../../plans/2026-10-15-kernel-skill-compatibility.md)
- [Compatibility and approved-link setup](../../04-extending/skill-compatibility.md)
- [Validation record](../../06-testing/testing-log.md)
