// Channel permission posture — the security foundation for Phase F.
//
// A channel turn is driven by an UNTRUSTED remote message (Slack / Telegram /
// webhook). Unlike cron (which inherits the local dev's layered allow/deny
// rules via loadPermissionSettings), a channel turn MUST run safe-by-default:
//
//   * It does NOT consult loadPermissionSettings — the local dev's
//     settings.local.json allow-rules are never inherited. A remote attacker
//     cannot ride a developer's `allow: Bash(*)` to run shell commands.
//   * Any tool that falls through to `ask` auto-denies — there is no human at
//     a channel boundary to approve, so the asker always answers 'deny'.
//   * `bypass` mode is rejected outright: a channel must never grant
//     blanket allow-on-fallthrough.
//
// Net effect: Bash / Write / Edit (which self-check 'ask') are denied, while
// read-only / permissionless tools (which self-check 'allow') still run.

import type { PermissionRuleLayer } from '@yevgetman/sov-sdk/config/rules';
import { buildCanUseTool } from '@yevgetman/sov-sdk/permissions/canUseTool';
import type { AskUser, CanUseTool } from '@yevgetman/sov-sdk/permissions/types';

/** Permission modes a channel turn may run under. `bypass` is intentionally
 *  excluded — see assertChannelPermissionMode. */
export type ChannelPermissionMode = 'default' | 'ask';

export type BuildChannelCanUseToolOpts = {
  /** Defaults to 'default'. 'bypass' is not assignable; assertChannelPermissionMode
   *  guards string-typed inputs from config. */
  mode?: ChannelPermissionMode;
  /** Escape hatch for explicit, channel-scoped rules (NOT the local dev's
   *  settings layers). Empty by default — no local-allow inheritance. */
  ruleLayers?: PermissionRuleLayer[];
};

/** Reject `bypass` for channel turns and validate the mode came from a known
 *  set. Throws on anything that is not 'default' or 'ask'. Call this at the
 *  config boundary before constructing the decider. */
export function assertChannelPermissionMode(mode: string): void {
  if (mode === 'bypass') {
    throw new Error(
      "channel permission mode 'bypass' is not allowed: a channel turn is driven by an untrusted remote message and must not grant allow-on-fallthrough",
    );
  }
  if (mode !== 'default' && mode !== 'ask') {
    throw new Error(
      `invalid channel permission mode ${JSON.stringify(mode)}: expected 'default' or 'ask'`,
    );
  }
}

/** Build the safe-by-default permission decider for a channel turn.
 *
 *  CRITICAL: this never calls loadPermissionSettings, so the local dev's
 *  allow-rules are not inherited. The asker always denies, so any 'ask'
 *  fallthrough resolves to deny. */
export function buildChannelCanUseTool(opts: BuildChannelCanUseToolOpts = {}): CanUseTool {
  // No interactive approver at a channel boundary: every fallthrough denies.
  const ask: AskUser = async () => 'deny';
  return buildCanUseTool({
    mode: opts.mode ?? 'default',
    ask,
    // Never seed a session-scoped allow-cache from an untrusted source.
    alwaysAllow: new Set<string>(),
    // Empty by default — the load-bearing "no local-allow inheritance" choice.
    ruleLayers: opts.ruleLayers ?? [],
  });
}
