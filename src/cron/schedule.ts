import cronParser from 'cron-parser';
import type { ScheduleKind } from './types.js';

const RELATIVE_RE = /^(\d+)([smhd])$/;
const INTERVAL_RE = /^every\s+(\d+)([smhd])$/i;
const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseSchedule(spec: string): ScheduleKind {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error('schedule cannot be empty');

  const interval = INTERVAL_RE.exec(trimmed);
  if (interval) {
    const n = interval[1];
    const unit = interval[2];
    if (n && unit) {
      const ms = UNIT_MS[unit.toLowerCase()];
      if (ms !== undefined) {
        return { kind: 'interval', intervalMs: Number(n) * ms };
      }
    }
  }

  const relative = RELATIVE_RE.exec(trimmed);
  if (relative) {
    const n = relative[1];
    const unit = relative[2];
    if (n && unit) {
      const ms = UNIT_MS[unit];
      if (ms !== undefined) {
        return { kind: 'relative', offsetMs: Number(n) * ms };
      }
    }
  }

  if (ISO_PREFIX_RE.test(trimmed)) {
    const isoTs = Date.parse(trimmed);
    if (!Number.isNaN(isoTs)) {
      return { kind: 'iso', runAt: isoTs };
    }
  }

  try {
    cronParser.parseExpression(trimmed);
    return { kind: 'cron', expression: trimmed };
  } catch {
    throw new Error(`unparseable schedule: ${spec}`);
  }
}

export function computeNextRun(
  schedule: ScheduleKind,
  lastRun: number | null,
  now: number,
): number | null {
  switch (schedule.kind) {
    case 'relative':
      return lastRun === null ? now + schedule.offsetMs : null;
    case 'iso':
      return lastRun === null ? schedule.runAt : null;
    case 'interval':
      return (lastRun ?? now) + schedule.intervalMs;
    case 'cron': {
      const baseTime = lastRun ?? now - 1;
      const it = cronParser.parseExpression(schedule.expression, {
        currentDate: new Date(baseTime),
        tz: 'UTC',
      });
      return it.next().getTime();
    }
  }
}
