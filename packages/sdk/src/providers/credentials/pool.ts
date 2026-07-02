// Credential pool with persistent metadata only. Raw secrets come from env or
// config; ~/.harness/credentials.json stores status/cooldown/usage, never keys.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHarnessHome } from '../../config/paths.js';
import { secureWriteFileAtomic } from '../../util/secureFs.js';
import type { AuthType } from '../types.js';

export type PooledCredential = {
  id: string;
  provider: string;
  authType: AuthType;
  priority: number;
  status: 'ok' | 'exhausted' | 'auth_failed';
  lastError: string | null;
  lastErrorAt: number | null;
  cooldownUntil: number | null;
  usageCount: number;
  /** Non-reversible fingerprint of the secret the status was last recorded
   *  against. Lets a rotated key (same slot id, new secret) clear a stale
   *  `auth_failed`. Optional on disk for backward compat with pre-hash rows. */
  secretHash?: string;
};

export type CredentialStrategy = 'ROUND_ROBIN' | 'LEAST_USED' | 'FILL_FIRST';

export type CredentialInput = {
  id?: string;
  provider: string;
  authType: AuthType;
  secret?: string;
  priority?: number;
};

export type CredentialSelection = {
  credential: PooledCredential;
  secret?: string;
};

export type CredentialPoolOpts = {
  path?: string;
  strategy?: CredentialStrategy;
  now?: () => number;
  /** Memory-only mode (the SDK embed path). When true the pool holds status
   *  metadata in memory ONLY: it never resolves a default state path (so
   *  resolveHarnessHome() is never called, and HARNESS_HOME is never mkdir'd),
   *  never reads an existing credentials.json, and never persists. Selection +
   *  lockout logic are unchanged. Default false preserves the CLI/gateway's
   *  cross-process disk-backed state (they pass an explicit `path`). */
  memory?: boolean;
};

type StateFile = {
  credentials?: Record<string, Record<string, PooledCredential>>;
};

/** Profile-aware default credential-state path. Resolves at call time
 *  so a profile-scoped HARNESS_HOME (Phase 10.7) lands the file under
 *  the right profile root. */
export function getDefaultCredentialStatePath(): string {
  return join(resolveHarnessHome(), 'credentials.json');
}

// NB: no eager module-level default-path const. Resolving it at import time
// called resolveHarnessHome() → unconditional mkdirSync(HARNESS_HOME), so
// merely importing the SDK (createAgent → resolver → pool) touched disk before
// any run() — and threw under a read-only home. Callers resolve lazily via
// getDefaultCredentialStatePath() instead (audit C2 — no import-time disk).
const DEFAULT_COOLDOWN_SECONDS = 60 * 60;
/** A 401/403 is auto-deny-worthy but not necessarily permanent (transient
 *  proxy/org 403, or a key the user is about to rotate). Lock out for a bounded
 *  window so the credential self-heals instead of bricking the provider. */
const DEFAULT_AUTH_FAILED_COOLDOWN_SECONDS = 10 * 60;

export class CredentialPool {
  private readonly state: StateFile;
  private readonly path: string;
  private readonly memory: boolean;
  private readonly now: () => number;
  private readonly strategy: CredentialStrategy;
  private readonly secrets = new Map<string, string | undefined>();
  private readonly activeIds = new Set<string>();

  /** Credential ids this pool has mutated this process. Only these rows are
   *  overlaid onto the freshly-read disk state at persist() time, so a
   *  concurrent same-provider process's untouched rows are never clobbered by
   *  our stale boot snapshot. */
  private readonly dirtyIds = new Set<string>();

  constructor(
    private readonly provider: string,
    inputs: CredentialInput[],
    opts: CredentialPoolOpts = {},
  ) {
    this.memory = opts.memory ?? false;
    // In memory mode, never resolve the default path — getDefaultCredentialStatePath()
    // calls resolveHarnessHome(), which mkdir's HARNESS_HOME. The `?? (ternary)`
    // short-circuits it entirely when no explicit path is given.
    this.path = opts.path ?? (this.memory ? '' : getDefaultCredentialStatePath());
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.strategy = opts.strategy ?? 'ROUND_ROBIN';
    this.state = this.memory ? {} : readState(this.path);
    if (!this.state.credentials) this.state.credentials = {};
    const providerState = this.state.credentials[this.provider] ?? {};
    this.state.credentials[this.provider] = providerState;

    for (const input of inputs) {
      const secretHash = hashSecret(input.secret ?? '');
      const id = input.id ?? `${input.provider}-${secretHash}`;
      this.activeIds.add(id);
      // Seeding a slot (incl. clearing a stale lockout on a rotated secret) is
      // a mutation we own; record it so it survives the merge.
      this.dirtyIds.add(id);
      const existing = providerState[id];
      this.secrets.set(id, input.secret);
      // A rotated secret under the same slot id (env-var / config key) must
      // clear a stale auth_failed/exhausted lockout. We only reset when the
      // stored hash is known AND differs — a pre-hash row (undefined) is left
      // untouched and simply gets its hash stamped going forward.
      const secretChanged =
        existing?.secretHash !== undefined && existing.secretHash !== secretHash;
      const carry = secretChanged ? undefined : existing;
      providerState[id] = {
        id,
        provider: input.provider,
        authType: input.authType,
        priority: input.priority ?? existing?.priority ?? 0,
        status: carry?.status ?? 'ok',
        lastError: carry?.lastError ?? null,
        lastErrorAt: carry?.lastErrorAt ?? null,
        cooldownUntil: carry?.cooldownUntil ?? null,
        usageCount: existing?.usageCount ?? 0,
        secretHash,
      };
    }
    this.persist();
    // The boot-seed persist above is a one-shot write of the seeded rows onto
    // the then-current disk state. Clearing the dirty set here ensures that
    // every LATER persist overlays only the rows this process mutates at
    // runtime — a stale boot snapshot of an untouched sibling can no longer
    // clobber a concurrent same-provider process's fresh write to it.
    this.dirtyIds.clear();
  }

