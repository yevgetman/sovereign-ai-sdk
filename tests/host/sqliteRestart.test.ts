import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No owner profile is opened: every process receives an explicit temporary DB
// and home. Killing only the spawned fixture models process loss at dispatch.
test('isolated SQLite host recovers a durable interrupted tool boundary after process restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sov-host-restart-'));
  const script = join(import.meta.dir, 'fixtures/sqlite-restart.ts');
  const path = join(dir, 'sessions.db');
  const env = { ...process.env, HARNESS_HOME: dir, HOME: dir };
  const child = Bun.spawn([process.execPath, script, 'crash', path], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([
      child.stdout.getReader().read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('fixture failed to reach durable boundary')),
          5000,
        );
      }),
    ]);
    expect(new TextDecoder().decode(ready.value)).toContain('READY');
    child.kill('SIGKILL');
    await child.exited;
    const resumed = Bun.spawn([process.execPath, script, 'resume', path], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(resumed.stdout).text();
    const error = await new Response(resumed.stderr).text();
    expect(await resumed.exited).toBe(0);
    expect(error).toBe('');
    expect(output).toContain('RESTART_OK');
  } finally {
    if (timeout) clearTimeout(timeout);
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
