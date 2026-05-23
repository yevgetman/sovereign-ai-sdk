import { send } from '../channels/delivery.js';
import type { CronRunResult } from './runner.js';
import type { Job } from './types.js';

export type AgentRunInput = {
  prompt: string;
  cronJobId: string;
};

export type AgentRunOutput = {
  ok: boolean;
  output?: string;
  error?: string;
};

export type CronExecutorDeps = {
  harnessHome: string;
  runAgent: (input: AgentRunInput) => Promise<AgentRunOutput>;
  expandSkills: (skills: string[], cwd: string) => Promise<string>;
  runScript: (scriptPath: string, cwd: string, timeoutMs: number) => Promise<string>;
  cwd?: string;
};

const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;

export function buildCronJobExecutor(deps: CronExecutorDeps) {
  return async function executeCronJob(job: Job): Promise<CronRunResult> {
    const started = Date.now();
    const cwd = deps.cwd ?? deps.harnessHome;
    try {
      let scriptOutput = '';
      if (job.script) {
        try {
          scriptOutput = await deps.runScript(
            job.script,
            cwd,
            job.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
          );
        } catch (err) {
          return {
            ok: false,
            error: `pre-agent script failed: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - started,
          };
        }
      }

      const skillBlock = job.skills.length > 0 ? await deps.expandSkills(job.skills, cwd) : '';

      const sections: string[] = [];
      if (scriptOutput) sections.push(`## Script output\n\n${scriptOutput}`);
      if (skillBlock) sections.push(skillBlock);
      sections.push(job.prompt);
      const prompt = sections.join('\n\n---\n\n');

      const agentResult = await deps.runAgent({ prompt, cronJobId: job.id });
      const output = agentResult.output ?? '';

      const delivery = await send(job.deliver, output, deps.harnessHome, {
        cronJobId: job.id,
      });

      return {
        ok: agentResult.ok,
        ...(output !== '' ? { output } : {}),
        ...(agentResult.error !== undefined ? { error: agentResult.error } : {}),
        deliveryOk: delivery.ok,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  };
}