  select(): CredentialSelection | null {
    const candidates = Object.values(this.state.credentials?.[this.provider] ?? {}).filter(
      (c) => this.activeIds.has(c.id) && this.isUsable(c),
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => compareCredentials(a, b, this.strategy));
    const credential = candidates[0];
    if (!credential) return null;
    credential.usageCount++;
    credential.status = 'ok';
    credential.cooldownUntil = null;
    this.dirtyIds.add(credential.id);
    this.persist();
    const secret = this.secrets.get(credential.id);
    return secret === undefined ? { credential } : { credential, secret };
  }

  markOk(id: string): void {
    const cred = this.get(id);
    if (!cred) return;
    cred.status = 'ok';
    cred.lastError = null;
    cred.lastErrorAt = null;
    cred.cooldownUntil = null;
    this.dirtyIds.add(id);
    this.persist();
  }

  markExhausted(id: string, reason: string, cooldownUntil?: number): void {
    const cred = this.get(id);
    if (!cred) return;
    cred.status = 'exhausted';
    cred.lastError = reason;
    cred.lastErrorAt = this.now();
    cred.cooldownUntil = cooldownUntil ?? this.now() + DEFAULT_COOLDOWN_SECONDS;
    this.dirtyIds.add(id);
    this.persist();
  }

  markAuthFailed(id: string, reason: string): void {
    const cred = this.get(id);
    if (!cred) return;
    cred.status = 'auth_failed';
    cred.lastError = reason;
    cred.lastErrorAt = this.now();
    // Bounded cooldown rather than a permanent lockout: a transient 403 must
    // self-heal, and a rotated key (detected by secret-hash change at
    // construction) clears it immediately on the next boot regardless.
    cred.cooldownUntil = this.now() + DEFAULT_AUTH_FAILED_COOLDOWN_SECONDS;
    this.dirtyIds.add(id);
    this.persist();
  }

  private get(id: string): PooledCredential | undefined {
    return this.state.credentials?.[this.provider]?.[id];
  }

  private isUsable(cred: PooledCredential): boolean {
    // Both auth_failed and exhausted are temporary: usable again once the
    // cooldown elapses. A legacy auth_failed row written before cooldowns
    // existed (cooldownUntil null) is treated as already-elapsed → retried.
    if (
      (cred.status === 'exhausted' || cred.status === 'auth_failed') &&
      (cred.cooldownUntil ?? 0) > this.now()
    ) {
      return false;
    }
    return true;
  }

  private persist(): void {
    // Memory-only mode (SDK embed path): status metadata lives in `this.state`
    // and is never written to disk.
    if (this.memory) return;
    // Re-read the current file and overlay ONLY the credential rows this pool
    // actually mutated this process. Replacing the whole provider sub-map with
    // our boot snapshot would clobber a concurrent SAME-provider process's
    // rows (the 'two gateways' case): both pools share a provider, so a
    // map-level merge still loses the other's fresh lockout. Row-level overlay
    // is last-writer-per-credential — an untouched sibling another process
    // wrote always survives our persist.
    const disk = readState(this.path);
    const diskCredentials = disk.credentials ?? {};
    const diskProvider = diskCredentials[this.provider] ?? {};
    const ours = this.state.credentials?.[this.provider] ?? {};
    const mergedProvider: Record<string, PooledCredential> = { ...diskProvider };
    for (const id of this.dirtyIds) {
      const row = ours[id];
      if (row) mergedProvider[id] = row;
    }
    const merged: StateFile = {
      credentials: { ...diskCredentials, [this.provider]: mergedProvider },
    };
    writeStateAtomic(this.path, merged);
  }
}

function compareCredentials(
  a: PooledCredential,
  b: PooledCredential,
  strategy: CredentialStrategy,
): number {
  const priority = a.priority - b.priority;
  if (priority !== 0) return priority;
  if (strategy === 'FILL_FIRST') return a.id.localeCompare(b.id);
  if (strategy === 'LEAST_USED' || strategy === 'ROUND_ROBIN') {
    const usage = a.usageCount - b.usageCount;
    return usage !== 0 ? usage : a.id.localeCompare(b.id);
  }
  return 0;
}

function readState(path: string): StateFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StateFile;
  } catch {
    return {};
  }
}

function writeStateAtomic(path: string, state: StateFile): void {
  // Keep the whole state root uniform (audit F10): dir 0700, file 0600, atomic
  // rename — via the shared secure writer (audit C6, single source of truth).
  secureWriteFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

function hashSecret(secret: string): string {
  let h = 2166136261;
  for (let i = 0; i < secret.length; i++) {
    h ^= secret.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
