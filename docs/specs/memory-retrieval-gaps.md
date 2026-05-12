# Memory Retrieval Gaps Spec

Status: draft anchor
Created: 2026-05-08
Source moment: comparison of the current harness memory system against Mert Cobanov's "How AI Agent Memory Works" article and the shipped/planned runtime docs.

## Purpose

This spec records the memory retrieval gaps visible at this point in the harness's evolution and itemizes possible ways to close them. It is intentionally not a phase commitment. Its job is to preserve the questions, tradeoffs, and circumstances identified now so later work can choose deliberately instead of rediscovering the same terrain.

## Current Baseline

The harness currently has four memory-like layers:

1. **Bounded durable markdown memory**
   - Global `USER.md` stores user profile and preferences.
   - Global `MEMORY.md` stores cross-project agent notes.
   - Per-project `MEMORY.md` stores project-local notes under `$HARNESS_HOME/memory/projects/<projectId>/MEMORY.md`.
   - The `memory` tool can `view` or `replace`; over-cap writes fail instead of truncating.

2. **Fenced read-back into working context**
   - Memory is read once per user turn.
   - It is prepended to the latest user message inside `<memory-context>` fences with a system-note preamble.
   - It does not mutate the frozen system prompt.

3. **Propose-then-promote learning**
   - Background review agents propose memory and skill changes.
   - Proposals carry provenance and are human-gated by default through `/review`.
   - Consolidation and revoke paths exist for approved entries.

4. **Observation and instinct corpus**
   - Every tool call can write a per-project observation record.
   - The instinct synthesizer clusters observations into confidence-weighted instincts.
   - Review agents can prefer instincts over raw trajectory slices.

This is a strong local-first memory foundation, but it is not yet a retrieval product in the article's sense. The active read path is mostly "inject bounded files" rather than "decide, search, rank, filter, and pack."

## Design Questions

Future memory work should answer these before implementing:

1. Which user problem are we solving: forgotten durable facts, stale/wrong facts, token bloat, cross-project contamination, or skill/pattern promotion?
2. Is the target memory layer user profile, project notes, observations, instincts, trajectories, or skills?
3. Does the agent need semantic recall, exact-key recall, temporal recall, or governance metadata?
4. Should the feature run on the user-facing path, in a background pass, or only on explicit command?
5. What is the failure mode if retrieval is wrong: mild irrelevance, wrong code action, privacy leakage, or persistent self-poisoning?
6. What evidence will prove improvement: fewer tokens, higher recall on evals, fewer duplicate memories, better proposal quality, or fewer user corrections?

## Gap Inventory And Solution Options

### Gap 1: No Need Detection On Memory Reads

Current behavior: bounded memory is injected every user turn when non-empty. This is simple and robust while files are small, but it spends tokens even when the prompt needs no continuity.

Circumstances that make this matter:
- `USER.md` plus global and project `MEMORY.md` approach their caps.
- The user asks cold factual or coding questions where memory is irrelevant.
- More memory providers are added and the snapshot grows.

Possible solutions:

1. **Heuristic skip gate**
   - Add a cheap classifier before injection.
   - Retrieve when the user uses continuity phrases such as "as before", "remember", "my preference", "this project", "last time", or asks about prior decisions.
   - Pros: fast, deterministic, no extra model call.
   - Cons: misses implicit continuity and can be gamed by phrasing.

2. **Model-assisted need detector**
   - Ask a small/local model whether memory is needed.
   - Pros: better semantic coverage.
   - Cons: adds latency/cost and another prompt surface.

3. **Always inject hot memory, gate warm memory**
   - Keep `USER.md` always visible.
   - Gate global/project `MEMORY.md`, trajectories, and instincts.
   - Pros: preserves preferences while reducing bloat.
   - Cons: still treats `USER.md` as universally relevant.

Recommended first step: heuristic skip gate with a config kill switch and logging, followed by a targeted semantic test for continuity prompts.

