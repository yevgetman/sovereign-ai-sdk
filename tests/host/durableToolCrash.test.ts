import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.each([
  'before-execution',
  'during-execution',
  'after-effect-before-receipt',
  'after-receipt',
  'before-model',
])('tool receipts survive process loss at %s', async (stage) => {
  const dir = mkdtempSync(join(tmpdir(), 'sov-receipt-crash-'));
  const script = join(import.meta.dir, 'fixtures/durable-tool-crash.ts');
  const args = [stage, join(dir, 'sessions.db'), join(dir, 'effects.txt')];
  const env = { ...process.env, HARNESS_HOME: dir };
  try {
    const crash = Bun.spawn([process.execPath, script, 'crash', ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const crashError = await new Response(crash.stderr).text();
    expect(await crash.exited).toBe(71);
    expect(crashError).toBe('');
    const resume = Bun.spawn([process.execPath, script, 'resume', ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(resume.stdout).text();
    const error = await new Response(resume.stderr).text();
    expect(error).toBe('');
    expect(await resume.exited).toBe(0);
    expect(output).toContain('DURABLE_RESUME_OK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
