import { buildCanUseTool } from '@yevgetman/sov-sdk/permissions/canUseTool';
// Expansion syntax fixtures explicitly own the runner. Production activation
// uses the host-gated orchestrator; no ambient execution remains in the loader.
import { expandSkillPrompt as expand } from '@yevgetman/sov-sdk/skills/loader';
import type { Skill, SkillExpansionOptions } from '@yevgetman/sov-sdk/skills/types';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { BashTool } from '@yevgetman/sov-sdk/tools/BashTool';

export function expandSkillPrompt(skill: Skill, opts: SkillExpansionOptions): Promise<string> {
  return expand(skill, {
    ...opts,
    runShellCommand: async (command, cwd) => {
      const ctx = { cwd, sessionId: opts.sessionId ?? 'fixture' };
      const input = { command, timeout_ms: 10000 };
      const gate = buildCanUseTool({
        mode: 'bypass',
        ask: async () => 'deny',
        alwaysAllow: new Set(),
      });
      if ((await gate(BashTool as Tool<unknown, unknown>, input, ctx)).behavior !== 'allow')
        throw new Error('fixture permission denied');
      try {
        const result = await BashTool.call(input, ctx);
        return result.data.exit_code === 0
          ? result.data.stdout
          : `[inline-shell error: ${command}\nexit_code: ${result.data.exit_code}\n${result.data.stderr}]`;
      } catch (error) {
        return `[inline-shell error: ${command}\n${String(error)}]`;
      }
    },
  });
}
