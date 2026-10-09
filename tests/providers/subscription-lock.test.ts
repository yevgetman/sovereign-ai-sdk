import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const fixture = resolve('tests/fixtures/subscription-lock-process.ts');
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sov-auth-lock-test-'));
  await writeFile(
    join(root, 'record.json'),
    JSON.stringify({ accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1 }),
  );
  return root;
}
function start(root: string, mode: string) {
  return Bun.spawn([process.execPath, fixture, root, mode], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH, HOME: root, HARNESS_HOME: join(root, `profile-${mode}`) },
  });
}
async function entered(root: string) {
  for (let i = 0; i < 300; i++) {
    try {
      await readFile(join(root, 'entered'));
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error('child did not acquire lock');
}
describe('subscription OS-process mutex', () => {
  test('a reused PID with another process start cannot keep a stale ticket alive', async () => {
    const root = await setup();
    try {
      const digest = createHash('sha256').update('fake-account:SOV_SUB_CHATGPT').digest('hex');
      const dir = join(root, 'locks', digest);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${process.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json`),
        JSON.stringify({
          pid: process.pid,
          start: 'old-process-generation',
          choosing: true,
          ticket: 0,
        }),
      );
      expect(await start(root, 'refresh').exited).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  for (const mode of ['refresh', '401']) {
    test(`overlapping ${mode} processes exchange one generation only`, async () => {
      const root = await setup();
      try {
        const a = start(root, mode);
        const b = start(root, mode);
        expect(await a.exited).toBe(0);
        expect(await b.exited).toBe(0);
        expect(await readFile(join(root, 'exchanges'), 'utf8')).toBe('refresh\n');
        expect(JSON.parse(await readFile(join(root, 'record.json'), 'utf8')).accessToken).toBe(
          'new',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
  test('logout waits for pending refresh then deletes; later calls cannot restore it', async () => {
    const root = await setup();
    try {
      const refresh = start(root, 'refresh');
      await entered(root);
      const logout = start(root, 'logout');
      expect(await refresh.exited).toBe(0);
      expect(await logout.exited).toBe(0);
      expect(await start(root, 'refresh').exited).toBe(1);
      expect(await Bun.file(join(root, 'record.json')).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('a killed owner cannot block later refresh', async () => {
    const root = await setup();
    try {
      const holder = start(root, 'hold');
      await entered(root);
      holder.kill('SIGKILL');
      await holder.exited;
      const contenders = [start(root, 'refresh'), start(root, 'refresh'), start(root, 'refresh')];
      expect(await Promise.all(contenders.map((child) => child.exited))).toEqual([0, 0, 0]);
      expect(await readFile(join(root, 'exchanges'), 'utf8')).toBe('refresh\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('a waiting cancellation leaves a living owner and later callers intact', async () => {
    const root = await setup();
    const holder = start(root, 'hold');
    try {
      await entered(root);
      const wait = start(root, 'cancel');
      expect(await wait.exited).toBe(1);
      expect(await new Response(wait.stdout).text()).toContain('AbortError');
      holder.kill('SIGKILL');
      await holder.exited;
      expect(await start(root, 'refresh').exited).toBe(0);
    } finally {
      holder.kill();
      await rm(root, { recursive: true, force: true });
    }
  });
  test('cancelled refresh cannot write a late result after logout', async () => {
    const root = await setup();
    try {
      expect(await start(root, 'cancel').exited).toBe(1);
      expect(await start(root, 'logout').exited).toBe(0);
      await Bun.sleep(250);
      expect(await Bun.file(join(root, 'record.json')).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
