# SDK production hardening — proposed design

**Status: proposed; runtime implementation has not started.** Prepared from the
2026-10-09 review at `3709b25`. The target is a reusable Kernel harness for chat,
web, operations and coding, built on the SDK with explicit host responsibilities.
Existing open/proprietary licensing boundaries remain in effect.

## Outcome

An embedded agent and a native child should have the same reliable lifecycle:
bounded work, valid tool/result history, clear incomplete/error outcomes, resource
cleanup, controlled context size, and measurable cost. A production host must be
able to configure these controls without importing the proprietary gateway.

Do this incrementally. Preserve the async-generator loop, content-block model,
provider abstraction and injectable-port architecture. No language change,
wholesale rewrite or change of commercial direction is proposed.

## Work package A — verified lifecycle defects

Fix issues #10–#14 through focused PRs. Add deterministic regression cases before
each fix. Keep stream ordering and successful-run behavior stable.

- Stream parser: cancel unfinished upstream bodies and release reader locks on
  completion, abort, consumer return and error. Test cleanup failures separately.
- Stream normalization: require valid provider completion state. Do not turn a
  truncated response into an answer or a partially assembled executable tool call.
  Treat incomplete generation as a typed error without automatic side-effect replay.
- Scheduler: begin child deadlines before lane/write-lock waits. Cover every
  operation after reservation with guaranteed release. Join all child work before
  parent resources can be reused.
- Tool batches: turn per-tool authorization/hook/validation exceptions into
  accurate per-tool failures; cancel when appropriate and join started siblings.
  Emit exactly one result per tool id. No work may outlive terminal return.

The private owner report contains a separate policy-composition concern. Resolve
it through the private security process before declaring policy boundaries ready.
Do not include its reproduction in the public issue queue or this design.

**Exit evidence:** regressions pass; full source suite and packed consumers pass;
adversarial review of cleanup and error paths finds no unresolved high defect.

## Work package B — portable context and child contracts

Recommended shape, subject to the owner's SDK-boundary decision:

1. Add an injected context-management port, available to parent and native child
   agents. It receives model limits, current history and a cancellation signal.
   It returns a validated context replacement and usage. It must preserve tool
   adjacency and reject empty/inflated summaries. The existing proprietary host
   can implement this port; a reusable MIT implementation requires a separate
   explicit boundary decision. Keep persisted history separate from model context.
2. Define the child policy/configuration object. Make permission, hook, governance,
   context and observation inheritance explicit. Children can narrow capabilities;
   a model-selected child cannot widen them. Define recursion depth and cumulative
   child counts, not just simultaneous children per parent.
3. Add a named capability-profile registry with parent/profile intersection. Keep
   current `chat`/`web`/`ops`/`coding` values compatible. Bind external/MCP tools by
   explicit capability membership. A profile selects capabilities; it must not
   grant authorization on its own. Require a final execution policy as today.
4. Propagate child usage and cost. Define tree budgets for tokens, cost and wall
   time, including retries and summarization. Distinguish estimated cost from
   billed cost and missing usage from zero usage.

**Exit evidence:** external Node/Bun examples exercise long-session compaction,
overflow handling, a parent with a child, narrowed tools, and parent+child budget
exhaustion. Test custom profiles, malformed summaries and cancelled compaction.
Any public API addition follows stability policy and updates surface tests.

## Work package C — host operation and release discipline

- Document a supported deployment envelope: concurrent sessions, active/queued
  children, history sizes, stream sizes, queue limits and shutdown deadlines.
- Define a single-writer/lease contract for each session. The current synchronous
  store may remain for local SQLite. Evaluate an additive async port only if
  Kernel's chosen deployment requires remote persistence. This is a founder
  decision if it adds infrastructure or changes deployment strategy.
- Run fault tests for disconnects, rate limits, timeouts, failed writes and
  process restart. Do not claim exactly-once external effects without durable
  idempotency support from the relevant tool and host.
- Benchmark the declared envelope with mocked providers first. Measure queue
  latency, RSS, event-loop delay, history-copy/serialization cost and cancellation
  recovery. Then validate representative live routes with an agreed spend limit.
- Establish tree-level traces with run/parent/session/tool IDs, terminal reason,
  queue time, tokens and cost. Keep owner text out of metrics by default.

**Exit evidence:** repeatable load/soak and restart reports against defined limits;
no post-terminal work; bounded queues and prompt cancellation; accurate accounting
and operator-facing failures. Infrastructure and OS sandboxing stay host duties.

## SDLC changes to implement with the hardening work

The documentation PR supplies CONTRIBUTING, templates and the PR workflow marker.
The remaining enforcement work is explicit:

- Run the full deterministic TypeScript suite and Go tests on PRs. Build the TUI
  before tests. Pin tested Bun/Node/Go versions and verify the supported engine
  floor. Keep live-model semantic checks separate and bounded.
- Add representative Node runtime regression coverage, not only a bare canary.
- Add the actual Agent Casa downstream canary. Check type shapes and behavioral
  contracts across upgrade fixtures. Changes cannot hide behind export-name tests.
- Add dependency/advisory checking with a recorded exception process, limited
  workflow permissions, and maintained action/version pins.
- After the jobs pass, enable required checks and prevent direct implementation
  pushes to master. Select a reviewer arrangement that works for a solo owner.
  Test the effective GitHub rules rather than assuming templates enforce them.
- Keep release authority separate from merge authority. Use reviewed source,
  immutable artifacts, compatibility evidence and the existing release procedure.

## Owner decisions and sequencing

1. Approve work package A as the first implementation scope. It fixes reproduced
   defects without choosing a new product architecture.
2. Decide whether full reusable compaction belongs in the MIT SDK or is supplied
   solely through a port. Current proprietary code must not be moved silently.
3. Define Kernel's first production envelope: single-machine/local persistence
   or multiple workers. Distributed infrastructure is not assumed by this spec.
4. Approve the capability/child contract before work package B changes public API.

Approximate planning envelopes: A **~100K–180K tokens**; B **~250K–450K**;
C **~150K–300K**, excluding a new distributed storage backend. These estimates
include tests and review. Re-estimate after the owner sets the boundary and load
envelope. Each package closes with evidence; none is declared complete here.

## Read next

- [Review evidence](../docs/07-history/audits/2026-10-09-sdk-production-review.md)
- [Contribution process](../CONTRIBUTING.md)
- [Consumer contract](../docs/05-conventions/consumer-contract.md)
- [Design approval procedure](../docs/05-conventions/autonomous-feature-builds.md)
