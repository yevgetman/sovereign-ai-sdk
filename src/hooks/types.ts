// Hook event types and the runner contract. Hooks are user-configured shell
// commands invoked at lifecycle points (Phase 11). The runtime calls a single
// HookRunner; everything below the runner — argv-split, consent, subprocess,
// JSON IO, aggregation — is internal to the hooks module.
//
// Source of pattern: harness-build-plan.md §"Phase 11"; canonical reference is
// claude-code-reverse-engineering.md §10. Invariant #13 (harness-invariants.md):
// shell:false, JSON-stdio, exit-code-2-blocks, first-use TTY consent.

export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop';

/** Discriminated union of every hook event payload. Serialized to JSON on the
 * hook's stdin. The shape mirrors the build-plan spec exactly — additional
 * fields like `permission_mode` and `transcript_path` are not yet exposed. */
export type HookEvent =
  | {
      hookEventName: 'PreToolUse';
      session_id: string;
      cwd: string;
      tool_name: string;
      tool_input: unknown;
    }
  | {
      hookEventName: 'PostToolUse';
      session_id: string;
      cwd: string;
      tool_name: string;
      tool_input: unknown;
      tool_output: unknown;
      is_error: boolean;
    }
  | {
      hookEventName: 'UserPromptSubmit';
      session_id: string;
      cwd: string;
      prompt: string;
    }
  | {
      hookEventName: 'Stop';
      session_id: string;
      cwd: string;
      reason: 'completed' | 'max_tokens' | 'max_turns' | 'error' | 'interrupted';
    };

/** Narrow a HookEvent to the union member for a given event name. */
export type HookEventOf<N extends HookEventName> = Extract<HookEvent, { hookEventName: N }>;

/** Parsed hook stdout. All fields optional; only event-relevant fields are
 * honoured (e.g. `additionalContext` is ignored on PreToolUse). */
export type HookOutput = {
  permissionDecision?: 'allow' | 'deny' | 'ask';
  updatedInput?: unknown;
  additionalContext?: string;
  rewrittenPrompt?: string;
  reason?: string;
};

/** A single command spec inside a HookConfig. Only `type: 'command'` is
 * supported this phase; future transports (e.g. MCP-style) would extend the
 * union. `timeout` is per-invocation, in milliseconds.
 *
 * Note: `| undefined` is explicit on the optional fields so the type matches
 * Zod's parsed output under exactOptionalPropertyTypes. */
export type HookCommandSpec = {
  type: 'command';
  command: string;
  timeout?: number | undefined;
};

/** A registered hook entry from settings.json. `matcher` is an opaque tool-name
 * filter for tool events; ignored for prompt/stop events. */
export type HookConfig = {
  matcher?: string | undefined;
  hooks: HookCommandSpec[];
};

/** Aggregate result of every matching hook for a single event. The runtime
 * interprets `block`/`deny` as a hard stop and uses the other fields to
 * patch the inflight value (input, prompt, content). */
export type HookResult = {
  /** True if any hook exited with code 2 or returned `permissionDecision: 'deny'`. */
  block: boolean;
  /** Combined human-readable explanation for a block. Includes captured stderr. */
  reason?: string;
  /** Final input to use when proceeding (PreToolUse only). Undefined = no rewrite. */
  updatedInput?: unknown;
  /** Final prompt to use when proceeding (UserPromptSubmit only). */
  rewrittenPrompt?: string;
  /** Concatenation of every matching hook's `additionalContext` (PostToolUse). */
  additionalContext?: string;
};

/** The function the runtime calls. Implementations hold the loaded settings,
 * the consent allowlist, the harness home, and an AskUser callback for the
 * first-use prompt. Returns even on subprocess failure (soft fail) — only
 * `block: true` halts the call site. */
export type HookRunner = <N extends HookEventName>(
  event: N,
  payload: HookEventOf<N>,
  signal?: AbortSignal,
) => Promise<HookResult>;
