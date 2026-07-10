import { describe, expect, test } from 'bun:test';
import type { ConductContext, ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import { composeConductCanUseTool } from '@yevgetman/sov-sdk/core/conductToolPolicy';
import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';

const ctx: ConductContext = {
  sessionId: 's1',
  surface: 'user',
  model: 'm',
  providerName: 'p',
};
const fakeTool = { name: 'Bash' } as unknown as Tool<unknown, unknown>;
const toolCtx = { cwd: '/tmp', sessionId: 's1' } as unknown as ToolContext;

describe('composeConductCanUseTool', () => {
  test('no toolPolicy capability: returns the inner decider UNCHANGED (same reference)', () => {
    const inner: CanUseTool = async () => ({ behavior: 'allow' });
    expect(composeConductCanUseTool({}, ctx, inner)).toBe(inner);
    expect(composeConductCanUseTool(undefined, ctx, inner)).toBe(inner);
    expect(composeConductCanUseTool({}, ctx, undefined)).toBeUndefined();
  });

  test('conduct deny wins; inner never consulted', async () => {
    let innerCalled = false;
    const inner: CanUseTool = async () => {
      innerCalled = true;
      return { behavior: 'allow' };
    };
    const conduct: ConductProvider = {
      toolPolicy: (toolName) =>
        toolName === 'Bash'
          ? { behavior: 'deny', reason: 'conduct: shell blocked' }
          : { behavior: 'allow' },
    };
    const composed = composeConductCanUseTool(conduct, ctx, inner);
    const verdict = await composed?.(fakeTool, { cmd: 'ls' }, toolCtx);
    expect(verdict).toEqual({ behavior: 'deny', reason: 'conduct: shell blocked' });
    expect(innerCalled).toBe(false);
  });

  test('conduct allow defers to the inner decider', async () => {
    const inner: CanUseTool = async () => ({ behavior: 'deny', reason: 'inner said no' });
    const conduct: ConductProvider = { toolPolicy: () => ({ behavior: 'allow' }) };
    const composed = composeConductCanUseTool(conduct, ctx, inner);
    const verdict = await composed?.(fakeTool, {}, toolCtx);
    expect(verdict).toEqual({ behavior: 'deny', reason: 'inner said no' });
  });

  test('no inner decider + non-deny → allow (ungated default preserved)', async () => {
    const conduct: ConductProvider = { toolPolicy: () => ({ behavior: 'allow' }) };
    const composed = composeConductCanUseTool(conduct, ctx, undefined);
    const verdict = await composed?.(fakeTool, {}, toolCtx);
    expect(verdict).toEqual({ behavior: 'allow' });
  });

  test('toolPolicy throw fails open (defers to inner)', async () => {
    const inner: CanUseTool = async () => ({ behavior: 'allow' });
    const conduct: ConductProvider = {
      toolPolicy: () => {
        throw new Error('policy exploded');
      },
    };
    const composed = composeConductCanUseTool(conduct, ctx, inner);
    const verdict = await composed?.(fakeTool, {}, toolCtx);
    expect(verdict).toEqual({ behavior: 'allow' });
  });
});