### Gap 2: No Ranking Or Packing Within Memory Files

Current behavior: markdown files are injected as whole bounded snapshots. The cap forces consolidation, but all retained facts have equal prompt priority.

Circumstances that make this matter:
- The memory cap becomes a frequent blocker.
- Consolidated files contain several unrelated facts.
- The model overweights stale or low-relevance entries because they are always present.

Possible solutions:

1. **Section-level memory format**
   - Adopt lightweight headings with stable IDs and optional metadata.
   - Example fields: `id`, `scope`, `kind`, `created`, `updated`, `confidence`, `source`.
   - Pros: human-readable, enables filtering without a database.
   - Cons: schema migration and parser complexity.

2. **Packed memory snapshot**
   - Keep files as markdown, but parse headings and pack only top-N sections into `<memory-context>`.
   - Scoring can combine recency, scope, manual priority, and lexical overlap.
   - Pros: incremental, avoids immediate vector store.
   - Cons: brittle if headings are inconsistent.

3. **Memory index sidecar**
   - Maintain `$HARNESS_HOME/memory/index.jsonl` with extracted chunks and metadata.
   - Source markdown remains canonical.
   - Pros: better retrieval without losing editability.
   - Cons: index invalidation and rebuild rules.

Recommended first step: memory index sidecar generated from markdown headings, with a safe fallback to full-file injection if parsing/indexing fails.

### Gap 3: No Semantic Retrieval Over Durable Memory

Current behavior: durable memory retrieval is not embedding-based. The only semantic layer is indirect: background agents reason over trajectories/observations/instincts.

Circumstances that make this matter:
- The user expects "remember that thing from last month" to work across a larger corpus.
- Project memories exceed what can be injected wholesale.
- The harness needs to retrieve from trajectories or approved memory proposals by meaning, not exact terms.

Possible solutions:

1. **Lexical search first**
   - Use SQLite FTS5 or a JSONL/BM25-like local index.
   - Pros: local, deterministic, no embedding dependency.
   - Cons: weaker paraphrase recall.

2. **Optional embedding provider**
   - Add embeddings behind `MemoryProvider`.
   - Store vectors locally in SQLite/pgvector/Qdrant depending on deployment.
   - Pros: strong semantic recall.
   - Cons: model/provider selection, migration, privacy posture, cost.

3. **Hybrid retrieval**
   - Combine lexical, vector, and metadata scores.
   - Use reciprocal-rank fusion only after both simple retrievers exist.
   - Pros: robust for exact IDs and paraphrase.
   - Cons: more moving parts and eval burden.

Recommended first step: lexical retrieval over chunked memory and approved proposals; add embeddings only when lexical evals show a real recall miss.

### Gap 4: No Temporal Validity Or Supersession Model

Current behavior: memory entries can be replaced or consolidated, and proposals carry provenance, but durable facts do not have first-class `valid_from`, `valid_until`, `supersedes`, or `superseded_by` fields.

Circumstances that make this matter:
- User facts change: role, location, preferences, active client.
- Project facts become obsolete.
- The model needs to answer "what did we used to do?" versus "what should we do now?"

Possible solutions:

1. **Manual supersession conventions**
   - Add a documented markdown convention for superseded entries.
   - Pros: minimal.
   - Cons: model may not follow consistently.

2. **Typed metadata on memory entries**
   - Track `status: active | superseded | revoked`, validity dates, and replacement IDs.
   - Pros: enables filters and audit.
   - Cons: requires structured parsing and approval tooling updates.

3. **Supersession-aware proposal flow**
   - `memory_propose` can name affected entries.
   - `/review approve` updates the old entry status and appends the new one atomically.
   - Pros: strongest lifecycle control.
   - Cons: needs stable entry IDs first.

Recommended first step: stable IDs plus `status` metadata for approved memory blocks; leave temporal date fields optional until real usage demands them.

