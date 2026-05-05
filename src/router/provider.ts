// Phase 10.6 — RouterProvider implements LLMProvider by delegating each
// stream() call to one of two configured child providers (local or
// frontier) per the classifier's decision. Records the decision to the
// audit log + emits a `route_decision` StreamEvent before delegating.
//
// Architectural note: the router lives at the LLMProvider layer so the
// turn loop and the existing provider hardening (rate guards, credential
// pools) remain unchanged. Each child provider is itself a fully-resolved
// LLMProvider — the router just chooses between them.

import type { AssistantMessage, Message, StreamEvent, SystemSegment } from '../core/types.js';
import type { LLMProvider, ProviderRequest } from '../providers/types.js';
import { type RouterAuditLogger, hashPrompt } from './auditLogger.js';
import { classify } from './classifier.js';
import type { RouterConfig } from './types.js';

export type RouterProviderOpts = {
  config: RouterConfig;
  localProvider: LLMProvider;
  frontierProvider: LLMProvider;
  /** Audit logger for this session. When omitted, decisions are emitted
   *  to the StreamEvent only (useful for tests). */
  auditLogger?: RouterAuditLogger;
  /** Session id used in audit records. Required when auditLogger is set. */
  sessionId?: string;
  /** Local provider's context length, threaded into the classifier's
   *  context-overflow heuristic. */
  localContextLength?: number;
  /** Per-call override hook the REPL/CLI can set to force a specific lane
   *  for the next stream() call. Cleared after consumption. */
  getNextOverride?: () => 'local' | 'frontier' | undefined;
  /** Phase 10.6 part 2b — interactive escalation prompt. When
   *  `escalationMode: 'ask'` AND the classifier produces
   *  `local-with-escalation` AND this hook is supplied, the router
   *  awaits a yes/no answer before deciding the lane. Returning `true`
   *  routes to frontier; `false` stays on the configured default lane.
   *  When the hook is undefined, `'ask'` falls through to the default
   *  lane (matches the pre-2b behavior — useful for piped/CI sessions
   *  where there's no TTY to prompt). */
  escalationAsker?: (prompt: string) => Promise<boolean>;
};

export class RouterProvider implements LLMProvider {
  readonly name = 'router';
  private currentSessionId: string;
  private currentAsker: ((prompt: string) => Promise<boolean>) | undefined;
  constructor(private readonly opts: RouterProviderOpts) {
    this.currentSessionId = opts.sessionId ?? 'unknown';
    this.currentAsker = opts.escalationAsker;
  }

