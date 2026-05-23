export type ScheduleKind =
  | { kind: 'relative'; offsetMs: number }
  | { kind: 'interval'; intervalMs: number }
  | { kind: 'cron'; expression: string }
  | { kind: 'iso'; runAt: number };

export type Job = {
  id: string;
  prompt: string;
  schedule: ScheduleKind;
  deliver: string;
  skills: string[];
  script?: string;
  scriptTimeoutMs?: number;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt?: number;
  lastResult?: { ok: boolean; deliveryOk?: boolean; error?: string; durationMs: number };
  createdAt: number;
  updatedAt: number;
};

export type JobsFile = {
  version: 1;
  jobs: Job[];
};