### Gap 5: Memory Write Redaction Is Not A First-Class Gate

Current behavior: trajectory/log redaction exists, and review proposals preserve provenance. Explicit memory writes still rely on permission prompts and agent judgment.

Circumstances that make this matter:
- The agent is asked to remember secrets, payment details, keys, or credentials.
- Auto-promote is enabled.
- A future external memory provider persists data outside local markdown.

Possible solutions:

1. **Reuse secret redactor before memory writes**
   - Apply the existing redaction transformer to `memory replace`, `memory_propose`, and auto-promote paths.
   - Pros: quick defense-in-depth.
   - Cons: pattern-based only; may over-redact benign strings.

2. **Memory-specific sensitivity classifier**
   - Classify proposed entries as `safe`, `sensitive`, or `forbidden`.
   - Pros: can catch non-regex private facts.
   - Cons: model call or heuristic complexity.

3. **Policy metadata and deny rules**
   - Add memory policy settings: forbidden kinds, allowed targets, redaction mode.
   - Pros: client-specific governance.
   - Cons: configuration complexity.

Recommended first step: run the existing secret redactor across all durable memory write paths and include a provenance note when redaction occurred.

### Gap 6: No Retrieval Evaluation Suite

Current behavior: tests verify memory injection, proposal flow, review commands, and learning pipeline mechanics. They do not measure recall quality, ranking quality, stale-fact avoidance, or leakage prevention.

Circumstances that make this matter:
- Any retrieval gate, search index, or vector provider is introduced.
- Memory packing becomes conditional.
- The harness starts making decisions from retrieved memories rather than simply exposing them.

Possible solutions:

1. **Golden memory fixtures**
   - Create small memory corpora with expected retrieved entries.
   - Test exact matching, paraphrase, stale fact handling, and scope isolation.
   - Pros: deterministic.
   - Cons: can overfit to toy corpora.

2. **Semantic tests**
   - Ask the live harness continuity questions and judge whether it used the right memory.
   - Pros: catches model-level behavior.
   - Cons: slower and less deterministic.

3. **Trace-based offline evals**
   - Replay real sessions and compare retrieval decisions to later user corrections or approvals.
   - Pros: realistic.
   - Cons: needs accumulated data and labels.

Recommended first step: deterministic golden fixtures for a future retrieval module, then one semantic test for cross-session recall and one for project-scope isolation.

### Gap 7: No Memory Retrieval API Surface

Current behavior: the agent has a `memory` tool for bounded file view/replace, plus hidden review/learning tools. There is no explicit `memory_search` or `memory_inspect_retrieval` surface.

Circumstances that make this matter:
- Retrieval becomes conditional and users need to debug why something was or was not recalled.
- External memory providers are added.
- Review agents need a read API richer than raw file reads.

Possible solutions:

1. **Internal-only retrieval function**
   - Add `MemoryManager.retrieve(query, opts)` without exposing a tool.
   - Pros: smallest surface.
   - Cons: harder to debug interactively.

2. **Read-only `memory_search` tool**
   - Expose retrieved chunks with score, scope, and provenance.
   - Pros: transparent and testable.
   - Cons: increases main tool schema budget unless deferred.

3. **Slash command `/memory-search`**
   - User-facing debug command; not model-callable.
   - Pros: avoids model temptation and schema cost.
   - Cons: less useful to sub-agents.

Recommended first step: internal retrieval function plus a local slash/debug command. Add a model-callable tool only when an agent workflow requires explicit search.

### Gap 8: Limited Cross-Scope Retrieval Policy

Current behavior: profiles isolate state roots; per-project memory reduces project cross-pollination; learning corpora are project-scoped. However, global memory and global instincts can still influence many sessions by design.

Circumstances that make this matter:
- Multiple clients/projects share a profile.
- Global instincts or memory are promoted too aggressively.
- A "personal" preference leaks into a work/client workflow.

Possible solutions:

