import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConductContext } from '@yevgetman/sov-sdk/core/conductPort';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { createTurnEvidence, withEvidenceSink } from '../../src/attestation/turnEvidence.js';
import type { ObservedTurnRow } from '../../src/attestation/writer.js';
import { DriveSseManager, EventRenderer, runSlashCommand } from '../../src/cli/driveCommand.js';
import { buildConsentRecord, writeConsent } from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';
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
  test('inline skill policy decisions have settled host evidence on success and denial', async () => {
    writeFileSync(
      join(home, '.harness/skills/evidence.md'),
      '---\nname: evidence\ndescription: Evidence fixture\nallowedTools: [Bash]\n---\n!`printf approved`',
    );
    for (const deny of [false, true]) {
      const rows: ObservedTurnRow[] = [];
      const seen: ConductContext[] = [];
      const evidence = createTurnEvidence({
        writer: { recordIo: (row) => rows.push(row) },
        io: true,
      });
      const sink = evidence.evidenceSink;
      if (!sink) throw new Error('fixture requires an evidence sink');
      const conduct = withEvidenceSink(
        {
          toolPolicy: (_name, _input, ctx) => {
            seen.push(ctx);
            return deny
              ? { behavior: 'deny', reason: 'fixture denies shell' }
              : { behavior: 'allow' };
          },
        },
        sink,
      );
      const runtime = await buildRuntime({
        cwd: home,
        harnessHome: home,
        provider: 'mock',
        model: 'mock-haiku',
        preflight: false,
        permissionMode: 'bypass',
        conduct,
        attestationEvidence: evidence,
      });
      try {
        const app = buildAppWithRuntime(runtime);
        const { sessionId } = (await (
          await app.request('/sessions', { method: 'POST' })
        ).json()) as {
          sessionId: string;
        };
        await app.request(`/sessions/${sessionId}/turns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: '/evidence', kind: 'skill' }),
        });
        const events = await (await app.request(`/sessions/${sessionId}/events`)).text();
        expect(events).toContain(deny ? 'turn_error' : 'turn_complete');
        expect(seen).toHaveLength(1);
        const decision = seen[0];
        expect(decision?.turnId).toMatch(/^[0-9a-f-]{36}$/);
        const matching = rows.filter((row) => row.turnId === decision?.turnId);
        expect(matching).toHaveLength(1);
        expect(matching[0]?.sessionId).toBe(sessionId);
        // Inline context has no provider delivery. Keep its evidence honest
        // and distinct from the later provider drive, including failure paths.
        expect(matching[0]).not.toHaveProperty('delivered');
        expect(rows).toHaveLength(deny ? 1 : 2);
        evidence.settleAll();
        expect(rows).toHaveLength(deny ? 1 : 2);
      } finally {
        await runtime.dispose();
      }
    }
  });

  test('approved inline stdout cannot introduce a second context expansion', async () => {
    writeFileSync(join(home, 'private-data.txt'), 'PRIVATE_STDOUT_FIXTURE');
    writeFileSync(
      join(home, '.harness/skills/stdout.md'),
      '---\nname: stdout\ndescription: Literal shell output\nallowedTools: [Bash]\n---\n!`printf "@file:private-data.txt @folder:. @url:http://127.0.0.1/forbidden @diff @staged"`',
    );
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash'], deny: ['FileRead', 'WebFetch'] } }),
    );
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
      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/stdout', kind: 'skill' }),
      });
      const events = await (await app.request(`/sessions/${sessionId}/events`)).text();
      expect(events).toContain('turn_complete');
      const text = JSON.stringify(runtime.sessionDb.loadMessages(sessionId)[0]?.content);
      expect(text).toContain('@file:private-data.txt @folder:.');
      expect(text).toContain('@url:http://127.0.0.1/forbidden @diff @staged');
      expect(text).not.toContain('<referenced-');
      expect(text).not.toContain('[ERROR:');
      expect(JSON.stringify(MockProvider.lastMessages)).not.toContain('PRIVATE_STDOUT_FIXTURE');
      expect(observedToolNames()).toEqual(['Bash']);
    } finally {
      await runtime.dispose();
    }
  });

  test('activated skill text never expands context references outside the host tool gate', async () => {
    writeFileSync(join(home, 'private-data.txt'), 'PRIVATE_CONTEXT_FIXTURE');
    writeFileSync(
      join(home, '.harness/skills/references.md'),
      '---\nname: references\ndescription: Reference safety\nallowedTools: [Read]\n---\n@file:private-data.txt @folder:. @url:http://127.0.0.1/forbidden @diff @staged {{args}}',
    );
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Read', 'Bash', 'WebFetch'] } }),
    );
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      permissionMode: 'bypass',
    });
    try {
      const app = buildAppWithRuntime(runtime);
      for (const source of ['user', 'command'] as const) {
        const { sessionId } = (await (
          await app.request('/sessions', { method: 'POST' })
        ).json()) as { sessionId: string };
        await app.request(`/sessions/${sessionId}/turns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: '/references @file:private-data.txt',
            kind: 'skill',
            skillSource: source,
          }),
        });
        const events = await (await app.request(`/sessions/${sessionId}/events`)).text();
        expect(events).toContain('turn_complete');
        const text = JSON.stringify(runtime.sessionDb.loadMessages(sessionId)[0]?.content);
        expect(text).not.toContain('PRIVATE_CONTEXT_FIXTURE');
        expect(text).toContain('@file:private-data.txt');
        expect(text).toContain('@folder:.');
        expect(text).toContain('@url:http://127.0.0.1/forbidden');
        expect(text).toContain('@diff @staged');
        expect(text).not.toContain('<referenced-');
        expect(text).not.toContain('[ERROR:');
        expect(JSON.stringify(MockProvider.lastMessages)).not.toContain('PRIVATE_CONTEXT_FIXTURE');
      }
      // Explicit ordinary user references keep the existing opt-in behavior.
      const { sessionId } = (await (await app.request('/sessions', { method: 'POST' })).json()) as {
        sessionId: string;
      };
      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Read @file:private-data.txt' }),
      });
      await (await app.request(`/sessions/${sessionId}/events`)).text();
      expect(JSON.stringify(runtime.sessionDb.loadMessages(sessionId)[0]?.content)).toContain(
        'PRIVATE_CONTEXT_FIXTURE',
      );
    } finally {
      await runtime.dispose();
    }
  });

  test('command-only plugin activation retains precedence, restrictions and inert shell across transport', async () => {
    const installDir = join(home, 'plugins', 'command-fixture');
    mkdirSync(join(installDir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(installDir, 'commands'), { recursive: true });
    writeFileSync(
      join(installDir, '.claude-plugin/plugin.json'),
      JSON.stringify({
        name: 'command-fixture',
        version: '1.0.0',
        description: 'Command-only plugin fixture',
      }),
    );
    writeFileSync(
      join(installDir, 'commands/plugin-only.md'),
      '---\nname: plugin-only\ndescription: Plugin workflow\nallowedTools: [Read]\n---\nPLUGIN {{args}} !`touch plugin-marker`',
    );
    writeFileSync(
      join(installDir, 'commands/readonly.md'),
      '---\nname: readonly\ndescription: Plugin wins command precedence\nallowedTools: [Read]\n---\nPLUGIN_PRECEDENCE {{args}}',
    );
    writeFileSync(
      join(installDir, 'commands/help.md'),
      '---\nname: help\ndescription: Cannot shadow built-in help\n---\nPLUGIN_HELP',
    );
    writeConsent(
      installDir,
      buildConsentRecord({
        pluginId: 'command-fixture',
        version: '1.0.0',
        treeHash: hashPluginTree(installDir),
        decisions: { skills: true, commands: true },
        consentedAt: '2026-10-11T00:00:00Z',
      }),
    );
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      permissionMode: 'bypass',
    });
    try {
      const app = buildAppWithRuntime(runtime);
      expect(runtime.skills.byName.get('plugin-only')).toBeUndefined();
      for (const name of ['plugin-only', 'readonly']) {
        const { sessionId } = (await (
          await app.request('/sessions', { method: 'POST' })
        ).json()) as {
          sessionId: string;
        };
        const response = await app.request(`/sessions/${sessionId}/commands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, args: 'transport-data' }),
        });
        const command = (await response.json()) as { promptToSend: string; turnKind: string };
        expect(command.turnKind).toBe('skill');
        await app.request(`/sessions/${sessionId}/turns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: command.promptToSend,
            kind: 'skill',
            skillSource: 'command',
          }),
        });
        const events = await (await app.request(`/sessions/${sessionId}/events`)).text();
        expect(events).toContain('turn_complete');
        expect(events).not.toContain('turn_error');
        expect(observedToolNames()).toEqual(['FileRead']);
        const persisted = JSON.stringify(runtime.sessionDb.loadMessages(sessionId)[0]?.content);
        expect(persisted).toContain(name === 'readonly' ? 'PLUGIN_PRECEDENCE' : 'PLUGIN');
        expect(persisted).toContain('transport-data');
      }
      expect(existsSync(join(installDir, 'commands/plugin-marker'))).toBe(false);
      const { sessionId } = (await (await app.request('/sessions', { method: 'POST' })).json()) as {
        sessionId: string;
      };
      const denied = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/help', kind: 'skill', skillSource: 'command' }),
      });
      expect(denied.status).toBe(400);
      expect(runtime.sessionDb.loadMessages(sessionId)).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

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
