// Lock in the fail-closed defaults of buildTool(). If someone forgets to
// set isConcurrencySafe or isReadOnly, the default must be false. Do not
// let this test flip without a deliberate decision.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { buildTool } from '../../src/tool/buildTool.js';

describe('buildTool — fail-closed defaults', () => {
  const minimalDef = {
    name: 'test',
    description: () => 'a test tool',
    inputSchema: z.object({}),
    call: async () => ({ data: undefined }),
  };

  test('isReadOnly defaults to false', () => {
    const tool = buildTool(minimalDef);
    expect(tool.isReadOnly({})).toBe(false);
  });

  test('isConcurrencySafe defaults to false', () => {
    const tool = buildTool(minimalDef);
    expect(tool.isConcurrencySafe({})).toBe(false);
  });

  test('isDestructive defaults to false', () => {
    const tool = buildTool(minimalDef);
    expect(tool.isDestructive({})).toBe(false);
  });

  test('isEnabled defaults to true', () => {
    const tool = buildTool(minimalDef);
    expect(tool.isEnabled()).toBe(true);
  });

  test('checkPermissions defaults to allow', async () => {
    const tool = buildTool(minimalDef);
    const result = await tool.checkPermissions(
      {},
      {
        cwd: '',
        bundleRoot: '',
        sessionId: '',
      },
    );
    expect(result.behavior).toBe('allow');
  });

  test('interruptBehavior defaults to cancel', () => {
    const tool = buildTool(minimalDef);
    expect(tool.interruptBehavior()).toBe('cancel');
  });

  test('shouldDefer defaults to false', () => {
    const tool = buildTool(minimalDef);
    expect(tool.shouldDefer).toBe(false);
  });

  test('user overrides replace defaults', () => {
    const tool = buildTool({
      ...minimalDef,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      shouldDefer: true,
    });
    expect(tool.isReadOnly({})).toBe(true);
    expect(tool.isConcurrencySafe({})).toBe(true);
    expect(tool.shouldDefer).toBe(true);
  });
});
