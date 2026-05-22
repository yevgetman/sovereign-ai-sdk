// M10.5 — POST /sessions/:id/commands route.
// Backlog #45 (closed 2026-05-19) — GET /sessions/:id/commands route.
//
// Bridges the existing slash-command registry (src/commands/registry.ts)
// into server-mode. The dedicated routes /sessions/:id/compact and
// /sessions/:id/skills keep their existing shapes; this generic
// dispatcher handles every other built-in (/help, /cost, /tasks,
// /review, /config, /commit, /agents, /permissions, /context-budget,
// /resume, /continue, /history, /export, /status, /stats, …).
//
// POST shape (M10.5):
//   POST /sessions/<id>/commands { name, args } → 200 {
//     output: string,         // text to render on the TUI transcript
//     error?: string,         // when the command's own dispatch failed
//                              // (e.g., "unknown command: /foo")
//     sideEffects?: {         // mutations the TUI must react to
//       newSessionId?: string,    // /clear future-wire (M10.5 stub)
//       exitRequested?: boolean,  // /quit
//       modelChanged?: string,    // /model <m>
//       pickerOpen?: { ... },     // /model, /resume, /export no-args (M11.5)
//       themeChanged?: string,    // /theme <name> (backlog #46)
//     }
//   }
//   400 — invalid session id or malformed body
//   404 — unknown session
//   500 — unexpected internal failure
//
// GET shape (backlog #45):
//   GET /sessions/<id>/commands → 200 {
//     commands: Array<{ name, description, usage? }>
//   }
//   400 — invalid session id
//   404 — unknown session
//
// The GET surface lets the Go TUI populate its autocomplete popup
// dynamically instead of relying on the hand-mirrored staticEntries
// list in slashautocomplete.go. Mirrors the M8 T4 skills hydration
// pattern (GET /sessions/:id/skills); the autocomplete merges
// commands + skills client-side.
//
// Notes:
//  - `dispatchSlashCommand` takes a single rawInput string ("/name args");
//    we build it from the parsed envelope so callers don't have to think
//    about the leading slash on the wire.
//  - Prompt-type commands (e.g., /commit) return their generated prompt
//    text wrapped in a brief explanation. Server-mode v1 surfaces the
//    template; auto-sending it as a /turns request is M11+ polish.
//  - The GET endpoint returns only built-in commands from COMMANDS
//    (registry.ts). Skill-derived slash commands are surfaced via the
//    sibling GET /sessions/:id/skills endpoint; the TUI merges both
//    sources when computing autocomplete matches.

import { Hono } from 'hono';
import { COMMANDS, dispatchSlashCommand } from '../../commands/registry.js';
import { buildServerCommandContext } from '../commandContext.js';
import type { Runtime } from '../runtime.js';
import { CommandRequestSchema, type CommandResponse } from '../schema.js';
import { isValidSessionId } from '../sessionId.js';

export function commandsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  // Backlog #45 — GET discovery endpoint. Returns the built-in
  // commands the dispatcher knows about so the TUI can populate its
  // autocomplete popup dynamically. Prompt-type commands are included
  // (they're dispatchable too) but no internal metadata is leaked —
  // name + description + optional usage only.
  r.get('/sessions/:id/commands', (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (runtime.sessionDb.getSession(sessionId) === null) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json({
      commands: COMMANDS.map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        ...(cmd.usage !== undefined ? { usage: cmd.usage } : {}),
      })),
    });
  });

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
      let promptToSend: string | undefined;

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
          // Prompt-type commands (/init, /commit, every skill-sourced
          // command, etc.) expand into a content-block array meant to be
          // submitted as the next agent turn. The route surfaces both
          // the flattened text (for callers without a session, like
          // `sov dispatch`, or any UI that wants to show the prompt) AND
          // the structured `promptToSend` field that session-bearing
          // callers (the TUI, `sov drive`) auto-send as a turn. 2026-05-22
          // PM — replaced the prior code path that interpolated
          // ContentBlock[] into the output string directly, which
          // produced "[object Object]" and silently broke /init, /commit,
          // and skill-driven commands.
          promptToSend = flattenContentBlocks(result.content);
          output =
            promptToSend !== ''
              ? `Prompt-type slash command. Sending the expanded prompt as a turn:\n\n${promptToSend}`
              : 'Prompt-type slash command returned empty content.';
          break;
        default:
          // Exhaustive guard — every CommandDispatchResult kind handled.
          // Fall through to a generic representation.
          output = JSON.stringify(result);
      }

      const response: CommandResponse = {
        output,
        ...(error !== undefined ? { error } : {}),
        ...(promptToSend !== undefined ? { promptToSend } : {}),
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
  themeChanged?: string;
};

/** Flatten a prompt command's ContentBlock[] into plain text. The
 *  expansion path in src/commands/registry.ts produces
 *  `Promise<ContentBlock[]>` where each block is `{type:'text', text}`
 *  (current usage) or potentially other Anthropic content-block kinds
 *  (image, tool_use, etc., though none are emitted by the bundled
 *  command authors today). Text blocks join on newlines; non-text
 *  blocks are silently dropped — they have no plain-text fallback,
 *  and the prompt-command authors who care about non-text blocks
 *  haven't shipped yet. 2026-05-22 PM. */
function flattenContentBlocks(content: ReadonlyArray<unknown>): string {
  const parts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      'type' in block &&
      (block as { type: unknown }).type === 'text' &&
      'text' in block &&
      typeof (block as { text: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n');
}

function hasSideEffects(s: SideEffectsBag): boolean {
  return (
    s.newSessionId !== undefined ||
    s.exitRequested !== undefined ||
    s.modelChanged !== undefined ||
    s.pickerOpen !== undefined ||
    s.themeChanged !== undefined
  );
}

function pickSideEffects(s: SideEffectsBag): SideEffectsBag {
  const out: SideEffectsBag = {};
  if (s.newSessionId !== undefined) out.newSessionId = s.newSessionId;
  if (s.exitRequested !== undefined) out.exitRequested = s.exitRequested;
  if (s.modelChanged !== undefined) out.modelChanged = s.modelChanged;
  if (s.pickerOpen !== undefined) out.pickerOpen = s.pickerOpen;
  if (s.themeChanged !== undefined) out.themeChanged = s.themeChanged;
  return out;
}
