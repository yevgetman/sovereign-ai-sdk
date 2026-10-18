# Resilient logical turns

Date: 2026-10-16

Approved specification: `specs/2026-10-16-resilient-logical-turns-design.md`

## Goal

Make one SOV request a bounded logical turn that can cross internal model-loop segments without repeating the user request or a completed tool effect.

## Build plan

1. Add an open SDK logical-turn supervisor and durable store contract.
   - Keep `createAgent().run()` as one segment.
   - Add cumulative limits, deadlines, progress fingerprints, leases, safe continuation messages, and typed final outcomes.
   - Add logical-turn and recovery trace events.
2. Add durable storage.
   - Extend the in-memory SDK store.
   - Add an atomic SQLite logical-turn record and lease migration to the native session store.
   - Keep route and policy bindings in the record. Store no secret values.
3. Integrate the native headless host.
   - Persist the original message once.
   - Run segments through the supervisor.
   - Rehydrate the newest durable transcript between segments.
   - Emit `turn.continuing` and one final terminal.
   - Advertise SOV-owned recovery in `session.started`.
   - Add a prompt-free logical-turn continuation option.
4. Make continuation segments distinct from user turns.
   - Do not rerun recall, user-message hooks, or user conduct gates.
   - Keep route, model, effort, tools, permissions, cwd, and bundle fixed.
5. Add compact `skills_list` detail projections.
   - Support `names`, `summary`, and `activation`.
   - Return complete page accounting.
   - Keep generation-safe cursors and byte budgets.
6. Add focused tests.
   - Prove segment continuation, no duplicate prompt, cumulative bounds, stall detection, cancellation, receipt safety, leases, restart state, wire shape, and skill catalog projections.
   - Update old recovery tests to the new automatic contract.
7. Update current-state docs and the testing log.
8. Run the full repository gate, review the diff, commit atomic changes, push the branch, and open one pull request against `master`.

## Delivery limits

- Do not merge, release, install, or deploy.
- Do not run `sov upgrade` for this delivery.
- Do not change Telekit.
