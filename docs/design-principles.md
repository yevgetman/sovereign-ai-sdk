# Design principles — don't relitigate

Per ADR H-0003 and the docs-repo planning/reference documents, these are locked. When in doubt about any of them, read the corresponding section in `~/code/sovereign-ai-docs/harness/docs/reference/agent-harness-design-lessons.md`.

1. **Async-generator turn loop.** `async function* query(): AsyncGenerator<StreamEvent | Message, Terminal>` from day one. Never collapse to Promise-returning.

2. **Content-block internal messages.** `Message` carries an array of `ContentBlock`s (text / thinking / tool_use / tool_result / image). Providers translate at the boundary.

3. **Fail-closed tool defaults.** `buildTool()` spreads defaults first, user overrides last. `isConcurrencySafe` and `isReadOnly` default to `false`.

4. **Per-invocation concurrency.** `isConcurrencySafe(input)` takes the actual arguments, not a class-level flag.

5. **Permissions are transformable.** `checkPermissions` returns `{ behavior, updatedInput?, reason? }` — rules can normalise input, not just gate it.

6. **Segmented cacheable system prompts.** Static to dynamic, ephemeral cache marker at the boundary.

7. **Uniform Tool interface.** MCP tools, sub-agents, native tools, skill invocations — all flow through the same pipe.

8. **Sub-agents are recursion.** An `AgentTool` calls `query()` with a filtered context. No parallel execution engine.

9. **Bundle-as-data contract.** Runtime reads `<bundle>/business/` + `<bundle>/harness/schemas/`, writes `<bundle>/state/`. Never writes to tier-1 or tier-2 content.
