// Non-secret account session scope. Token refresh does not rotate this epoch.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubscriptionCredentialPort } from './port.js';

const memory = new WeakMap<SubscriptionCredentialPort, Map<string, string>>();
function epochPath(port: SubscriptionCredentialPort, service: string): string | undefined {
  if (!port.lockDirectory) return undefined;
  const digest = createHash('sha256')
    .update(`${port.lockIdentity ?? ''}:${service}`)
    .digest('hex');
  return join(port.lockDirectory, `${digest}.login-epoch`);
}
/** Offline snapshots read only this non-secret file, never a Keychain item. */
export function subscriptionLoginEpoch(
  port: SubscriptionCredentialPort,
  service: string,
): string | undefined {
  const path = epochPath(port, service);
  if (!path) return memory.get(port)?.get(service);
  try {
    const epoch = readFileSync(path, 'utf8');
    return /^[a-f0-9-]{36}$/.test(epoch) ? epoch : undefined;
  } catch {
    return undefined;
  }
}
/** Caller holds the credential mutex. Successful login and logout always rotate. */
export async function rotateSubscriptionLoginEpoch(
  port: SubscriptionCredentialPort,
  service: string,
): Promise<string> {
  const epoch = randomUUID();
  const path = epochPath(port, service);
  if (!path) {
    const values = memory.get(port) ?? new Map<string, string>();
    values.set(service, epoch);
    memory.set(port, values);
    return epoch;
  }
  await mkdir(port.lockDirectory as string, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, epoch, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  return epoch;
}
