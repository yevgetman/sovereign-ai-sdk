// First-use consent and on-disk allowlist for shell hooks (Invariant #13).
// Settings.json declares hooks; this module gates each declared hook with a
// one-time TTY prompt the first time it would fire. Allow → persisted to
// ~/.harness/shell-hooks-allowlist.json and the hook fires from then on.
// Deny → persisted, hook is inert until the user removes the entry by hand.
//
// Allowlist key shape: `<eventName>:<command-string>`. Moving an existing
// command to a different event re-prompts (cheap defence-in-depth — a hook
// approved as PostToolUse should not silently start running as PreToolUse).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AskUser } from '../permissions/types.js';
import type { HookEventName } from './types.js';

export type HookConsentDecision = 'allow' | 'deny';

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
    mkdirSync(dirname(path), { recursive: true });
    const data: AllowlistFile = {
      version: FILE_VERSION,
      decisions: Object.fromEntries(map.entries()),
    };
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
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

/** Wraps a HookConsentStore + AskUser into a single async check. Cached
 *  decisions short-circuit the prompt; new (event, command) pairs trigger
 *  the first-use modal once and then persist. */
export type HookConsentChecker = (
  event: HookEventName,
  command: string,
  signal?: AbortSignal,
) => Promise<HookConsentDecision>;

export function buildConsentChecker(opts: {
  store: HookConsentStore;
  ask: AskUser;
  /** Path shown in the prompt's reason text. Cosmetic; defaults to the
   *  Invariant-#13 path for transparency. */
  allowlistPath?: string;
}): HookConsentChecker {
  const allowlistPath = opts.allowlistPath ?? '~/.harness/shell-hooks-allowlist.json';
  return async (event, command, signal) => {
    const stored = opts.store.read(event, command);
    if (stored !== undefined) return stored;
    const answer = await opts.ask({
      toolName: 'hook',
      preview: `${event}: ${command}`,
      reason: `first-use consent for shell hook (decision stored at ${allowlistPath})`,
      ...(signal ? { signal } : {}),
    });
    // 'allow' and 'always' both grant — the file itself is the "always"
    // record. 'deny' (or anything else) is recorded as deny.
    const decision: HookConsentDecision = answer === 'deny' ? 'deny' : 'allow';
    opts.store.write(event, command, decision);
    return decision;
  };
}
