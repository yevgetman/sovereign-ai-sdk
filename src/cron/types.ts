export type ScheduleKind =
  | { kind: 'relative'; offsetMs: number }
  | { kind: 'interval'; intervalMs: number }
  | { kind: 'cron'; expression: string }
  | { kind: 'iso'; runAt: number };
