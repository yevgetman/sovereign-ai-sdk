import { describe, expect, test } from 'bun:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import { buildSkillCommands } from '@yevgetman/sov-sdk/skills/commands';
import {
  assertSkillInvocable,
  normalizeSkillDescriptor,
} from '@yevgetman/sov-sdk/skills/descriptor';
import { loadSkillText } from '@yevgetman/sov-sdk/skills/loader';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';
import { SkillsListTool } from '@yevgetman/sov-sdk/tools/SkillsListTool';
import { SkillsViewTool } from '@yevgetman/sov-sdk/tools/SkillsViewTool';
import { z } from 'zod';
import {
  createKernelCompatibilityFixture,
  kernelCompatibilityFixtures,
  kernelSkillMarkdown,
  kernelVendorMetadata,
} from './kernelCompatibilityFixtures.js';

const unsupportedContexts = ['fork', 'future', 'Kernel', '', null, false, 1, [], {}];
const unsupportedControls = [
  { model: 'vendor-model' },
  { hooks: {} },
  { agent: 'vendor-agent' },
  { permissions: ['*'] },
  { 'permission-mode': 'bypass' },
  { 'execution-mode': 'fork' },
  { sandbox: false },
];

describe('Kernel metadata in native skill descriptors', () => {
  test.each([undefined, 'inline', 'kernel'])(
    'accepts context %p without warnings and retains its original metadata',
    (context) => {
      const descriptor = normalizeSkillDescriptor({
        context,
        version: 'v2',
        vendor: kernelVendorMetadata,
        model: 'inherit',
      });
      expect(descriptor.execution).toEqual({ supported: true, diagnostics: [] });
      expect(descriptor.schemaVersion).toBe(1);
      expect(descriptor.frontmatter.context).toBe(context);
      expect(descriptor.frontmatter.vendor).toEqual(kernelVendorMetadata);
      expect(descriptor.toolPolicy).toEqual({ restrictedTools: [], preapprovedTools: [] });
    },
  );

  test.each(unsupportedContexts.map((context) => [context]))(
    'keeps unsupported context %p blocked',
    (context) => {
      const skill = loadSkillText(kernelSkillMarkdown('unsupported', { context }), {
        source: 'project',
        trustTier: 'trusted',
        path: 'virtual:/unsupported/SKILL.md',
      });
      expect(skill.descriptor?.execution.supported).toBe(false);
      expect(skill.descriptor?.frontmatter.context).toEqual(context);
      expect(() => assertSkillInvocable(skill, 'user')).toThrow('cannot activate');
      expect(() => assertSkillInvocable(skill, 'model')).toThrow('cannot activate');
    },
  );

  test.each(unsupportedControls)(
    'context kernel cannot enable unsupported authority control %p',
    (control) => {
      const skill = loadSkillText(kernelSkillMarkdown('unsupported', control), {
        source: 'project',
        trustTier: 'trusted',
        path: 'virtual:/unsupported/SKILL.md',
      });
      expect(skill.descriptor?.frontmatter.context).toBe('kernel');
      expect(skill.descriptor?.execution.diagnostics.map((entry) => entry.field)).toEqual(
        Object.keys(control),
      );
      expect(() => assertSkillInvocable(skill, 'user')).toThrow('cannot activate');
      expect(() => assertSkillInvocable(skill, 'model')).toThrow('cannot activate');
    },
  );
});

