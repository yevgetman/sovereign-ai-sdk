import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { InMemorySkillStore } from '@yevgetman/sov-sdk/skills/store';
import { DriveSseManager, EventRenderer, runSlashCommand } from '../../src/cli/driveCommand.js';
import { addJob } from '../../src/cron/jobs.js';
import { createProductionCronRunner } from '../../src/cron/wiring.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { startServer } from '../../src/server/index.js';
import { buildRuntime } from '../../src/server/runtime.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sov-composed-skills-'));
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  MockProvider.lastTools = undefined;
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env requires delete.
  delete process.env.SOV_TEST_MOCK_PROVIDER;
  MockProvider.lastTools = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function catalog(profile: string) {
  const skills = createSkillRuntime({ store: new InMemorySkillStore() });
  await skills.mutate({
    action: 'create',
    name: 'portable',
    content: `---\nname: portable\ndescription: Profile workflow\nwhenToUse: Use when asked to run the portable workflow.\nallowedTools: [Read]\n---\n${profile}: {{args}}`,
  });
  return skills;
}

describe('SOV consumes the composed SDK skill runtime', () => {
  test('server command and plain run transport activate injected memory catalogs in separate profiles', async () => {
    for (const profile of ['first', 'second']) {
      const skills = await catalog(profile);
      const cwd = join(root, profile);
      mkdirSync(cwd);
      const runtime = await buildRuntime({
        cwd,
        harnessHome: join(cwd, 'home'),
        provider: 'mock',
        preflight: false,
        cronEnabled: false,
        skillRuntime: skills,
      });
      try {
        expect(runtime.skillRuntime).toBe(skills);
        const app = buildAppWithRuntime(runtime);
        const { sessionId } = (await (
          await app.request('/sessions', { method: 'POST' })
        ).json()) as { sessionId: string };
        const command = (await (
          await app.request(`/sessions/${sessionId}/commands`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'portable', args: 'command' }),
          })
        ).json()) as { promptToSend: string; turnKind: string };
        expect(command.promptToSend).toBe('/portable command');
        expect(command.turnKind).toBe('skill');
        const response = await app.request(`/sessions/${sessionId}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '/portable\trun' }),
        });
        expect(response.status).toBe(202);
        expect(await (await app.request(`/sessions/${sessionId}/events`)).text()).toContain(
          'turn_complete',
        );
        expect(MockProvider.lastTools?.map((tool) => tool.name)).toEqual(['FileRead']);
        expect(JSON.stringify(runtime.sessionDb.loadMessages(sessionId)[0]?.content)).toContain(
          `${profile}: run`,
        );
      } finally {
        await runtime.dispose();
      }
      // An injected runtime belongs to its host, not to the disposed SOV server.
      await expect(skills.refresh()).resolves.toBeDefined();
      skills.dispose();
    }
  });

  test('drive and cron use the same memory resolver and native permission floor', async () => {
    const skills = await catalog('shared');
    const runtime = await buildRuntime({
      cwd: root,
      harnessHome: join(root, 'home'),
      provider: 'mock',
      preflight: false,
      cronEnabled: false,
      skillRuntime: skills,
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
      await runSlashCommand({ baseURL, sessionId, line: '/portable drive', renderer });
      expect(JSON.stringify(runtime.sessionDb.loadMessages(sessionId)[0]?.content)).toContain(
        'shared: drive',
      );
      expect(MockProvider.lastTools?.map((tool) => tool.name)).toEqual(['FileRead']);
      const job = addJob(runtime.harnessHome, {
        prompt: 'report',
        skills: ['portable'],
        schedule: { kind: 'relative', offsetMs: 0 },
        deliver: 'local',
      });
      const result = await createProductionCronRunner(runtime, runtime.harnessHome).forceRunJob(
        job.id,
      );
      expect(result.ok).toBe(true);
      expect(MockProvider.lastTools?.map((tool) => tool.name)).toEqual(['FileRead']);
    } finally {
      await manager?.stop();
      await server.stop();
      await runtime.dispose();
      skills.dispose();
    }
  }, 15_000);

  test('server installation writes only to the injected store and readonly profiles refuse writes', async () => {
    const source = join(root, 'source');
    mkdirSync(source);
    writeFileSync(
      join(source, 'SKILL.md'),
      '---\nname: imported\ndescription: Imported workflow\n---\nInspect the task.',
    );
    for (const writable of [true, false]) {
      const skills = writable
        ? createSkillRuntime({ store: new InMemorySkillStore() })
        : createSkillRuntime({
            load: async () => ({ registry: { skills: [], byName: new Map() } }),
          });
      const profileHome = join(root, writable ? 'write-profile' : 'read-profile');
      const runtime = await buildRuntime({
        cwd: root,
        harnessHome: profileHome,
        provider: 'mock',
        preflight: false,
        cronEnabled: false,
        skillRuntime: skills,
      });
      try {
        const app = buildAppWithRuntime(runtime);
        const { sessionId } = (await (
          await app.request('/sessions', { method: 'POST' })
        ).json()) as { sessionId: string };
        const response = await app.request(`/sessions/${sessionId}/skills/install`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source }),
        });
        expect(response.status).toBe(writable ? 200 : 400);
        expect(existsSync(join(profileHome, 'skills'))).toBe(false);
        if (writable) {
          const installed = (await response.json()) as { installedAt: string };
          expect(installed.installedAt).toBe('skill:imported');
          expect(skills.snapshot().registry.byName.has('imported')).toBe(true);
          const removed = await app.request(`/sessions/${sessionId}/skills/imported`, {
            method: 'DELETE',
          });
          expect(removed.status).toBe(200);
          expect(skills.snapshot().registry.byName.has('imported')).toBe(false);
        }
      } finally {
        await runtime.dispose();
        skills.dispose();
      }
    }
  });
});
