// Credential pool with persistent metadata only. Raw secrets come from env or
// config; ~/.harness/credentials.json stores status/cooldown/usage, never keys.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveHarnessHome } from '../../config/paths.js';
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

/** @deprecated Eager const; profile-aware callers should use
 *  `getDefaultCredentialStatePath()`. Retained for backward compat. */
export const DEFAULT_CREDENTIAL_STATE_PATH = getDefaultCredentialStatePath();
const DEFAULT_COOLDOWN_SECONDS = 60 * 60;
/** A 401/403 is auto-deny-worthy but not necessarily permanent (transient
 *  proxy/org 403, or a key the user is about to rotate). Lock out for a bounded
 *  window so the credential self-heals instead of bricking the provider. */
const DEFAULT_AUTH_FAILED_COOLDOWN_SECONDS = 10 * 60;

export class CredentialPool {
  private readonly state: StateFile;
  private readonly path: string;
  private readonly now: () => number;
  private readonly strategy: CredentialStrategy;
  private readonly secrets = new Map<string, string | undefined>();
  private readonly activeIds = new Set<string>();

  constructor(
    private readonly provider: string,
    inputs: CredentialInput[],
    opts: CredentialPoolOpts = {},
  ) {
    this.path = opts.path ?? getDefaultCredentialStatePath();
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.strategy = opts.strategy ?? 'ROUND_ROBIN';
    this.state = readState(this.path);
    if (!this.state.credentials) this.state.credentials = {};
    const providerState = this.state.credentials[this.provider] ?? {};
    this.state.credentials[this.provider] = providerState;

    for (const input of inputs) {
      const secretHash = hashSecret(input.secret ?? '');
      const id = input.id ?? `${input.provider}-${secretHash}`;
      this.activeIds.add(id);
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
    this.persist();
  }

  markExhausted(id: string, reason: string, cooldownUntil?: number): void {
    const cred = this.get(id);
    if (!cred) return;
    cred.status = 'exhausted';
    cred.lastError = reason;
    cred.lastErrorAt = this.now();
    cred.cooldownUntil = cooldownUntil ?? this.now() + DEFAULT_COOLDOWN_SECONDS;
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
    // Last-writer-wins at the file level would clobber other providers' rows
    // that a concurrent process (gateway + cron tick, two gateways, ...) wrote
    // since our boot snapshot. Re-read the current file and merge in ONLY this
    // pool's provider sub-map, then write atomically.
    const disk = readState(this.path);
    const merged: StateFile = { credentials: { ...(disk.credentials ?? {}) } };
    const ours = this.state.credentials?.[this.provider] ?? {};
    if (merged.credentials) merged.credentials[this.provider] = ours;
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function hashSecret(secret: string): string {
  let h = 2166136261;
  for (let i = 0; i < secret.length; i++) {
    h ^= secret.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
