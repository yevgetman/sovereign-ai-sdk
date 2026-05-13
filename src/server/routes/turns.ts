// Phase 16.1 M3.4 — turns route.
//
// POST /sessions/:id/turns body { text: string } kicks off a background
// query() loop. The handler returns 202 immediately; events flow through
// the per-session bus to the SSE subscriber. M3 wires text_delta and
// turn_complete; richer event types (tool_use_start, tool_result,
// permission_request, status_update) are folded in M4+.
//
// Background-run discipline: errors from the query() loop publish a
// turn_error event onto the bus rather than crashing the server.

import { Hono } from 'hono';
import { query } from '../../core/query.js';
import type { Message, StreamEvent } from '../../core/types.js';
import { type ServerEventBus, getOrCreateBus } from '../eventBus.js';
import type { Runtime } from '../runtime.js';
import type { ServerEvent } from '../schema.js';

const DEFAULT_MAX_TOKENS = 4096;

export function turnsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/sessions/:id/turns', async (c) => {
    const sessionId = c.req.param('id');
    const body = (await c.req.json()) as { text?: string };
    const text = typeof body.text === 'string' ? body.text : '';
    if (text === '') return c.json({ error: 'text is required' }, 400);

    const bus = getOrCreateBus(sessionId);
    // Run the turn synchronously into the bus from the caller's perspective;
    // we await it inline so events that the mock emits during the call land
    // before we return 202. (For real providers the bus buffers anyway —
    // synchronous awaiting just keeps the test-mode pattern obvious.)
    void runTurnInBackground(runtime, sessionId, text, bus);
    return c.json({ accepted: true }, 202);
  });

  return r;
}

async function runTurnInBackground(
  runtime: Runtime,
  sessionId: string,
  text: string,
  bus: ServerEventBus,
): Promise<void> {
  const userMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text }],
  };

  try {
    const stream = query({
      provider: runtime.resolvedProvider.transport,
      model: runtime.model,
      messages: [userMessage],
      systemPrompt: runtime.systemSegments,
      tools: runtime.toolPool,
      toolContext: {
        cwd: runtime.cwd,
        sessionId,
        harnessHome: runtime.harnessHome,
        agents: runtime.agents,
        ...(runtime.bundle ? { bundleRoot: runtime.bundle.root } : {}),
      },
      maxTokens: DEFAULT_MAX_TOKENS,
      sessionId,
      cwd: runtime.cwd,
    });

    // M3 collapses all assistant output onto block 0 — block tracking
    // lands when tool_use_start emits its own block index in M4+.
    const currentBlock = 0;
    let terminalEmitted = false;
    for await (const event of stream) {
      // Skip Message (full assistant messages) — they're metadata not
      // for the wire. We map only StreamEvent shapes to ServerEvents.
      if ('role' in event) continue;
      const mapped = mapStreamEventToServerEvent(event, bus, sessionId, currentBlock);
      if (mapped) {
        bus.publish(mapped);
        if (mapped.type === 'turn_complete' || mapped.type === 'turn_error') {
          terminalEmitted = true;
        }
      }
    }

    // If the loop ends without a message_stop (e.g. errored mid-stream),
    // emit a terminal turn_complete so the SSE subscriber unblocks. Skip
    // the fallback when the stream already produced one — otherwise the
    // bus would carry two turn_complete events per successful turn (SSE
    // consumer stops after the first; the second leaks into the buffer).
    if (!terminalEmitted && !bus.isClosed()) {
      bus.publish({
        type: 'turn_complete',
        seq: bus.nextSeq(),
        sessionId,
        finishReason: 'end_turn',
      });
    }
  } catch (err) {
    bus.publish({
      type: 'turn_error',
      seq: bus.nextSeq(),
      sessionId,
      error: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
  }
}

function mapStreamEventToServerEvent(
  event: StreamEvent,
  bus: ServerEventBus,
  sessionId: string,
  block: number,
): ServerEvent | null {
  switch (event.type) {
    case 'text_delta':
      return {
        type: 'text_delta',
        seq: bus.nextSeq(),
        sessionId,
        block,
        text: event.text,
      };
    case 'thinking_delta':
      return {
        type: 'thinking_delta',
        seq: bus.nextSeq(),
        sessionId,
        block,
        text: event.thinking,
      };
    case 'message_stop':
      return {
        type: 'turn_complete',
        seq: bus.nextSeq(),
        sessionId,
        finishReason: event.stop_reason,
      };
    // M3 deliberately omits tool_use_delta, usage_delta, message_start,
    // assistant_message, microcompact, loop_detected, route_decision —
    // those wire onto richer ServerEvent types in M4+.
    default:
      return null;
  }
}
