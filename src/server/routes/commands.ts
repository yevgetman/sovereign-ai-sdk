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
import type { AppVariables } from '../auth.js';
import { buildServerCommandContext } from '../commandContext.js';
import type { Runtime } from '../runtime.js';
import { CommandRequestSchema, type CommandResponse } from '../schema.js';
import { isValidSessionId } from '../sessionId.js';
import { loadOwnedSession } from './ownership.js';

export function commandsRoute(runtime: Runtime): Hono<{ Variables: AppVariables }> {
  const r = new Hono<{ Variables: AppVariables }>();

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
    // Phase E T4 — owner-only access (404 hides another principal's session).
    if (loadOwnedSession(runtime, c, sessionId) === null) {
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
    // Phase E T4 — owner-only access. Hide another principal's session as
    // non-existent → 404 (never 403), BEFORE getSessionContext builds/caches a
    // per-session context. Implicit/null owner sees all (back-compat).
    const session = loadOwnedSession(runtime, c, sessionId);
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
    const { ctx, sideEffects } = buildServerCommandContext(runtime, sessionCtx, sessionId, {
      ...(runtime.configStandalone === true ? { configStandalone: true } : {}),
    });

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
  // Slice D / T7 — /effort <level> records the new reasoning-depth
  // level (off|low|medium|high|max) so the TUI updates its status
  // chrome. Parallels modelChanged.
  effortChanged?: import('@yevgetman/sov-sdk/providers/effort').ReasoningEffort;
  pickerOpen?: import('@yevgetman/sov-sdk/commands/types').PickerOpenConfig;
  themeChanged?: string;
  // 2026-05-24 — Config UX rebuild surfaces these in addition to pickerOpen.
  inputOpen?: import('@yevgetman/sov-sdk/commands/types').InputOpenConfig;
  verboseChanged?: boolean;
  taskRouterChanged?: string;
  // 2026-05-24 patch — /clear sets this to true to wipe scrollback.
  clearScrollback?: boolean;
  // 2026-05-24 patch — /config commit/discard sets this to close
  // any active picker / input card on the TUI side.
  closeModal?: boolean;
  // 2026-06-14 config live-apply (M6) — chrome reflections for live
  // /config edits. permissionModeChanged surfaces the new permission
  // mode (loud for 'bypass'); the ui.* fields tell the Go renderer to
  // apply appearance changes live the same way verboseChanged /
  // themeChanged do. Mirrors CommandSideEffectsSchema (src/server/schema.ts).
  permissionModeChanged?: string;
  toolOutputChanged?: { mode?: string; inlineLines?: number };
  footerChanged?: boolean;
  contextMeterChanged?: { warnAtPercent?: number; dangerAtPercent?: number };
  diffRenderChanged?: boolean;
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

// Exported for the T5 wire-seam test (seams 2+3) so the side-effect
// round-trip can be asserted at the unit level WITHOUT coupling to the
// collector (commandContext.ts, seam 1) or the Go decoder (seam 5) landing
// order. Named exports avoid the module-init temporal-dead-zone a wrapper
// const would hit when two test files load this module together. Not part of
// the route's runtime surface — only the route below calls these.
export function hasSideEffects(s: SideEffectsBag): boolean {
  return (
    s.newSessionId !== undefined ||
    s.exitRequested !== undefined ||
    s.modelChanged !== undefined ||
    s.effortChanged !== undefined ||
    s.pickerOpen !== undefined ||
    s.themeChanged !== undefined ||
    s.inputOpen !== undefined ||
    s.verboseChanged !== undefined ||
    s.taskRouterChanged !== undefined ||
    s.clearScrollback !== undefined ||
    s.closeModal !== undefined ||
    // 2026-06-14 config live-apply (M6) — chrome reflections.
    s.permissionModeChanged !== undefined ||
    s.toolOutputChanged !== undefined ||
    s.footerChanged !== undefined ||
    s.contextMeterChanged !== undefined ||
    s.diffRenderChanged !== undefined
  );
}

export function pickSideEffects(s: SideEffectsBag): SideEffectsBag {
  const out: SideEffectsBag = {};
  if (s.newSessionId !== undefined) out.newSessionId = s.newSessionId;
  if (s.exitRequested !== undefined) out.exitRequested = s.exitRequested;
  if (s.modelChanged !== undefined) out.modelChanged = s.modelChanged;
  if (s.effortChanged !== undefined) out.effortChanged = s.effortChanged;
  if (s.pickerOpen !== undefined) out.pickerOpen = s.pickerOpen;
  if (s.themeChanged !== undefined) out.themeChanged = s.themeChanged;
  if (s.inputOpen !== undefined) out.inputOpen = s.inputOpen;
  if (s.verboseChanged !== undefined) out.verboseChanged = s.verboseChanged;
  if (s.taskRouterChanged !== undefined) out.taskRouterChanged = s.taskRouterChanged;
  if (s.clearScrollback !== undefined) out.clearScrollback = s.clearScrollback;
  if (s.closeModal !== undefined) out.closeModal = s.closeModal;
  // 2026-06-14 config live-apply (M6) — chrome reflections.
  if (s.permissionModeChanged !== undefined) out.permissionModeChanged = s.permissionModeChanged;
  if (s.toolOutputChanged !== undefined) out.toolOutputChanged = s.toolOutputChanged;
  if (s.footerChanged !== undefined) out.footerChanged = s.footerChanged;
  if (s.contextMeterChanged !== undefined) out.contextMeterChanged = s.contextMeterChanged;
  if (s.diffRenderChanged !== undefined) out.diffRenderChanged = s.diffRenderChanged;
  return out;
}
