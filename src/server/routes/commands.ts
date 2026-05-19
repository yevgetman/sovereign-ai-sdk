// M10.5 — POST /sessions/:id/commands route.
//
// Bridges the existing slash-command registry (src/commands/registry.ts)
// into server-mode. The dedicated routes /sessions/:id/compact and
// /sessions/:id/skills keep their existing shapes; this generic
// dispatcher handles every other built-in (/help, /cost, /tasks,
// /review, /config, /commit, /agents, /permissions, /context-budget,
// /resume, /continue, /history, /export, /status, /stats, …).
//
// Wire shape:
//   POST /sessions/<id>/commands { name, args } → 200 {
//     output: string,         // text to render on the TUI transcript
//     error?: string,         // when the command's own dispatch failed
//                              // (e.g., "unknown command: /foo")
//     sideEffects?: {         // mutations the TUI must react to
//       newSessionId?: string,    // /clear future-wire (M10.5 stub)
//       exitRequested?: boolean,  // /quit
//       modelChanged?: string,    // /model <m>
//       pickerOpen?: { ... },     // /model, /resume, /export no-args (M11.5)
//     }
//   }
//   400 — invalid session id or malformed body
//   404 — unknown session
//   500 — unexpected internal failure
//
// Notes:
//  - `dispatchSlashCommand` takes a single rawInput string ("/name args");
//    we build it from the parsed envelope so callers don't have to think
//    about the leading slash on the wire.
//  - Prompt-type commands (e.g., /commit) return their generated prompt
//    text wrapped in a brief explanation. Server-mode v1 surfaces the
//    template; auto-sending it as a /turns request is M11+ polish.

import { Hono } from 'hono';
import { dispatchSlashCommand } from '../../commands/registry.js';
import { buildServerCommandContext } from '../commandContext.js';
import type { Runtime } from '../runtime.js';
import { CommandRequestSchema, type CommandResponse } from '../schema.js';
import { isValidSessionId } from '../sessionId.js';

export function commandsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/sessions/:id/commands', async (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const session = runtime.sessionDb.getSession(sessionId);
    if (session === null) {
      return c.json({ error: 'not found' }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }
    const parsed = CommandRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }
    const { name, args } = parsed.data;

    // SessionContext is lazy-built on first use. The runtime caches it
    // for the lifetime of the session — subsequent commands on the same
    // session id reuse the same instance (review manager, learning
    // observer, etc. accumulate state across commands).
    const sessionCtx = runtime.getSessionContext(sessionId);
    const { ctx, sideEffects } = buildServerCommandContext(runtime, sessionCtx, sessionId);

    // Build raw input the registry's parser recognizes: /name plus
    // space-separated args. Empty args produces "/name" (no trailing
    // space) so registry.parseSlashCommand sees args:''.
    const rawInput = args.length > 0 ? `/${name} ${args}` : `/${name}`;

    try {
      const result = await dispatchSlashCommand(rawInput, ctx);
      let output: string;
      let error: string | undefined;

      switch (result.kind) {
        case 'local':
          output = result.output;
          break;
        case 'unknown':
          // The registry already formats a helpful message including the
          // /help text. We surface it via the `error` field so the TUI
          // can render it in a warning style.
          output = '';
          error = result.output;
          break;
        case 'prompt':
          // Prompt-type commands (e.g., /commit) generate a prompt template
          // that REPL would auto-send as the next turn. Server-mode v1
          // surfaces the template so the user can copy/paste it. Auto-send
          // wiring is M11+ polish.
          output = `Prompt-type slash command. To execute, paste the following as a regular message:\n\n${result.content}`;
          break;
        default:
          // Exhaustive guard — every CommandDispatchResult kind handled.
          // Fall through to a generic representation.
          output = JSON.stringify(result);
      }

      const response: CommandResponse = {
        output,
        ...(error !== undefined ? { error } : {}),
        ...(hasSideEffects(sideEffects) ? { sideEffects: pickSideEffects(sideEffects) } : {}),
      };
      return c.json(response);
    } catch (err) {
      // The command handler threw. Convert to a 200 with the error field
      // set so the TUI rendering is uniform — every dispatcher call
      // produces a transcript-renderable result.
      const response: CommandResponse = {
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
      return c.json(response);
    }
  });

  return r;
}

type SideEffectsBag = {
  newSessionId?: string;
  exitRequested?: boolean;
  modelChanged?: string;
  pickerOpen?: import('../../commands/types.js').PickerOpenConfig;
};

function hasSideEffects(s: SideEffectsBag): boolean {
  return (
    s.newSessionId !== undefined ||
    s.exitRequested !== undefined ||
    s.modelChanged !== undefined ||
    s.pickerOpen !== undefined
  );
}

function pickSideEffects(s: SideEffectsBag): SideEffectsBag {
  const out: SideEffectsBag = {};
  if (s.newSessionId !== undefined) out.newSessionId = s.newSessionId;
  if (s.exitRequested !== undefined) out.exitRequested = s.exitRequested;
  if (s.modelChanged !== undefined) out.modelChanged = s.modelChanged;
  if (s.pickerOpen !== undefined) out.pickerOpen = s.pickerOpen;
  return out;
}
