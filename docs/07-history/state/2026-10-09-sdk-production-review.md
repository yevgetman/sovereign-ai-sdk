# State — 2026-10-09 SDK production review

The current baseline is runtime 0.6.75 / SDK 0.12.0 at `3709b25`. The SDK is an
importable MIT Node/Bun engine; the proprietary coding harness and gateway consume
it. Explicit native API/subscription routes have landed in the SDK and machine
host. See [native route usage](../../03-cli-reference/sdk-routes.md).

The owner requested a new production review for Kernel's general-purpose harness,
including chat/coding toolsets, long sessions, compaction, children and scale. The
[review](../audits/2026-10-09-sdk-production-review.md) reproduced five reliability
defects, opened issues #10–#14, and compared context/child patterns in local Qwen
and Hermes source. Full source checks and packed consumers pass despite those
newly reproduced defects. This is not a production certification.

Full summary compaction remains in the proprietary gateway. Embedded/native
children receive microcompaction. Custom capability hierarchies, inherited child
policy, tree budgets and an evidenced production envelope remain proposed work.

Documentation/process changes are staged in a PR: CONTRIBUTING, issue and PR
templates, an embedding guide and the PR shipping marker. The proposed
[hardening spec](../../../specs/2026-10-09-sdk-production-hardening-design.md)
separates lifecycle fixes, SDK capability contracts and host operation. Runtime
fixes, CI enforcement and GitHub protection changes have not been implemented.

## Read next

- [Review evidence](../audits/2026-10-09-sdk-production-review.md)
- [Contribution process](../../../CONTRIBUTING.md)
- [Embedding operations](../../04-extending/embedding-an-agent.md)
