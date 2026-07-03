// First-use consent and on-disk allowlist for shell hooks (Invariant #13).
// Settings.json declares hooks; this module gates each declared hook with a
// one-time TTY prompt the first time it would fire. Allow → persisted to
// ~/.harness/shell-hooks-allowlist.json and the hook fires from then on.
// Deny → persisted, hook is inert until the user removes the entry by hand.
//
// Allowlist key shape: `<eventName>:<command-string>`. Moving an existing
// command to a different event re-prompts (cheap defence-in-depth — a hook
// approved as PostToolUse should not silently start running as PreToolUse).

import { existsSync, readFileSync } from 'node:fs';
import type { AskUser } from '../permissions/types.js';
import { secureWriteFileAtomic } from '../util/secureFs.js';
import type { HookEventName } from './types.js';

/** A decision that is PERSISTED to the on-disk allowlist. Only genuine user
 *  answers (allow/deny chosen by a human) are ever recorded here. */
export type HookConsentDecision = 'allow' | 'deny';

/** Runtime outcome of a consent check. `'skip'` is a TRANSIENT state — the hook
 *  has no recorded user decision AND there's no interactive prompt available to
 *  ask for one (the runtime wires a non-interactive `ask: () => 'deny'` on every
 *  surface). It is NOT persisted: the runner skips the hook this turn and the
 *  check re-evaluates next time. This keeps an environment auto-deny from being
 *  silently written to disk as if the user had chosen it. */
export type HookConsentOutcome = HookConsentDecision | 'skip';

type AllowlistFile = {
  version: 1;
  decisions: Record<string, HookConsentDecision>;
};

const FILE_VERSION = 1;

export type HookConsentStore = {
  read(event: HookEventName, command: string): HookConsentDecision | undefined;
  write(event: HookEventName, command: string, decision: HookConsentDecision): void;
};

/** File-backed consent store. The file is read once on first access and the
 *  in-memory cache is the source of truth thereafter — writes go through to
 *  disk atomically (temp file + rename, mirroring credentials/pool.ts). */
export function buildFileConsentStore(path: string): HookConsentStore {
  let cache: Map<string, HookConsentDecision> | undefined;

  function load(): Map<string, HookConsentDecision> {
    if (cache) return cache;
    cache = new Map();
    if (!existsSync(path)) return cache;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as AllowlistFile;
      if (parsed && typeof parsed === 'object' && parsed.decisions) {
        for (const [k, v] of Object.entries(parsed.decisions)) {
          if (v === 'allow' || v === 'deny') cache.set(k, v);
        }
      }
    } catch {
      // Corrupt file: treat as empty. Next write fixes it.
    }
    return cache;
  }

  function persist(map: Map<string, HookConsentDecision>): void {
    // The allowlist discloses which shell-hook commands the operator approved.
    // Write it 0600 in a 0700 dir (audit F10) via the shared secure atomic
    // writer (audit C6, single source of truth).
    const data: AllowlistFile = {
      version: FILE_VERSION,
      decisions: Object.fromEntries(map.entries()),
    };
    secureWriteFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
  }

  return {
    read(event, command) {
      return load().get(consentKey(event, command));
    },
    write(event, command, decision) {
      const map = load();
      map.set(consentKey(event, command), decision);
      persist(map);
    },
  };
}

export function consentKey(event: HookEventName, command: string): string {
  return `${event}:${command}`;
}

/** Wraps a HookConsentStore + AskUser into a single async check. A previously
 *  persisted user decision short-circuits the prompt; a new (event, command)
 *  pair triggers the first-use prompt. Returns `'skip'` (transient, not
 *  persisted) when there is no recorded decision and no interactive prompt to
 *  obtain one — see {@link HookConsentOutcome}. */
export type HookConsentChecker = (
  event: HookEventName,
  command: string,
  signal?: AbortSignal,
) => Promise<HookConsentOutcome>;

export function buildConsentChecker(opts: {
  store: HookConsentStore;
  ask: AskUser;
  /** Whether `ask` is a real interactive prompt that can obtain a genuine user
   *  decision. Defaults to FALSE: the runtime wires a non-interactive
   *  `ask: () => 'deny'` on every surface, and an environment auto-deny must
   *  never be persisted as a user choice. When false, a hook with no recorded
   *  decision resolves to `'skip'` (transient) and nothing is written. Set true
   *  only for a TTY caller that actually prompts a human. */
  interactive?: boolean;
  /** Path shown in the prompt's reason text. Cosmetic; defaults to the
   *  Invariant-#13 path for transparency. */
  allowlistPath?: string;
}): HookConsentChecker {
  const allowlistPath = opts.allowlistPath ?? '~/.harness/shell-hooks-allowlist.json';
  const interactive = opts.interactive ?? false;
  return async (event, command, signal) => {
    const stored = opts.store.read(event, command);
    if (stored !== undefined) return stored;

    // No recorded user decision. Without an interactive prompt we cannot obtain
    // one — treat as transient `'skip'` and persist NOTHING. (Persisting the
    // environment's auto-deny would silently kill the hook forever as if the
    // user had chosen it.)
    if (!interactive) return 'skip';

    const answer = await opts.ask({
      toolName: 'hook',
      preview: `${event}: ${command}`,
      reason: `first-use consent for shell hook (decision stored at ${allowlistPath})`,
      ...(signal ? { signal } : {}),
    });
    // 'allow' and 'always' both grant — the file itself is the "always"
    // record. 'deny' is recorded as deny. Only a genuine user answer reaches
    // here, so it is safe to persist.
    const decision: HookConsentDecision = answer === 'deny' ? 'deny' : 'allow';
    opts.store.write(event, command, decision);
    return decision;
  };
}