  /** Update the session id used in audit records. The REPL calls this
   *  once `activeSessionId` resolves out of `openOrResumeSession`. */
  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  /** Install or replace the escalation asker. The REPL builds the
   *  router before the readline `question` source exists, so the
   *  asker is wired in once that source is ready. Pass `undefined`
   *  to remove (the router falls back to "stay on default lane"). */
  setEscalationAsker(asker: ((prompt: string) => Promise<boolean>) | undefined): void {
    this.currentAsker = asker;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    const promptText = extractPromptText(req);
    const contextByteCount = estimateContextBytes(req);
    const { recentToolErrors, recentSchemaFailures } = countRecentErrors(req.messages);
    const userOverride = this.opts.getNextOverride?.();
    const decision = classify(this.opts.config, {
      prompt: promptText,
      contextByteCount,
      recentToolErrors,
      recentSchemaFailures,
      ...(this.opts.localContextLength !== undefined
        ? { localContextLength: this.opts.localContextLength }
        : {}),
      ...(userOverride !== undefined ? { userOverride } : {}),
    });

    // Phase 10.6 part 2b — interactive escalation prompt. When the
    // classifier flagged escalation and the user opted into 'ask',
    // the asker decides the final lane. We mutate `decision.lane` in
    // place so the audit log + StreamEvent + delegation downstream
    // all see the user's chosen lane (not the default fallback).
    if (
      decision.classifierLane === 'local-with-escalation' &&
      this.opts.config.escalationMode === 'ask' &&
      this.currentAsker !== undefined
    ) {
      const promptForUser = `Local model is struggling (${decision.reason}). Escalate this turn to ${this.opts.config.frontierProvider}?`;
      let escalate = false;
      try {
        escalate = await this.currentAsker(promptForUser);
      } catch {
        // Asker errored (TTY closed, abort, etc.) — fall through to
        // the default lane. Don't crash the run.
        escalate = false;
      }
      if (escalate) {
        decision.lane = 'frontier';
        decision.reason = `${decision.reason}; user approved escalation`;
      } else {
        decision.lane = this.opts.config.defaultLane ?? 'local';
        decision.reason = `${decision.reason}; user declined escalation, stay ${decision.lane}`;
      }
    }

    const delegatedProvider =
      decision.lane === 'local'
        ? this.opts.config.localProvider
        : this.opts.config.frontierProvider;
    const delegatedModel =
      decision.lane === 'local'
        ? (this.opts.config.localModel ?? '')
        : (this.opts.config.frontierModel ?? '');

    if (this.opts.auditLogger) {
      const now = Date.now();
      this.opts.auditLogger.record({
        timestampMs: now,
        iso: new Date(now).toISOString(),
        sessionId: this.currentSessionId,
        lane: decision.lane,
        classifierLane: decision.classifierLane,
        reason: decision.reason,
        provider: delegatedProvider,
        model: delegatedModel,
        promptHash: hashPrompt(promptText),
        contextByteCount,
        ...(userOverride !== undefined ? { userOverride } : {}),
      });
    }

    yield {
      type: 'route_decision',
      info: {
        lane: decision.lane,
        classifierLane: decision.classifierLane,
        reason: decision.reason,
        delegatedProvider,
        delegatedModel,
      },
    } as StreamEvent;

    const child = decision.lane === 'local' ? this.opts.localProvider : this.opts.frontierProvider;
    // The caller (query.ts) doesn't know which lane will run, so it
    // passes a synthetic model string ("local | frontier"). Swap that
    // for the configured lane model before delegating, otherwise the
    // child provider receives a bogus model name and the API rejects
    // it. When the config didn't specify a per-lane model, the child's
    // own default applies — pass empty to let the provider fill it in.
    const childReq: ProviderRequest = delegatedModel ? { ...req, model: delegatedModel } : req;
    // delegate; preserve final return value for the caller's `for await of`.
    return yield* child.stream(childReq);
  }
}

/** Pull the latest user text from a ProviderRequest. Returns the empty
 *  string when there's no user-text content (e.g. tool-result-only turns). */
function extractPromptText(req: ProviderRequest): string {
  const messages: readonly Message[] = req.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const text = message.content.find((b) => b.type === 'text');
    if (text?.type === 'text') return text.text;
  }
  return '';
}

/** Walk the message history and count recent tool errors. Looks back
 *  through the last `RECENT_WINDOW` tool_result blocks; counts those
 *  with `is_error: true`, and separately the subset whose content
 *  matches a schema-validation failure pattern. The classifier uses
 *  these to flip into `local-with-escalation` when a local model
 *  starts struggling.
 *
 *  Window is bounded so a long-running session doesn't accumulate old
 *  errors forever. Tool results are scanned newest-first; older
 *  entries beyond the window are ignored. */
function countRecentErrors(messages: readonly Message[]): {
  recentToolErrors: number;
  recentSchemaFailures: number;
} {
  let inspected = 0;
  let toolErrors = 0;
  let schemaFailures = 0;
  for (let i = messages.length - 1; i >= 0 && inspected < RECENT_WINDOW; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    for (let j = message.content.length - 1; j >= 0 && inspected < RECENT_WINDOW; j--) {
      const block = message.content[j];
      if (!block || block.type !== 'tool_result') continue;
      inspected++;
      if (block.is_error !== true) continue;
      toolErrors++;
      if (typeof block.content === 'string' && SCHEMA_FAILURE_RE.test(block.content)) {
        schemaFailures++;
      }
    }
  }
  return { recentToolErrors: toolErrors, recentSchemaFailures: schemaFailures };
}

const RECENT_WINDOW = 20;
const SCHEMA_FAILURE_RE = /input validation failed|schema validation|hook-updated input/i;

/** Conservative byte-count estimate: serialize the system + messages as
 *  JSON and count UTF-8 bytes. Used by the context-overflow heuristic. */
function estimateContextBytes(req: ProviderRequest): number {
  const sysBytes = (req.system ?? []).reduce(
    (n: number, s: SystemSegment) => n + Buffer.byteLength(s.text, 'utf8'),
    0,
  );
  const msgBytes = Buffer.byteLength(JSON.stringify(req.messages), 'utf8');
  return sysBytes + msgBytes;
}
