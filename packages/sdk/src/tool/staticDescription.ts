// Shared, crash-safe resolution of a Tool's description in SYNCHRONOUS
// static-assembly contexts (system-prompt build, provider tool-schema
// serialization, ToolSearch lookup, context-budget audit).
//
// The public `Tool.description` contract is `(input) => string | Promise<string>`
// (see tool/types.ts) — so a consumer may build the description from its input,
// AND may do so asynchronously. But every static-assembly call site here has no
// real input to pass at publication time and cannot await: it needs a string
// synchronously. Four corners can occur, and each must degrade to the tool name
// WITHOUT ever crashing the host process:
//
//   1. the description function THROWS synchronously (input-dependent on a field
//      of the `undefined` sentinel)          → return tool.name
//   2. it returns a Promise                   → degrade to tool.name (awaiting is
//      out of scope in these synchronous contexts) AND swallow any rejection so
//      an async-REJECTING description cannot surface as an unhandled promise
//      rejection. Dropping the Promise with no `.catch()` is uncatchable at the
//      call site (it is already past the try/catch) and, on both Node ≥15 and
//      Bun, an unhandled rejection terminates the process (exit 1). This is the
//      load-bearing reason this helper exists.
//   3. it returns a NON-string (number/object/null — a misbehaving consumer that
//      violates the contract)                 → fail closed to tool.name rather
//      than leaking the raw value into a provider `tools[].description` (which the
//      model request rejects at the API boundary, 400).
//   4. it returns a string                    → return it.
//
// The return type is ALWAYS a string. Routing all four sites through this one
// helper means no site can regress an individual corner independently.

import type { Tool } from './types.js';

/**
 * Resolve a tool's description to a plain string for a synchronous static
 * context, degrading to `tool.name` on throw / Promise / non-string, and
 * swallowing any async rejection so it can never crash the process.
 *
 * NOTE: the returned string is NOT whitespace-normalized — callers that want a
 * single-line form (e.g. the `<available-tools>` list) normalize themselves.
 */
// biome-ignore lint/suspicious/noExplicitAny: cast-free tool composition (F8) — see createAgent AgentConfig.tools.
export function safeStaticToolDescription(tool: Tool<any, any>): string {
  try {
    const result = tool.description(undefined as never);
    if (result instanceof Promise) {
      // Async descriptions degrade to the name in these synchronous static
      // contexts. Attach a no-op catch so an async-REJECTING description does
      // not leave an unhandled promise rejection that kills the process on the
      // next microtask (uncatchable from this already-returned call frame).
      result.catch(() => {});
      return tool.name;
    }
    // Fail closed on a non-string return.
    return typeof result === 'string' ? result : tool.name;
  } catch {
    // Synchronous throw (input-dependent description hit the `undefined`
    // sentinel).
    return tool.name;
  }
}
