import { execFile } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CredentialStoreUnavailableError, SubscriptionRecordUnreadableError } from '../errors.js';
import type { SubscriptionCredentialPort, SubscriptionRecord } from './port.js';

const execFileAsync = promisify(execFile);

type ExecResult = { stdout: string; code: number };

export type KeychainExec = (args: string[]) => Promise<ExecResult>;

/** `security` exit status for "The specified item could not be found". */
const ITEM_NOT_FOUND = 44;
/** Reported when `security` was killed (timeout) or could not start. */
const EXEC_FAILED = -1;
const DEFAULT_TIMEOUT_MS = 10_000;

function securityExec(timeoutMs: number): KeychainExec {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync('security', args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return { stdout: String(stdout), code: 0 };
    } catch (err) {
      const failed = err as { code?: unknown; stdout?: string };
      return {
        stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
        code: typeof failed.code === 'number' ? failed.code : EXEC_FAILED,
      };
    }
  };
}

function accountName(): string {
  const fromEnv = process.env.USER || process.env.LOGNAME;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return userInfo().username;
}

function parseRecord(raw: string, service: string): SubscriptionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SubscriptionRecordUnreadableError(service);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SubscriptionRecordUnreadableError(service);
  }
  const row = parsed as Record<string, unknown>;
  if (
    typeof row.accessToken !== 'string' ||
    row.accessToken.length === 0 ||
    typeof row.refreshToken !== 'string'
  ) {
    throw new SubscriptionRecordUnreadableError(service);
  }
  if (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)) {
    throw new SubscriptionRecordUnreadableError(service);
  }
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
  };
}

/**
 * macOS Keychain adapter. `exec` is injectable so tests never call `security`.
 * A missing item reads as `null`; any other failure (locked Keychain, timeout,
 * `security` unavailable) throws `CredentialStoreUnavailableError` so callers
 * never mistake a platform failure for "not logged in".
 */
export function macKeychainPort(opts?: {
  exec?: KeychainExec;
  account?: string;
  /** Bound on each `security` call. Default 10 s. */
  timeoutMs?: number;
  lockDirectory?: string;
}): SubscriptionCredentialPort {
  const exec = opts?.exec ?? securityExec(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const account = opts?.account ?? accountName();

  return {
    lockDirectory: opts?.lockDirectory ?? join(homedir(), '.sov', 'auth-locks'),
    lockIdentity: account,
    async read(service) {
      const result = await exec(['find-generic-password', '-s', service, '-a', account, '-w']);
      if (result.code === ITEM_NOT_FOUND) return null;
      if (result.code !== 0) {
        throw new CredentialStoreUnavailableError(service, 'read_failed');
      }
      const raw = result.stdout.trim();
      if (raw.length === 0) throw new SubscriptionRecordUnreadableError(service);
      return parseRecord(raw, service);
    },

    async write(service, record) {
      const result = await exec([
        'add-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
        JSON.stringify(record),
        '-U',
      ]);
      if (result.code !== 0) {
        throw new CredentialStoreUnavailableError(
          service,
          'write_failed',
          `keychain write failed for ${service}`,
        );
      }
    },

    async delete(service) {
      const result = await exec(['delete-generic-password', '-s', service, '-a', account]);
      if (result.code !== 0 && result.code !== ITEM_NOT_FOUND) {
        throw new CredentialStoreUnavailableError(
          service,
          'delete_failed',
          `keychain delete failed for ${service}`,
        );
      }
    },
  };
}
