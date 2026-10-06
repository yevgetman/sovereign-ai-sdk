import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { SubscriptionAuthExpiredError } from '../errors.js';
import type { SubscriptionCredentialPort, SubscriptionRecord } from './port.js';

const execFileAsync = promisify(execFile);

type ExecResult = { stdout: string; code: number };

export type KeychainExec = (args: string[]) => Promise<ExecResult>;

async function securityExec(args: string[]): Promise<ExecResult> {
  try {
    const { stdout } = await execFileAsync('security', args, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: String(stdout), code: 0 };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string };
    return {
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
      code: typeof failed.code === 'number' ? failed.code : 1,
    };
  }
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
    throw new SubscriptionAuthExpiredError(
      service,
      `subscription login for ${service} is unreadable`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SubscriptionAuthExpiredError(
      service,
      `subscription login for ${service} is unreadable`,
    );
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.accessToken !== 'string' || typeof row.refreshToken !== 'string') {
    throw new SubscriptionAuthExpiredError(
      service,
      `subscription login for ${service} is unreadable`,
    );
  }
  if (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)) {
    throw new SubscriptionAuthExpiredError(
      service,
      `subscription login for ${service} is unreadable`,
    );
  }
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
  };
}

/** macOS Keychain adapter. `exec` is injectable so tests never call `security`. */
export function macKeychainPort(opts?: {
  exec?: KeychainExec;
  account?: string;
}): SubscriptionCredentialPort {
  const exec = opts?.exec ?? securityExec;
  const account = opts?.account ?? accountName();

  return {
    async read(service) {
      const result = await exec(['find-generic-password', '-s', service, '-a', account, '-w']);
      if (result.code !== 0) return null;
      const raw = result.stdout.trim();
      if (raw.length === 0) return null;
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
        throw new Error(`keychain write failed for ${service}`);
      }
    },

    async delete(service) {
      const result = await exec(['delete-generic-password', '-s', service, '-a', account]);
      if (result.code !== 0 && result.code !== 44) {
        throw new Error(`keychain delete failed for ${service}`);
      }
    },
  };
}
