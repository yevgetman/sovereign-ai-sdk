import { expect, test } from 'bun:test';

type Stored = { status: string; finishReason: string | null; reply: string };
type Report = {
  exit: number;
  stops: number;
  foundController: boolean;
  aborted: boolean;
  reason: string | null;
  terminal: Record<string, unknown> | null;
  stored: Stored | null;
};

async function run(mode: 'completed' | 'checkin' | 'completed-user' | 'failed'): Promise<Report> {
  const child = Bun.spawn([process.execPath, 'tests/fixtures/sdk-run-committed-abort.ts', mode], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, errors).toBe(0);
  const line = output.trim().split('\n').at(-1);
  if (!line) throw new Error(`no fixture output\n${errors}`);
  return JSON.parse(line) as Report;
}

test('Stop hook deadline abort after completion keeps turn.completed and the reply', async () => {
  const result = await run('completed');
  expect(result.stops).toBe(1);
  expect(result.foundController).toBe(true);
  expect(result.aborted).toBe(true);
  expect(result.reason).toBe('deadline');
  expect(result.exit).toBe(0);
  expect(result.terminal).toMatchObject({
    type: 'turn.completed',
    outcome: 'completed',
    reply: 'kept answer',
  });
  expect(result.terminal?.type).not.toBe('turn.error');
  expect(result.stored).toMatchObject({ status: 'completed', reply: 'kept answer' });
});

test('Stop hook user abort after completion keeps turn.completed and the reply', async () => {
  const result = await run('completed-user');
  expect(result.stops).toBe(1);
  expect(result.foundController).toBe(true);
  expect(result.aborted).toBe(true);
  expect(result.reason).not.toBe('deadline');
  expect(result.exit).toBe(0);
  expect(result.terminal).toMatchObject({
    type: 'turn.completed',
    outcome: 'completed',
    reply: 'kept answer',
  });
  expect(result.terminal?.code).not.toBe('interrupted');
  expect(result.stored).toMatchObject({ status: 'completed', reply: 'kept answer' });
});

test('Stop hook deadline abort after check-in stays waiting_user', async () => {
  const result = await run('checkin');
  expect(result.stops).toBe(1);
  expect(result.foundController).toBe(true);
  expect(result.aborted).toBe(true);
  expect(result.reason).toBe('deadline');
  expect(result.exit).toBe(0);
  expect(result.terminal).toMatchObject({
    type: 'turn.completed',
    outcome: 'waiting_user',
    reason: 'checkin',
    nextAction: 'user_input',
  });
  expect(result.terminal?.type).not.toBe('turn.error');
  expect(result.stored).toMatchObject({ status: 'waiting_user', finishReason: 'checkin' });
});

test('Stop hook deadline abort after a provider failure keeps that failure', async () => {
  const result = await run('failed');
  expect(result.stops).toBe(1);
  expect(result.foundController).toBe(true);
  expect(result.aborted).toBe(true);
  expect(result.reason).toBe('deadline');
  expect(result.terminal?.code).not.toBe('continuation_exhausted');
  expect(result.terminal?.code).not.toBe('interrupted');
  expect(result.terminal).toMatchObject({
    type: 'turn.error',
    code: 'provider_failed',
  });
  expect(result.stored).toMatchObject({ status: 'failed' });
});