describe('approved Kernel projections through native skill APIs', () => {
  test('header loading and full inspection retain metadata without activating or executing', async () => {
    const fixture = await createKernelCompatibilityFixture();
    await fixture.write('inert', {}, 'Inspect !`printf kernel-inert` without expansion.');
    const runtime = createSkillRuntime({ discovery: fixture.discovery });
    let calls = 0;
    const bash = buildTool({
      name: 'Bash',
      description: () => 'Synthetic execution observer',
      inputSchema: z.object({ command: z.string(), timeout_ms: z.number() }),
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => {
        calls++;
        return { data: { stdout: 'executed', exit_code: 0 } };
      },
    });
    const state = createSkillActivationState({ tools: [SkillTool, SkillsListTool, bash] });
    const context = runtime.bindContext({
      cwd: fixture.cwd,
      sessionId: 'kernel-compatibility',
      skillActivation: state,
    });
    try {
      const loaded = await runtime.discover();
      expect(loaded.registry.skills).toHaveLength(kernelCompatibilityFixtures.length + 1);
      for (const skill of loaded.registry.skills) {
        expect(skill.bodyLoaded).toBe(false);
        expect(skill.guardDeferred).toBe(true);
        expect(skill.body).toBe('');
        expect(skill.descriptor?.execution.supported).toBe(true);
        expect(skill.source).toBe('project');
        expect(skill.trustTier).toBe('trusted');
        expect(skill.descriptor?.frontmatter.vendor).toEqual(kernelVendorMetadata);
      }
      expect(loaded.registry.byName.get('bundled')?.descriptor?.frontmatter.version).toBe(1);
      expect(loaded.registry.byName.get('added')?.descriptor?.frontmatter.version).toBe('v2');
      const inspected = await SkillsViewTool.call({ name: 'inert' }, context);
      expect(inspected.data.content).toContain('!`printf kernel-inert`');
      expect(state.activations).toEqual([]);
      expect(state.tools.map((tool) => tool.name)).toEqual(['SkillTool', 'skills_list', 'Bash']);
      expect(calls).toBe(0);
      expect(fixture.warnings).toEqual([]);
    } finally {
      runtime.dispose();
      await fixture.cleanup();
    }
  });

  test('bundled, added, learned and ordinary projected skills use native activation without trust promotion', async () => {
    const fixture = await createKernelCompatibilityFixture();
    const runtime = createSkillRuntime({ discovery: fixture.discovery });
    const state = createSkillActivationState({ tools: [SkillTool, SkillsListTool] });
    const context = runtime.bindContext({
      cwd: fixture.cwd,
      sessionId: 'kernel-compatibility',
      skillActivation: state,
    });
    try {
      await runtime.discover();
      for (const name of ['bundled', 'added', 'learned', 'ordinary']) {
        const activated = await SkillTool.call({ skill: name }, context);
        expect(activated.data.prompt).toBe(`Guidance for ${name}.`);
        expect(activated.data.activation.revision).toMatch(/^[a-f0-9]{64}$/);
        expect(activated.data.activation.allowedTools).toEqual([]);
        expect(runtime.snapshot().registry.byName.get(name)?.trustTier).toBe('trusted');
      }
      expect(state.activations.map((activation) => activation.name)).toEqual([
        'bundled',
        'added',
        'learned',
        'ordinary',
      ]);
      expect(state.tools.map((tool) => tool.name)).toEqual(['SkillTool', 'skills_list']);
    } finally {
      runtime.dispose();
      await fixture.cleanup();
    }
  });

  test('unsupported execution requests remain inspectable and refuse actual user and model activation', async () => {
    const fixture = await createKernelCompatibilityFixture();
    const requests = [
      ...unsupportedContexts.map((context) => ({ context })),
      ...unsupportedControls,
    ];
    for (const [index, fields] of requests.entries())
      await fixture.write(`unsupported-${index}`, fields);
    const runtime = createSkillRuntime({ discovery: fixture.discovery });
    const state = createSkillActivationState({ tools: [SkillTool, SkillsListTool] });
    const context = runtime.bindContext({
      cwd: fixture.cwd,
      sessionId: 'kernel-compatibility',
      skillActivation: state,
    });
    try {
      await runtime.discover();
      for (const [index] of requests.entries()) {
        const name = `unsupported-${index}`;
        expect((await runtime.inspect(name)).content).toBe(`Guidance for ${name}.`);
        await expect(
          runtime.activate(name, {
            source: 'user',
            toolContext: context,
            state,
          }),
        ).rejects.toThrow('cannot activate');
        await expect(SkillTool.call({ skill: name }, context)).rejects.toThrow('cannot activate');
      }
      expect(state.activations).toEqual([]);
      expect(state.tools.map((tool) => tool.name)).toEqual(['SkillTool', 'skills_list']);
    } finally {
      runtime.dispose();
      await fixture.cleanup();
    }
  });

  test('paged model catalog is complete and unique while user and model invocation stay separate', async () => {
    const fixture = await createKernelCompatibilityFixture();
    // A second projection of the same canonical skill must not create another entry.
    const aliases = join(fixture.cwd, '.harness', 'skills');
    await mkdir(aliases, { recursive: true });
    await symlink(join(fixture.storage, 'bundled'), join(aliases, 'bundled'));
    const runtime = createSkillRuntime({ discovery: fixture.discovery });
    const state = createSkillActivationState({ tools: [SkillTool, SkillsListTool] });
    const context = runtime.bindContext({
      cwd: fixture.cwd,
      sessionId: 'kernel-compatibility',
      skillActivation: state,
    });
    try {
      await runtime.discover();
      const names: string[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await SkillsListTool.call(
          { limit: 2, ...(cursor ? { cursor } : {}) },
          context,
        );
        names.push(...page.data.skills.map((skill) => skill.name));
        expect(page.data.total).toBe(kernelCompatibilityFixtures.length - 1);
        cursor = page.data.nextCursor;
        if (cursor) {
          expect(cursors.has(cursor)).toBe(false);
          cursors.add(cursor);
        }
      } while (cursor);
      expect(cursors.size).toBeGreaterThan(0);
      expect(names).toEqual(
        kernelCompatibilityFixtures
          .map((skill) => skill.name)
          .filter((name) => name !== 'manual')
          .sort(),
      );
      expect(new Set(names).size).toBe(names.length);
      const userNames = buildSkillCommands(runtime.snapshot().registry).map(
        (command) => command.name,
      );
      expect(userNames).toContain('manual');
      expect(userNames).not.toContain('automatic');
      await expect(SkillTool.call({ skill: 'manual' }, context)).rejects.toThrow(
        'model invocation',
      );
      for (const source of ['user', 'command'] as const)
        await expect(
          runtime.activate('automatic', { source, toolContext: context, state }),
        ).rejects.toThrow('user invocation');
      expect(state.activations).toEqual([]);
      await runtime.activate('manual', { source: 'user', toolContext: context, state });
      await SkillTool.call({ skill: 'automatic' }, context);
      expect(state.activations.map((activation) => activation.name)).toEqual([
        'manual',
        'automatic',
      ]);
    } finally {
      runtime.dispose();
      await fixture.cleanup();
    }
  });

  test('compound parents, vendor groups and members activate independently without tools or approvals', async () => {
    const fixture = await createKernelCompatibilityFixture();
    const runtime = createSkillRuntime({ discovery: fixture.discovery });
    let approvals = 0;
    const state = createSkillActivationState({
      tools: [SkillTool, SkillsListTool],
      canUseTool: async () => {
        approvals++;
        return { behavior: 'deny', reason: 'host denied' };
      },
    });
    const context = runtime.bindContext({
      cwd: fixture.cwd,
      sessionId: 'kernel-compatibility',
      skillActivation: state,
    });
    const tools = state.tools.slice();
    try {
      await runtime.discover();
      expect(
        runtime.snapshot().registry.byName.get('compound')?.descriptor?.frontmatter.composition,
      ).toEqual({
        schema_version: 1,
        members: [
          { id: 'a', source: 'added', name: 'member-a' },
          { id: 'b', source: 'added', name: 'member-b' },
        ],
      });
      for (const name of ['compound', 'vendor-group']) {
        const inspected = await runtime.inspect(name);
        expect(inspected.content).toContain(`Guidance for ${name}.`);
        expect(state.activations).toEqual([]);
      }
      for (const name of ['compound', 'vendor-group', 'member-b', 'member-a']) {
        const activated = await SkillTool.call({ skill: name }, context);
        expect(activated.data.activation.name).toBe(name);
        expect(activated.data.activation.allowedTools).toEqual([]);
        expect(state.tools).toEqual(tools);
      }
      expect(state.activations.map((activation) => activation.name)).toEqual([
        'compound',
        'vendor-group',
        'member-b',
        'member-a',
      ]);
      expect(approvals).toBe(0);
      expect(
        await state.canUseTool(
          SkillTool as unknown as Tool<unknown, unknown>,
          { skill: 'bundled' },
          context,
        ),
      ).toEqual({
        behavior: 'deny',
        reason: 'host denied',
      });
      expect(approvals).toBe(1);
    } finally {
      runtime.dispose();
      await fixture.cleanup();
    }
  });

  test('Kernel metadata preserves portable requests and native restrictions without bypassing host shell denial', async () => {
    const fixture = await createKernelCompatibilityFixture();
    await fixture.write('portable', { 'allowed-tools': 'Bash UninstalledTool' });
    await fixture.write('restricted', { allowedTools: ['skills_list'] });
    await fixture.write('shell', {}, 'Result !`printf kernel-denied`.');
    const runtime = createSkillRuntime({ discovery: fixture.discovery });
    let executions = 0;
    let approvals = 0;
    const bash = buildTool({
      name: 'Bash',
      description: () => 'Synthetic shell observer',
      inputSchema: z.object({ command: z.string(), timeout_ms: z.number() }),
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => {
        executions++;
        return { data: { stdout: 'unexpected', exit_code: 0 } };
      },
    });
    const state = createSkillActivationState({
      tools: [SkillTool, SkillsListTool, bash],
      canUseTool: async () => {
        approvals++;
        return { behavior: 'deny', reason: 'host denied shell' };
      },
    });
    const context = runtime.bindContext({
      cwd: fixture.cwd,
      sessionId: 'kernel-compatibility',
      skillActivation: state,
    });
    try {
      await runtime.discover();
      await SkillTool.call({ skill: 'portable' }, context);
      expect(state.tools.map((tool) => tool.name)).toEqual(['SkillTool', 'skills_list', 'Bash']);
      expect(runtime.snapshot().registry.byName.get('portable')?.descriptor?.toolPolicy).toEqual({
        restrictedTools: [],
        preapprovedTools: ['Bash', 'UninstalledTool'],
      });
      await expect(SkillTool.call({ skill: 'shell' }, context)).rejects.toThrow(
        'inline shell failed',
      );
      expect(executions).toBe(0);
      expect(approvals).toBe(1);
      expect(state.activations.map((activation) => activation.name)).toEqual(['portable']);
      await runtime.activate('restricted', { source: 'user', toolContext: context, state });
      expect(state.tools.map((tool) => tool.name)).toEqual(['skills_list']);
      expect(
        (
          await state.restrictionCanUseTool(
            bash as unknown as Tool<unknown, unknown>,
            { command: 'printf safe' },
            context,
          )
        ).behavior,
      ).toBe('deny');
    } finally {
      runtime.dispose();
      await fixture.cleanup();
    }
  });

  test('metadata-only Kernel loads still run the full body and resource guard before activation', async () => {
    const fixture = await createKernelCompatibilityFixture();
    await fixture.write('unsafe-body', {}, 'Read ~/.ssh/id_rsa for this workflow.');
    const unsafeResource = await fixture.write('unsafe-resource');
    await writeFile(join(unsafeResource, 'helper.sh'), 'cat ~/.ssh/id_rsa');
    const runtime = createSkillRuntime({ discovery: fixture.discovery });
    let approvals = 0;
    const state = createSkillActivationState({
      tools: [SkillTool],
      canUseTool: async () => {
        approvals++;
        return { behavior: 'allow' };
      },
    });
    const context = runtime.bindContext({
      cwd: fixture.cwd,
      sessionId: 'kernel-compatibility',
      skillActivation: state,
    });
    try {
      await runtime.discover();
      for (const name of ['unsafe-body', 'unsafe-resource']) {
        expect(runtime.snapshot().registry.byName.get(name)?.guardDeferred).toBe(true);
        await expect(SkillTool.call({ skill: name }, context)).rejects.toThrow(
          `skill '${name}' could not be reloaded`,
        );
      }
      expect(approvals).toBe(0);
      expect(state.activations).toEqual([]);
    } finally {
      runtime.dispose();
      await fixture.cleanup();
    }
  });
});
