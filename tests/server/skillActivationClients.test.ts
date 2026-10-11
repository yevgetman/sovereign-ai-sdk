import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { DriveSseManager, EventRenderer, runSlashCommand } from '../../src/cli/driveCommand.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { startServer } from '../../src/server/index.js';
import { buildRuntime } from '../../src/server/runtime.js';

let home: string;
function observedToolNames(): string[] {
  return MockProvider.lastTools?.map((tool) => tool.name) ?? [];
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-clients-'));
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  MockProvider.lastTools = undefined;
  mkdirSync(join(home, '.harness/skills'), { recursive: true });
  writeFileSync(
    join(home, '.harness/skills/readonly.md'),
    '---\nname: readonly\ndescription: Read only\nallowedTools: [Read]\n---\nRead {{args}}',
  );
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env requires delete.
  delete process.env.SOV_TEST_MOCK_PROVIDER;
  MockProvider.lastTools = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('one skill activation path across clients', () => {
  test('plain POST recognizes a known skill across whitespace and scopes actual effects', async () => {
    writeFileSync(
      join(home, '.harness/skills/dynamic.md'),
      '---\nname: dynamic\ndescription: Dynamic context\nallowedTools: [Bash]\n---\n!`touch marker`',
    );
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash'] } }));
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      permissionMode: 'bypass',
    });
    try {
      const app = buildAppWithRuntime(runtime);
      for (const text of ['/readonly\twith-tab', '/readonly\nwith-newline']) {
        const { sessionId } = (await (
          await app.request('/sessions', { method: 'POST' })
        ).json()) as {
          sessionId: string;
        };
        const post = await app.request(`/sessions/${sessionId}/turns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        expect(post.status).toBe(202);
        const events = await (await app.request(`/sessions/${sessionId}/events`)).text();
        expect(events).toContain('turn_complete');
        expect(MockProvider.lastTools?.map((tool) => tool.name)).toEqual(['FileRead']);
        expect(JSON.stringify(runtime.sessionDb.loadMessages(sessionId)[0]?.content)).toContain(
          text.includes('tab') ? 'Read with-tab' : 'Read with-newline',
        );
      }
      MockProvider.lastTools = undefined;
      const { sessionId } = (await (await app.request('/sessions', { method: 'POST' })).json()) as {
        sessionId: string;
      };
      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/dynamic\tignored' }),
      });
      const events = await (await app.request(`/sessions/${sessionId}/events`)).text();
      expect(events).toContain('turn_error');
      expect(events).toContain('permission denied');
      expect(existsSync(join(home, '.harness/skills/marker'))).toBe(false);
      expect(MockProvider.lastTools).toBeUndefined();

      for (const text of ['/unknown arg', '/readonly/file.md']) {
        const { sessionId } = (await (
          await app.request('/sessions', { method: 'POST' })
        ).json()) as {
          sessionId: string;
        };
        await app.request(`/sessions/${sessionId}/turns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        await (await app.request(`/sessions/${sessionId}/events`)).text();
        expect(JSON.stringify(runtime.sessionDb.loadMessages(sessionId)[0]?.content)).toContain(
          text,
        );
        expect(observedToolNames()).toContain('Bash');
      }
    } finally {
      await runtime.dispose();
    }
  });
  test('/commands preserves skill identity and reaches the same scoped provider schemas', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const { sessionId } = (await (await app.request('/sessions', { method: 'POST' })).json()) as {
        sessionId: string;
      };
      const command = (await (
        await app.request(`/sessions/${sessionId}/commands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'readonly', args: 'example' }),
        })
      ).json()) as { promptToSend: string; turnKind: string };
      expect(command.promptToSend).toBe('/readonly example');
      expect(command.turnKind).toBe('skill');
      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: command.promptToSend,
          kind: command.turnKind,
          skillSource: 'command',
        }),
      });
      const events = await (await app.request(`/sessions/${sessionId}/events`)).text();
      expect(events).toContain('turn_complete');
      expect(MockProvider.lastTools?.map((tool) => tool.name)).toEqual(['FileRead']);
      expect(JSON.stringify(runtime.sessionDb.loadMessages(sessionId)[0]?.content)).toContain(
        'Read example',
      );
    } finally {
      await runtime.dispose();
    }
  });

  test('drive uses the identity path rather than expanded text', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
    });
    const server = await startServer({ runtime });
    let manager: DriveSseManager | undefined;
    try {
      const baseURL = `http://127.0.0.1:${server.port}`;
      const { sessionId } = (await (
        await fetch(`${baseURL}/sessions`, { method: 'POST' })
      ).json()) as { sessionId: string };
      const renderer = new EventRenderer(false, baseURL, () => {});
      manager = new DriveSseManager({ baseURL, initialSessionId: sessionId, renderer });
      manager.start();
      await runSlashCommand({ baseURL, sessionId, line: '/readonly from-drive', renderer });
      expect(MockProvider.lastTools?.map((tool) => tool.name)).toEqual(['FileRead']);
      expect(JSON.stringify(runtime.sessionDb.loadMessages(sessionId)[0]?.content)).toContain(
        'Read from-drive',
      );
    } finally {
      await manager?.stop();
      await server.stop();
      await runtime.dispose();
    }
  }, 15000);

  test('command preview does not execute shell and a host denial remains effective at activation', async () => {
    const marker = join(home, '.harness/skills/marker');
    writeFileSync(
      join(home, '.harness/skills/dynamic.md'),
      '---\nname: dynamic\ndescription: Dynamic context\nallowedTools: [Bash]\n---\n!`touch marker`',
    );
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash'] } }));
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      permissionMode: 'bypass',
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const { sessionId } = (await (await app.request('/sessions', { method: 'POST' })).json()) as {
        sessionId: string;
      };
      const command = (await (
        await app.request(`/sessions/${sessionId}/commands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'dynamic', args: '' }),
        })
      ).json()) as { promptToSend: string; turnKind: string };
      expect(command.promptToSend).toBe('/dynamic');
      expect(existsSync(marker)).toBe(false);
      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: command.promptToSend, kind: command.turnKind }),
      });
      const events = await (await app.request(`/sessions/${sessionId}/events`)).text();
      expect(events).toContain('turn_error');
      expect(events).toContain('permission denied');
      expect(existsSync(marker)).toBe(false);
      expect(MockProvider.lastTools).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});
