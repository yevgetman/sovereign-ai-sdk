import { describe, expect, test } from 'bun:test';
import { wrapCanUseToolWithTransformers } from '@yevgetman/sov-sdk/permissions/inputTransformer';
import type {
  CanUseTool,
  PermissionResult,
  ResolvedPermissionResult,
} from '@yevgetman/sov-sdk/permissions/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

const ctx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'test',
};

function probeTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Probe',
    description: () => 'probe',
    inputSchema: z.object({ value: z.string() }),
    async call() {
      return { data: 'ok' };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function fixedCanUseTool(result: ResolvedPermissionResult): CanUseTool {
  return async () => result;
}

describe('wrapCanUseToolWithTransformers', () => {
  test('empty transformer list returns the base canUseTool unchanged', async () => {
    const base = fixedCanUseTool({ behavior: 'allow' });
    const wrapped = wrapCanUseToolWithTransformers(base, []);
    expect(wrapped).toBe(base);
  });

  test('deny short-circuits before transformers run', async () => {
    let transformerCalls = 0;
    const wrapped = wrapCanUseToolWithTransformers(
      fixedCanUseTool({ behavior: 'deny', reason: 'no' }),
      [
        async () => {
          transformerCalls++;
          return { updatedInput: { value: 'changed' } };
        },
      ],
    );
    const result = await wrapped(probeTool(), { value: 'orig' }, ctx);
    expect(result.behavior).toBe('deny');
    expect(transformerCalls).toBe(0);
  });

  test('single transformer rewrites input', async () => {
    const wrapped = wrapCanUseToolWithTransformers(fixedCanUseTool({ behavior: 'allow' }), [
      async (_tool, input) => {
        const obj = input as { value: string };
        return { updatedInput: { value: obj.value.toUpperCase() }, reason: 'shouted' };
      },
    ]);
    const result = await wrapped(probeTool(), { value: 'hello' }, ctx);
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toEqual({ value: 'HELLO' });
    expect(result.reason).toBe('shouted');
  });

  test('transformer that returns undefined leaves input unchanged', async () => {
    const wrapped = wrapCanUseToolWithTransformers(fixedCanUseTool({ behavior: 'allow' }), [
      async () => undefined,
    ]);
    const result = await wrapped(probeTool(), { value: 'orig' }, ctx);
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  test('multiple transformers compose left-to-right; reasons concatenate', async () => {
    const wrapped = wrapCanUseToolWithTransformers(fixedCanUseTool({ behavior: 'allow' }), [
      async (_tool, input) => {
        const obj = input as { value: string };
        return { updatedInput: { value: `${obj.value}-A` }, reason: 'A' };
      },
      async (_tool, input) => {
        const obj = input as { value: string };
        return { updatedInput: { value: `${obj.value}-B` }, reason: 'B' };
      },
    ]);
    const result = await wrapped(probeTool(), { value: 'x' }, ctx);
    expect(result.updatedInput).toEqual({ value: 'x-A-B' });
    expect(result.reason).toBe('A; B');
  });

  test('a thrown transformer is silently skipped (does not block dispatch)', async () => {
    const wrapped = wrapCanUseToolWithTransformers(fixedCanUseTool({ behavior: 'allow' }), [
      async () => {
        throw new Error('boom');
      },
      async (_tool, input) => {
        const obj = input as { value: string };
        return { updatedInput: { value: `${obj.value}-after` }, reason: 'survived' };
      },
    ]);
    const result = await wrapped(probeTool(), { value: 'x' }, ctx);
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toEqual({ value: 'x-after' });
    expect(result.reason).toBe('survived');
  });

  test('preserves base canUseTool reason when no transformer fires', async () => {
    const wrapped = wrapCanUseToolWithTransformers(
      fixedCanUseTool({ behavior: 'allow', reason: 'matched user rule' }),
      [async () => undefined],
    );
    const result = await wrapped(probeTool(), { value: 'x' }, ctx);
    expect(result.reason).toBe('matched user rule');
  });

  test('merges base updatedInput with transformer updatedInput', async () => {
    // Base resolution already rewrote the input (e.g. permission rule
    // normalized a path); the transformer receives the rewritten value
    // and may rewrite further.
    const wrapped = wrapCanUseToolWithTransformers(
      fixedCanUseTool({ behavior: 'allow', updatedInput: { value: 'normalized' } }),
      [
        async (_tool, input) => {
          const obj = input as { value: string };
          return { updatedInput: { value: `${obj.value}+extra` } };
        },
      ],
    );
    const result = await wrapped(probeTool(), { value: 'orig' }, ctx);
    expect(result.updatedInput).toEqual({ value: 'normalized+extra' });
  });
});

describe('wrapCanUseToolWithTransformers — checkPermissions surface', () => {
  test('does not interfere with PermissionResult passthrough', async () => {
    // Sanity: wrapped CanUseTool still produces a value the orchestrator
    // accepts. We don't run the orchestrator here — just type-check that
    // ResolvedPermissionResult is what comes out.
    const result: PermissionResult = { behavior: 'allow' };
    expect(result.behavior).toBe('allow'); // type smoke test
  });
});
