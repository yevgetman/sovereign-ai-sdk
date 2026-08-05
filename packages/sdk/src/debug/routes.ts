// Framework-agnostic route handlers for the debug console.
//
// THE SDK SHIPS NO AUTHORIZATION MODEL. `isPermitted` is required, not
// optional, and there is no default — a host that forgets to decide cannot
// accidentally publish its agent's internals (the prompts, the tool inputs, the
// session ids). One host gates on a role and answers 404; another will have its
// own answer. The DECISION is always the host's; the REFUSAL is ours.
//
// Handlers are plain async functions over a tiny request/response shape, so
// mounting them is a few lines on Express, Fastify, Hono, or a raw http server
// — none of which the SDK takes a dependency on.

import type { DebugCollector } from './collector.js';
import type { AgentFeed, DataEvent, TelemetryEvent } from './types.js';

/** What a handler needs to know about the caller. The host fills it in. */
export interface DebugRequestContext {
  /** Whose feed is being asked for. */
  principal: string;
  /** Anything the host's permission check needs — a session, roles, an IP. */
  [key: string]: unknown;
}

export interface DebugRouteResponse {
  status: number;
  body: unknown;
}

export interface DebugRouteHandlers {
  /** GET — the agent feed (turns + details). */
  feed(context: DebugRequestContext): Promise<DebugRouteResponse>;
  /** GET — telemetry rows. */
  telemetry(context: DebugRequestContext): Promise<DebugRouteResponse>;
  /** GET — data changes, when the host supplied a source. */
  data(context: DebugRequestContext): Promise<DebugRouteResponse>;
  /** POST — a client-reported event (a navigation). */
  event(
    context: DebugRequestContext,
    body: { name?: unknown; detail?: unknown },
  ): Promise<DebugRouteResponse>;
}

export interface DebugRouteOptions {
  collector: DebugCollector;
  /**
   * The host's access decision. REQUIRED. Return false and the handler refuses.
   *
   * Mounting these routes without a real check publishes your agent's
   * internals to anyone who can reach the path.
   */
  isPermitted: (context: DebugRequestContext) => Promise<boolean> | boolean;
  /**
   * The live session id for this principal, when the host tracks one. Without
   * it the console still works — it just has no "current session" to copy.
   */
  currentSessionId?: (context: DebugRequestContext) => Promise<string | null> | string | null;
  /**
   * The Data tab's source. ABSENT MEANS ABSENT: the handler answers 404 and the
   * console hides the tab, rather than showing an empty tab that implies
   * nothing has changed.
   */
  dataSource?: (context: DebugRequestContext) => Promise<DataEvent[]> | DataEvent[];
  /**
   * The status a refusal answers with. 404 (the default) does not confirm the
   * route exists to someone who may not use it; 403 is available for hosts that
   * prefer an explicit denial.
   */
  refusalStatus?: 404 | 403;
  /** Cap on rows returned per request (default 300). */
  limit?: number;
}

const DEFAULT_LIMIT = 300;
const NAME_CHARS = 200;
const DETAIL_CHARS = 200;

export function createDebugRouteHandlers(options: DebugRouteOptions): DebugRouteHandlers {
  const { collector, isPermitted } = options;
  const refusalStatus = options.refusalStatus ?? 404;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const refusal: DebugRouteResponse = { status: refusalStatus, body: { error: 'not found' } };

  /** Run `handler` only if the host permits it. A thrown check REFUSES. */
  async function guarded(
    context: DebugRequestContext,
    handler: () => Promise<DebugRouteResponse>,
  ): Promise<DebugRouteResponse> {
    let permitted = false;
    try {
      permitted = await isPermitted(context);
    } catch {
      // A permission check that throws is not a permission grant. Failing
      // closed here is the difference between an outage and a disclosure.
      return refusal;
    }
    if (!permitted) return refusal;
    return handler();
  }

  return {
    feed: (context) =>
      guarded(context, async () => {
        const currentSessionId = (await options.currentSessionId?.(context)) ?? null;
        const body: AgentFeed = {
          currentSessionId,
          events: collector.feedFor(context.principal).slice(0, limit),
          details: collector.detailsFor(context.principal).slice(0, limit),
        };
        return { status: 200, body };
      }),

    telemetry: (context) =>
      guarded(context, async () => {
        const body: TelemetryEvent[] = collector.telemetryFor(context.principal).slice(0, limit);
        return { status: 200, body };
      }),

    data: (context) =>
      guarded(context, async () => {
        // No source means the host has no Data vocabulary — say so honestly
        // rather than returning [] and implying nothing ever changes.
        if (options.dataSource === undefined) return refusal;
        const rows = await options.dataSource(context);
        return { status: 200, body: rows.slice(0, limit) };
      }),

    event: (context, body) =>
      guarded(context, async () => {
        // Client-reported input is untrusted: accept only strings, cap them,
        // and never let a malformed body reach the ring.
        const name = typeof body?.name === 'string' ? body.name.slice(0, NAME_CHARS) : '';
        if (name === '') return { status: 400, body: { error: 'name is required' } };
        collector.recordTelemetry({
          principal: context.principal,
          category: 'nav',
          name,
          ...(typeof body.detail === 'string'
            ? { detail: body.detail.slice(0, DETAIL_CHARS) }
            : {}),
        });
        return { status: 204, body: null };
      }),
  };
}
