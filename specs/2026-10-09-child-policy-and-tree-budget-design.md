# Child policy and shared tree budgets

Status: implemented as a bounded part of issue #15, approved by the owner's 2026-10-09 instruction to
address the review; scope confirmed by root. Additive open SDK changes only.

A host supplies a named capability registry and an explicit child policy.
Profiles filter the host's existing tool pool. Children intersect that pool with
their own profile and declared allow-list. Existing pattern matching is reused;
malformed patterns fail closed. Parent permissions remain mandatory and rewritten
inputs must satisfy the child scope. Hook, recall, observation, governance,
reasoning and context settings are inherited by explicit configuration.

A shared in-memory budget atomically limits child depth, total delegation
attempts and active children across a tree. An exported provider wrapper reserves
host-declared per-request upper bounds before each call. It accounts retries,
parent calls and context-management calls when those providers share the wrapper.
Token/cost ceilings require an estimator; no guessed input bounds. Unknown or
partial usage retains the reserved upper bound and is marked unknown. Observed
usage beyond a declared bound exhausts the budget and prevents subsequent calls;
external billing cannot be undone. Costs are estimates, never claimed billed.

Defaults remain unchanged when hosts omit the optional policy/budget. Subprocess
executors cannot inherit native governance/permission contracts: configured child
policy or request budget must reject that path. No OS sandbox or distributed
budget backend is introduced.

## Plan

1. Add registry, explicit child policy, and shared budget/provider primitives.
2. Wire profile filtering, inherited child policy, scoped recursion and usage
   propagation into the scheduler; add custom-profile createAgent integration.
3. Add deterministic narrowing, hooks/recall, recursion, accounting and budget
   regressions; run full source gate and packed Node/Bun consumer checks.
4. Commit for root aggregation into issue #15. Existing #12/#13 lifecycle fixes
   are prerequisites. Root integrates the separate context-management port.

## Validation

All four implementation steps are complete. Full source gate: 5,510 pass,
19 skip, zero fail. Packed Node and Bun consumers exercise the new native-child
contract. Root owns context-port integration and the aggregate issue #15 PR.

## Read next

- [Production hardening](2026-10-09-sdk-production-hardening-design.md)
- [SDK README](../packages/sdk/README.md)
