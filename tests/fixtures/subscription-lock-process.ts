// Isolated OS-process fixture: only fake records under an explicit temp path.
import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withCredentialLock } from '@yevgetman/sov-sdk/providers/subscription/lock';
import { logoutSubscription } from '@yevgetman/sov-sdk/providers/subscription/login';
import type {
  SubscriptionCredentialPort,
  SubscriptionRecord,
} from '@yevgetman/sov-sdk/providers/subscription/port';
import {
  exchangeUnderLock,
  loadFreshRecord,
} from '@yevgetman/sov-sdk/providers/subscription/tokens';
const [root, mode] = process.argv.slice(2) as [string, string];
const file = join(root, 'record.json');
const service = 'SOV_SUB_CHATGPT';
const port: SubscriptionCredentialPort = {
  lockDirectory: join(root, 'locks'),
  lockIdentity: 'fake-account',
  async read() {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  async write(_service, record) {
    const temp = `${file}.${process.pid}`;
    await writeFile(temp, JSON.stringify(record));
    await rename(temp, file);
  },
  async delete() {
    await rm(file, { force: true });
  },
};
const exchange = async () => {
  await writeFile(join(root, 'entered'), 'ready');
  await new Promise((resolve) => setTimeout(resolve, 180));
  await appendFile(join(root, 'exchanges'), 'refresh\n');
  return { accessToken: 'new', refreshToken: 'rotated', expiresAt: Date.now() + 3_600_000 };
};
try {
  if (mode === 'hold') {
    await withCredentialLock(service, port, async () => {
      await writeFile(join(root, 'entered'), 'ready');
      await new Promise(() => {});
    });
  } else if (mode === 'logout') {
    process.exitCode = await logoutSubscription('chatgpt', port, {
      stdout() {},
      stderr() {},
      openUrl() {},
      sleep: async () => {},
      now: Date.now,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
  } else {
    const controller = new AbortController();
    if (mode === 'cancel') setTimeout(() => controller.abort(), 80);
    const rejected: SubscriptionRecord = {
      accessToken: 'old',
      refreshToken: 'old-refresh',
      expiresAt: 1,
    };
    if (mode === '401') await exchangeUnderLock('chatgpt', service, port, exchange, rejected);
    else
      await loadFreshRecord('chatgpt', service, port, Date.now, exchange, {
        signal: controller.signal,
      });
  }
} catch (err) {
  process.stdout.write(`${(err as Error).name}\n`);
  process.exitCode = 1;
}