1. **Scope filters on every retrieval**
   - Retrieval calls must specify profile, project, user/global, and optional bundle scope.
   - Pros: matches production memory architecture.
   - Cons: requires all call sites to be explicit.

2. **Global-memory opt-in per project**
   - Project settings decide whether global `MEMORY.md` participates.
   - Pros: simple privacy boundary.
   - Cons: may surprise users expecting global preferences.

3. **Separate global memory kinds**
   - Split global memory into `USER.md` preferences and global operational notes.
   - Pros: lets preferences travel while project facts stay local.
   - Cons: another migration and more mental model.

Recommended first step: retrieval API requires explicit scope arguments; default global memory participation stays as-is until a real leakage case appears.

### Gap 9: Observation Corpus Is Not A User-Facing Retrieval Source

Current behavior: observations feed instincts via background synthesis. They are not searched directly during normal user turns.

Circumstances that make this matter:
- The user asks about a recent workflow before the synthesizer has run.
- An instinct has low confidence but relevant raw evidence.
- Debugging why a behavior was learned requires finding observations.

Possible solutions:

1. **Keep observations background-only**
   - Treat them as raw telemetry, not memory.
   - Pros: avoids noisy retrieval.
   - Cons: misses recent evidence.

2. **Observation debug search**
   - Add a command to search observations by tool/status/session.
   - Pros: useful for audits and development.
   - Cons: not direct model memory.

3. **Warm episodic retrieval**
   - Let retrieval include recent observations with strict recency and status filters.
   - Pros: supports "what happened earlier?" questions.
   - Cons: can flood context with low-level tool noise.

Recommended first step: debug search only. Promote raw observations into model context only through instincts or explicit user request.

## Sequencing Proposal

If this becomes implementation work, close gaps in this order:

1. **Entry IDs and metadata foundation**
   - Stable memory entry IDs.
   - Optional metadata block for status, scope, timestamps, and provenance.
   - Enables later supersession, packing, and deletion lineage.

2. **Memory write redaction**
   - Apply existing redactor to all durable memory write paths.
   - Low complexity, high downside protection.

3. **Internal retrieval API**
   - `retrieve(query, opts)` with explicit scope, limit, and provenance output.
   - Initial backend can be lexical over markdown chunks.

4. **Need detection and packing**
   - Gate project/global memory.
   - Pack top-ranked chunks instead of injecting full files.

5. **Retrieval evals**
   - Golden fixtures first, semantic tests second.
   - Do not introduce embeddings until evals can show whether they help.

6. **Optional semantic/vector provider**
   - Implement as a `MemoryProvider`.
   - Keep markdown as canonical source unless a client requirement demands otherwise.

## Non-Goals For The First Retrieval Pass

- No bundled vector database by default.
- No silent auto-promotion from retrieved memories into durable memory or skills.
- No cross-user memory sharing.
- No replacement of fenced memory injection until the replacement path has eval coverage.
- No graph memory until structured entry IDs and metadata are already stable.

## Acceptance Criteria For A Future Retrieval Improvement

Any future PR that claims to close one of these gaps should state:

1. Which gap(s) it closes.
2. Which memory layer(s) it touches.
3. Whether it changes the user-facing prompt path.
4. How it handles scope, provenance, redaction, and stale entries.
5. What tests or evals prove it improved retrieval without introducing leakage.

## Open Questions To Revisit

1. Should `USER.md` remain always-hot, or should user preferences also be retrieval-gated?
2. Should per-project `MEMORY.md` be the default canonical store, with global `MEMORY.md` only for proven cross-project lessons?
3. Should approved memory entries become structured records while preserving markdown rendering?
4. When does lexical retrieval become insufficient enough to justify embeddings?
5. Should memory search be model-callable, user-callable, or only internal?
6. What client/security posture requires memory-specific redaction beyond the existing secret redactor?
7. Should trajectory-derived episodic recall ever enter normal turns, or only review/learning forks?

