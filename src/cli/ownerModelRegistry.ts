/** SOV disk port for exact owner-reviewed Grok subscription records. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveHarnessHome } from '@yevgetman/sov-sdk/config/paths';
import {
  presentOwnerGrokRegistry,
  validateOwnerGrokRegistry,
} from '@yevgetman/sov-sdk/providers/models/ownerRegistry';
import type { ModelCatalog } from '@yevgetman/sov-sdk/providers/models/types';
import { validateModelCatalog } from '@yevgetman/sov-sdk/providers/models/validate';
import { macKeychainPort } from '@yevgetman/sov-sdk/providers/subscription/keychain';
import { withCredentialLock } from '@yevgetman/sov-sdk/providers/subscription/lock';
import {
  rotateSubscriptionLoginEpoch,
  subscriptionLoginEpoch,
} from '@yevgetman/sov-sdk/providers/subscription/loginEpoch';
import { KEYCHAIN_SERVICE } from '@yevgetman/sov-sdk/providers/subscription/names';
import type { SubscriptionCredentialPort } from '@yevgetman/sov-sdk/providers/subscription/port';

const FILE_LIMIT = 16 * 1024 * 1024;
function registryFile(home: string, port: SubscriptionCredentialPort, epoch: string): string {
  const account = createHash('sha256')
    .update(`${port.lockIdentity ?? ''}:${epoch}`)
    .digest('hex');
  return join(home, 'model-catalog', 'subscription', 'grok-subscription', `owner-${account}.json`);
}

/** Explicit write; requires current login, never refreshes or sends inference. */
export async function importOwnerGrokRegistry(
  value: unknown,
  options: {
    harnessHome?: string;
    port?: SubscriptionCredentialPort;
    now?: number;
  } = {},
): Promise<ModelCatalog> {
  const catalog = validateOwnerGrokRegistry(value, options.now ?? Date.now());
  const serialized = JSON.stringify(catalog);
  if (Buffer.byteLength(serialized, 'utf8') > FILE_LIMIT)
    throw new Error('Invalid Grok owner model registry. No changes were saved.');
  const port = options.port ?? macKeychainPort({ timeoutMs: 4_000 });
  const home = options.harnessHome ?? resolveHarnessHome();
  await withCredentialLock(KEYCHAIN_SERVICE.grok, port, async () => {
    if (!(await port.read(KEYCHAIN_SERVICE.grok)))
      throw new Error('Grok owner registry requires a subscription login.');
    const epoch =
      subscriptionLoginEpoch(port, KEYCHAIN_SERVICE.grok) ??
      (await rotateSubscriptionLoginEpoch(port, KEYCHAIN_SERVICE.grok));
    const file = registryFile(home, port, epoch);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, serialized, { mode: 0o600 });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  });
  return catalog;
}

/** Offline and read-only: login epoch is non-secret; missing epoch fails closed. */
export function readOwnerGrokRegistry(
  home = resolveHarnessHome(),
  port = macKeychainPort(),
  now = Date.now(),
): ModelCatalog | undefined {
  const epoch = subscriptionLoginEpoch(port, KEYCHAIN_SERVICE.grok);
  if (!epoch) return undefined;
  const file = registryFile(home, port, epoch);
  try {
    if (statSync(file).size > FILE_LIMIT) return undefined;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const validated = validateModelCatalog(raw, 'grok-subscription', now);
    if (!validated || validated.models.some((model) => model.metadata.ownerManaged !== true))
      return undefined;
    return presentOwnerGrokRegistry(validated, now);
  } catch {
    return undefined;
  }
}

export function readOwnerGrokRegistryFile(file: string): unknown {
  if (!statSync(file).isFile() || statSync(file).size > FILE_LIMIT)
    throw new Error('Invalid owner registry file.');
  return JSON.parse(readFileSync(file, 'utf8'));
}
