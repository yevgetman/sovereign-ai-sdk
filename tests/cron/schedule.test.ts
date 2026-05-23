import { describe, expect, test } from 'bun:test';
import { computeNextRun, parseSchedule } from '../../src/cron/schedule.js';

describe('parseSchedule', () => {
  test('parses relative duration "30m"', () => {
    expect(parseSchedule('30m')).toEqual({ kind: 'relative', offsetMs: 30 * 60_000 });
  });
  test('parses relative duration "2h"', () => {
    expect(parseSchedule('2h')).toEqual({ kind: 'relative', offsetMs: 2 * 3_600_000 });
  });
  test('parses relative duration "1d"', () => {
    expect(parseSchedule('1d')).toEqual({ kind: 'relative', offsetMs: 86_400_000 });
  });
  test('parses interval "every 2h"', () => {
    expect(parseSchedule('every 2h')).toEqual({ kind: 'interval', intervalMs: 2 * 3_600_000 });
  });
  test('parses cron expression "0 9 * * *"', () => {
    expect(parseSchedule('0 9 * * *')).toEqual({ kind: 'cron', expression: '0 9 * * *' });
  });
  test('parses ISO timestamp', () => {
    const iso = '2026-05-22T17:00:00Z';
    expect(parseSchedule(iso)).toEqual({ kind: 'iso', runAt: Date.parse(iso) });
  });
  test('throws on empty input', () => {
    expect(() => parseSchedule('')).toThrow();
  });
  test('throws on unparseable input', () => {
    expect(() => parseSchedule('flibberty')).toThrow();
  });
});

describe('computeNextRun', () => {
  const now = Date.parse('2026-05-22T12:00:00Z');
  test('relative: returns now + offset on first run', () => {
    const sched = { kind: 'relative' as const, offsetMs: 30 * 60_000 };
    expect(computeNextRun(sched, null, now)).toBe(now + 30 * 60_000);
  });
  test('relative: returns null after first run (one-shot)', () => {
    const sched = { kind: 'relative' as const, offsetMs: 30 * 60_000 };
    expect(computeNextRun(sched, now, now + 60_000)).toBeNull();
  });
  test('interval: returns lastRun + intervalMs', () => {
    const sched = { kind: 'interval' as const, intervalMs: 60_000 };
    expect(computeNextRun(sched, now, now + 30_000)).toBe(now + 60_000);
  });
  test('cron: returns next fire after now', () => {
    const sched = { kind: 'cron' as const, expression: '0 9 * * *' };
    const result = computeNextRun(sched, null, now);
    expect(result).toBe(Date.parse('2026-05-23T09:00:00Z'));
  });
  test('iso: returns runAt on first run', () => {
    const target = Date.parse('2026-05-22T17:00:00Z');
    const sched = { kind: 'iso' as const, runAt: target };
    expect(computeNextRun(sched, null, now)).toBe(target);
  });
  test('iso: returns null after first run', () => {
    const target = Date.parse('2026-05-22T17:00:00Z');
    const sched = { kind: 'iso' as const, runAt: target };
    expect(computeNextRun(sched, target, target + 60_000)).toBeNull();
  });
});
