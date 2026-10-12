import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSkillText } from '@yevgetman/sov-sdk/skills/loader';

const markdown =
  '---\nname: advisory\ndescription: Warning fixture\ncontext: fork\n---\nKeep the accepted guidance.';

describe('pure skill loader advisory observer safety', () => {
  test('throwing descriptor and trigger warnings preserve valid data and execution denial', () => {
    const warnings: string[] = [];
    const skill = loadSkillText(markdown, {
      path: 'virtual:/advisory/SKILL.md',
      source: 'agent-created',
      trustTier: 'agent-created',
      warn: (message) => {
        warnings.push(message);
        throw new Error('advisory sink failed');
      },
    });
    expect(skill.name).toBe('advisory');
    expect(skill.body).toBe('Keep the accepted guidance.');
    expect(skill.descriptor?.execution.supported).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('context');
    expect(warnings[1]).toContain('empty whenToUse');
  });

  test('rejecting warnings cannot crash the actual compiled SDK in a strict public Node host', () => {
    const result = spawnSync(
      'node',
      [
        '--unhandled-rejections=strict',
        '--input-type=module',
        '-e',
        `
          import { loadSkillText } from '@yevgetman/sov-sdk';
          const warnings = [];
          const skill = loadSkillText(${JSON.stringify(markdown)}, {
            path: 'virtual:/advisory/SKILL.md',
            source: 'agent-created', trustTier: 'agent-created',
            warn: async message => {
              warnings.push(message);
              await Promise.resolve();
              throw new Error('advisory sink failed');
            },
          });
          await new Promise(resolve => setTimeout(resolve, 10));
          console.log(JSON.stringify({
            name: skill.name, body: skill.body,
            supported: skill.descriptor.execution.supported,
            warnings: warnings.length,
          }));
        `,
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      name: 'advisory',
      body: 'Keep the accepted guidance.',
      supported: false,
      warnings: 2,
    });
  });
});
