// /effort — reasoning-depth ("extended-thinking budget") control for the
// current session. Mirrors /model (src/commands/pickers.ts) exactly:
//
//   /effort               → opens the inline picker (5 levels; current marked)
//                           via the pickerOpen side-effect (M11.5). Each item,
//                           when chosen, re-dispatches /effort <level> which
//                           hits the explicit-arg branch below — the same
//                           mechanism /model uses to resolve a picker choice.
//   /effort <level>       → applies immediately via ctx.setEffort(level).
//   /effort status        → non-interactive current-level + support report.
//   /effort current       → alias of status.
//
// The behavioral effect lives in ctx.setEffort (Slice B), which mutates
// runtime.effort so the next turn's provider request carries the level and
// records the change as a side-effect for the TUI status display. This file is
// purely the user-facing surface; it never touches the provider wire.

import { REASONING_EFFORTS, type ReasoningEffort } from '../providers/effort.js';
import { modelSupportsReasoning } from '../providers/effort.js';
import type { CommandContext, LocalCommand } from './types.js';

const USAGE = '/effort [off|low|medium|high|max]';

export const effortCommand: LocalCommand = {
  type: 'local',
  name: 'effort',
  description: 'Set reasoning depth (extended-thinking budget) for this session.',
  usage: USAGE,
  call: async (args, ctx) => runEffort(args, ctx),
};

/** Type-guard narrowing an arbitrary string to a known effort level. */
function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** The active model's reasoning-support state under the resolved apiMode. */
function modelSupportsReasoningForCtx(ctx: CommandContext): boolean {
  return modelSupportsReasoning(ctx.model, ctx.apiMode);
}

/** Trailing "no effect" notice appended to a set-confirmation when the active
 *  model can't reason. Returned without a leading newline; callers join it. */
function unsupportedNotice(model: string): string {
  return `note: ${model} doesn't support reasoning depth — no effect until you switch to a reasoning model.`;
}

/** Non-interactive current-level + support report. Used by `/effort status`,
 *  `/effort current`, and as the fallback when there's no picker surface. */
function statusReport(ctx: CommandContext): string {
  const supported = modelSupportsReasoningForCtx(ctx);
  const support = supported
    ? `${ctx.model} supports reasoning depth.`
    : `${ctx.model} does not support reasoning depth — set a level here, but it takes effect only on a reasoning model.`;
  return [`effort: ${ctx.effort} (reasoning depth for this session).`, support].join('\n');
}

async function runEffort(args: string, ctx: CommandContext): Promise<string> {
  const arg = args.trim().toLowerCase();

  // Explicit status/current → non-interactive report, no mutation.
  if (arg === 'status' || arg === 'current') {
    return statusReport(ctx);
  }

  // Explicit level → apply immediately. Mirrors /model's explicit-arg branch;
  // also the picker's resolution path (selecting a row dispatches
  // `/effort <level>` which lands here).
  if (arg.length > 0) {
    if (!isReasoningEffort(arg)) {
      return `unknown effort level: ${arg}\nusage: ${USAGE}`;
    }
    ctx.setEffort(arg);
    const confirmation = `effort set to ${arg} (reasoning depth for this session).`;
    if (!modelSupportsReasoningForCtx(ctx)) {
      return [confirmation, unsupportedNotice(ctx.model)].join('\n');
    }
    return confirmation;
  }

  // No arg + picker surface → emit pickerOpen; the TUI renders an inline card.
  // Selection re-dispatches `/effort <level>` (the explicit-arg branch above).
  // Mirrors /model's server-mode branch (ADR M11.5-01).
  if (ctx.requestPicker) {
    const supported = modelSupportsReasoningForCtx(ctx);
    const support = supported ? `${ctx.model} supports it` : `${ctx.model} can't reason`;
    ctx.requestPicker({
      title: 'reasoning depth',
      subtitle: `current: ${ctx.effort} · ${support}`,
      items: REASONING_EFFORTS.map((level) => ({
        label: level,
        value: level,
        ...(level === ctx.effort ? { hint: '(current)' } : {}),
      })),
      initial: Math.max(
        0,
        REASONING_EFFORTS.findIndex((level) => level === ctx.effort),
      ),
      onSelect: { command: 'effort' },
    });
    return '';
  }

  // No arg + no picker surface → fall back to the non-interactive report.
  return statusReport(ctx);
}
