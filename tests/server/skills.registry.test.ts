import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadSkill } from '../../packages/sdk/src/skills/loader.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildServerCommandContext } from '../../src/server/commandContext.js';
import { buildRuntime } from '../../src/server/runtime.js';

const document = (name: string, extra = '', body = 'Follow the steps.') =>
  `---\nname: ${name}\ndescription: useful ${name}\nwhenToUse: If the user asks for this task, then invoke this skill.\n${extra}---\n${body}\n`;

describe('live server skill catalogs', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sov-live-skills-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('install/import/uninstall update skill and command views without a restart', async () => {
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    const runtime = await buildRuntime({
      cwd,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      cronEnabled: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const sessionId = (
        (await (await app.request('/sessions', { method: 'POST' })).json()) as { sessionId: string }
      ).sessionId;
      const source = join(root, 'SKILL.md');
      writeFileSync(source, document('newSkill'));
      const old = runtime.skillRegistryManager.snapshot();
      const res = await app.request(`/sessions/${sessionId}/skills/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { catalog: { refreshed: boolean } }).catalog.refreshed).toBe(
        true,
      );
      expect(old.registry.byName.has('newSkill')).toBe(false);
      expect(runtime.skills.byName.has('newSkill')).toBe(true);
      const list = (await (await app.request(`/sessions/${sessionId}/skills`)).json()) as {
        skills: { name: string }[];
      };
      expect(list.skills.some((s: { name: string }) => s.name === 'newSkill')).toBe(true);
      const commands = buildServerCommandContext(
        runtime,
        runtime.getSessionContext(sessionId),
        sessionId,
      );
      expect(commands.ctx.registry.has('newSkill')).toBe(true);
      const generation = runtime.skillRegistryManager.snapshot().generation;
      const failed = await app.request(`/sessions/${sessionId}/skills/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      expect(failed.status).toBe(400);
      expect(runtime.skillRegistryManager.snapshot().generation).toBe(generation);
      writeFileSync(source, document('newSkill', '', 'Changed guidance.'));
      const edited = await app.request(`/sessions/${sessionId}/skills/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, force: true }),
      });
      expect(edited.status).toBe(200);
      const metadata = runtime.skills.byName.get('newSkill');
      expect(metadata?.body).toBe('');
      expect(metadata?.guardDeferred).toBe(true);
      if (!metadata) throw new Error('Imported skill is missing from the catalog');
      expect((await reloadSkill(metadata)).body).toContain('Changed guidance');
      const removed = await app.request(`/sessions/${sessionId}/skills/newSkill`, {
        method: 'DELETE',
      });
      expect(removed.status).toBe(200);
      expect(runtime.skills.byName.has('newSkill')).toBe(false);
      expect(
        buildServerCommandContext(
          runtime,
          runtime.getSessionContext(sessionId),
          sessionId,
        ).ctx.registry.has('newSkill'),
      ).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test('remote doctor hides paths/content and refuses another principal before catalog access', async () => {
    const home = join(root, 'home');
    mkdirSync(join(home, 'skills', 'bad'), { recursive: true });
    writeFileSync(join(home, 'skills', 'bad', 'SKILL.md'), 'PRIVATE-MALFORMED-INPUT');
    const runtime = await buildRuntime({
      cwd: root,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      cronEnabled: false,
    });
    try {
      const app = buildAppWithRuntime(runtime, {
        principals: [
          { id: 'alice', token: 'test-a' },
          { id: 'bob', token: 'test-b' },
        ],
      });
      const sessionId = (
        (await (
          await app.request('/sessions', {
            method: 'POST',
            headers: { authorization: 'Bearer test-a' },
          })
        ).json()) as { sessionId: string }
      ).sessionId;
      let reads = 0;
      const original = runtime.skillRegistryManager.snapshot;
      runtime.skillRegistryManager.snapshot = () => {
        reads++;
        return original();
      };
      const hidden = await app.request(`/sessions/${sessionId}/skills/doctor`, {
        headers: { authorization: 'Bearer test-b' },
      });
      expect(hidden.status).toBe(404);
      expect(reads).toBe(0);
      const own = await app.request(`/sessions/${sessionId}/skills/doctor`, {
        headers: { authorization: 'Bearer test-a' },
      });
      expect(own.status).toBe(200);
      const report = (await own.json()) as { diagnostics: { code: string }[] };
      expect(report.diagnostics.some((d: { code: string }) => d.code === 'load-rejected')).toBe(
        true,
      );
      expect(JSON.stringify(report)).not.toContain(root);
      expect(JSON.stringify(report)).not.toContain('PRIVATE');
    } finally {
      await runtime.dispose();
    }
  });

  test('explicit runtime and profile approvals discover managed cross-project links without changing trust', async () => {
    const project = join(root, 'project');
    const external = join(root, 'external');
    mkdirSync(join(project, '.harness', 'skills'), { recursive: true });
    mkdirSync(join(project, '.git'));
    mkdirSync(external);
    writeFileSync(join(external, 'SKILL.md'), document('managed'));
    symlinkSync(external, join(project, '.harness', 'skills', 'managed'));
    const first = await buildRuntime({
      cwd: project,
      harnessHome: join(root, 'one'),
      provider: 'mock',
      preflight: false,
      cronEnabled: false,
    });
    const second = await buildRuntime({
      cwd: project,
      harnessHome: join(root, 'two'),
      provider: 'mock',
      preflight: false,
      cronEnabled: false,
      settings: { skills: { discovery: { allowedLinkRoots: [external] } } },
    });
    const third = await buildRuntime({
      cwd: project,
      harnessHome: join(root, 'three'),
      provider: 'mock',
      preflight: false,
      cronEnabled: false,
      skillDiscovery: { allowedLinkRoots: [external] },
    });
    try {
      expect(first.skills.byName.has('managed')).toBe(false);
      expect(
        first.skillRegistryManager.snapshot().diagnostics.some((d) => d.code === 'scope-denied'),
      ).toBe(true);
      expect(second.skills.byName.get('managed')?.trustTier).toBe('trusted');
      expect(third.skills.byName.has('managed')).toBe(true);
      expect(first.skills.byName.has('managed')).toBe(false);
    } finally {
      await Promise.all([first.dispose(), second.dispose(), third.dispose()]);
    }
  });
});

test('local doctor reports roots without provider calls or skill execution', async () => {
  const { runSkillsDoctor } = await import('../../src/cli/skillsDoctorCommand.js');
  const root = mkdtempSync(join(tmpdir(), 'sov-local-doctor-'));
  try {
    mkdirSync(join(root, '.agents', 'skills', 'local'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'skills', 'local', 'SKILL.md'),
      document('local', '', '!`touch should-not-run`'),
    );
    let output = '';
    expect(
      await runSkillsDoctor({ cwd: root, harnessHome: join(root, 'home'), json: true }, (text) => {
        output = text;
      }),
    ).toBe(0);
    const report = JSON.parse(output) as {
      skillCount: number;
      diagnostics: { code: string; path?: string; precedence?: number }[];
    };
    expect(report.skillCount).toBeGreaterThan(0);
    expect(
      report.diagnostics.some((d) => d.code === 'root-ready' && d.path?.includes('.agents')),
    ).toBe(true);
    expect(report.diagnostics.some((d) => d.precedence !== undefined)).toBe(true);
    expect(await Bun.file(join(root, 'should-not-run')).exists()).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native committed writers refresh future calls while an activation retains its revision', async () => {
  const { SkillManageTool } = await import('../../packages/sdk/src/tools/SkillManageTool.js');
  const { SkillTool } = await import('../../packages/sdk/src/tools/SkillTool.js');
  const { createSkillActivationState } = await import(
    '../../packages/sdk/src/skills/activation.js'
  );
  const { buildSessionToolContext } = await import('../../src/server/sessionToolContext.js');
  const root = mkdtempSync(join(tmpdir(), 'sov-writer-live-'));
  const runtime = await buildRuntime({
    cwd: root,
    harnessHome: join(root, 'home'),
    provider: 'mock',
    preflight: false,
    cronEnabled: false,
  });
  try {
    const app = buildAppWithRuntime(runtime);
    const sessionId = (
      (await (await app.request('/sessions', { method: 'POST' })).json()) as { sessionId: string }
    ).sessionId;
    const ctx = buildSessionToolContext(runtime, sessionId, runtime.canUseTool);
    const created = await SkillManageTool.call(
      {
        action: 'create',
        name: 'fresh',
        body: 'Original guidance.',
        frontmatter: {
          description: 'fresh task',
          whenToUse: 'If the user asks for a fresh task, then activate this skill.',
        },
      },
      ctx,
    );
    expect(created.data.ok).toBe(true);
    expect(runtime.skills.byName.has('fresh')).toBe(true);
    const state = createSkillActivationState({
      tools: runtime.toolPool,
      canUseTool: runtime.canUseTool,
    });
    const activeCtx = { ...ctx, skillActivation: state };
    const old = await SkillTool.call({ skill: 'fresh' }, activeCtx);
    expect(old.data.prompt).toContain('Original guidance');
    const edited = await SkillManageTool.call(
      {
        action: 'edit',
        name: 'fresh',
        expectedRevision: created.data.revision ?? '',
        body: 'Updated guidance.',
        frontmatter: {
          description: 'fresh task',
          whenToUse: 'If the user asks for a fresh task, then activate this skill.',
        },
      },
      ctx,
    );
    expect(edited.data.ok).toBe(true);
    const next = await SkillTool.call({ skill: 'fresh' }, activeCtx);
    expect(next.data.prompt).toContain('Updated guidance');
    expect(next.data.activation.revision).not.toBe(old.data.activation.revision);
    expect(old.data.prompt).toContain('Original guidance');
    expect(state.activations[0]?.revision).toBe(old.data.activation.revision);
    await SkillManageTool.call(
      { action: 'delete', name: 'fresh', expectedRevision: edited.data.revision ?? '' },
      ctx,
    );
    await expect(SkillTool.call({ skill: 'fresh' }, activeCtx)).rejects.toThrow(
      "unknown skill 'fresh'",
    );
    expect(runtime.skills.byName.has('fresh')).toBe(false);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
