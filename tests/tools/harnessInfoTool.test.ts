// HarnessInfoTool — runtime introspection. Tests verify section filtering,
// the rendered text covers each section, and the snapshot getter is invoked
// fresh on every call (so live MCP / tool-pool state stays current).

import { describe, expect, test } from 'bun:test';
import { type HarnessInfoSnapshot, buildHarnessInfoTool } from '../../src/tools/HarnessInfoTool.js';

const ctx = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'test',
};

function fixtureSnapshot(overrides: Partial<HarnessInfoSnapshot> = {}): HarnessInfoSnapshot {
  return {
    permissionMode: 'default',
    settingsLayers: [
      { name: 'local', path: '/tmp/x/.harness/settings.local.json', present: false },
      { name: 'project', path: '/tmp/x/.harness/settings.json', present: true },
      { name: 'user', path: '/home/x/.harness/settings.json', present: false },
    ],
    mcpServers: [
      {
        name: 'echo',
        command: 'bun',
        args: ['/path/to/echo-server.ts'],
        status: 'connected',
        toolCount: 1,
        tools: ['echo'],
      },
    ],
    tools: {
      native: ['Bash', 'FileRead', 'HarnessInfo', 'ToolSearch'],
      mcp: ['mcp__echo__echo'],
    },
    slashCommands: [
      { name: 'help', description: 'List available slash commands.' },
      { name: 'config', description: 'View or change durable user-level config.' },
    ],
    ...overrides,
  };
}

describe('HarnessInfoTool', () => {
  test('section: all returns the full snapshot', async () => {
    const snap = fixtureSnapshot();
    const tool = buildHarnessInfoTool(() => snap);
    const result = await tool.call({ section: 'all' }, ctx);
    expect(result.data.permissionMode).toBe('default');
    expect(result.data.settingsLayers?.length).toBe(3);
    expect(result.data.mcpServers?.length).toBe(1);
    expect(result.data.tools?.native).toContain('Bash');
    expect(result.data.slashCommands?.length).toBe(2);
  });

  test('default section is all', async () => {
    const tool = buildHarnessInfoTool(() => fixtureSnapshot());
    const result = await tool.call({}, ctx);
    expect(result.data.permissionMode).toBeDefined();
    expect(result.data.mcpServers).toBeDefined();
    expect(result.data.tools).toBeDefined();
    expect(result.data.slashCommands).toBeDefined();
  });

  test('section: settings excludes mcp / tools / commands', async () => {
    const tool = buildHarnessInfoTool(() => fixtureSnapshot());
    const result = await tool.call({ section: 'settings' }, ctx);
    expect(result.data.permissionMode).toBe('default');
    expect(result.data.settingsLayers).toBeDefined();
    expect(result.data.mcpServers).toBeUndefined();
    expect(result.data.tools).toBeUndefined();
    expect(result.data.slashCommands).toBeUndefined();
  });

  test('section: mcp returns only mcpServers', async () => {
    const tool = buildHarnessInfoTool(() => fixtureSnapshot());
    const result = await tool.call({ section: 'mcp' }, ctx);
    expect(result.data.mcpServers?.[0]?.name).toBe('echo');
    expect(result.data.permissionMode).toBeUndefined();
    expect(result.data.tools).toBeUndefined();
  });

  test('section: tools returns native + mcp tool lists', async () => {
    const tool = buildHarnessInfoTool(() => fixtureSnapshot());
    const result = await tool.call({ section: 'tools' }, ctx);
    expect(result.data.tools?.native).toContain('Bash');
    expect(result.data.tools?.mcp).toContain('mcp__echo__echo');
  });

  test('section: commands returns only slashCommands', async () => {
    const tool = buildHarnessInfoTool(() => fixtureSnapshot());
    const result = await tool.call({ section: 'commands' }, ctx);
    expect(result.data.slashCommands?.length).toBe(2);
    expect(result.data.permissionMode).toBeUndefined();
  });

  test('snapshot getter is invoked fresh on every call', async () => {
    let count = 0;
    const tool = buildHarnessInfoTool(() => {
      count++;
      return fixtureSnapshot();
    });
    await tool.call({ section: 'all' }, ctx);
    await tool.call({ section: 'mcp' }, ctx);
    await tool.call({ section: 'tools' }, ctx);
    expect(count).toBe(3);
  });

  test('renderResult formats the snapshot for the model', () => {
    const tool = buildHarnessInfoTool(() => fixtureSnapshot());
    const rendered = tool.renderResult?.(fixtureSnapshot());
    expect(rendered?.content).toContain('permissionMode: default');
    expect(rendered?.content).toContain('settings layers');
    expect(rendered?.content).toContain('mcp servers: 1');
    expect(rendered?.content).toContain('echo: connected');
    expect(rendered?.content).toContain('native tools (4)');
    expect(rendered?.content).toContain('slash commands (2)');
    expect(rendered?.content).toContain('/help');
  });

  test('mcp server with status: failed surfaces in the rendered output', () => {
    const tool = buildHarnessInfoTool(() =>
      fixtureSnapshot({
        mcpServers: [
          {
            name: 'broken',
            command: 'nope',
            args: [],
            status: 'failed',
            toolCount: 0,
            tools: [],
          },
        ],
      }),
    );
    const rendered = tool.renderResult?.(
      fixtureSnapshot({
        mcpServers: [
          {
            name: 'broken',
            command: 'nope',
            args: [],
            status: 'failed',
            toolCount: 0,
            tools: [],
          },
        ],
      }),
    );
    expect(rendered?.content).toContain('broken: failed');
    expect(rendered?.content).toContain('command: nope');
    void tool;
  });

  test('tool is read-only and concurrency-safe; permissions allow', async () => {
    const tool = buildHarnessInfoTool(() => fixtureSnapshot());
    expect(tool.isReadOnly({ section: 'all' })).toBe(true);
    expect(tool.isConcurrencySafe({ section: 'all' })).toBe(true);
    const perm = await tool.checkPermissions({ section: 'all' }, ctx);
    expect(perm.behavior).toBe('allow');
  });
});
