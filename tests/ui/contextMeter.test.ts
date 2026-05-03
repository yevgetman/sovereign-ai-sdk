// ContextMeter — math, zone thresholds, one-shot warn, reset behavior.

import { describe, expect, test } from 'bun:test';
import { ContextMeter } from '../../src/ui/contextMeter.js';

describe('ContextMeter', () => {
  test('rejects non-positive contextLength', () => {
    expect(() => new ContextMeter({ contextLength: 0 })).toThrow();
    expect(() => new ContextMeter({ contextLength: -1 })).toThrow();
    expect(() => new ContextMeter({ contextLength: Number.NaN })).toThrow();
  });

  test('rejects danger threshold below warn', () => {
    expect(
      () => new ContextMeter({ contextLength: 1000, warnAtPercent: 80, dangerAtPercent: 50 }),
    ).toThrow();
  });

  test('starts at 0% with no usage', () => {
    const m = new ContextMeter({ contextLength: 10000 });
    expect(m.getPercent()).toBe(0);
    expect(m.getZone()).toBe('ok');
  });

  test('combines input + cache_read + output toward total', () => {
    const m = new ContextMeter({ contextLength: 1000 });
    m.update({ inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 300 });
    // 600 / 1000 → 60%
    expect(m.getPercent()).toBe(60);
  });

  test('clamps percent at 100', () => {
    const m = new ContextMeter({ contextLength: 1000 });
    m.update({ inputTokens: 5000 });
    expect(m.getPercent()).toBe(100);
  });

  test('zone transitions follow thresholds', () => {
    const m = new ContextMeter({
      contextLength: 1000,
      warnAtPercent: 60,
      dangerAtPercent: 80,
    });
    m.update({ inputTokens: 500 });
    expect(m.getZone()).toBe('ok');
    m.update({ inputTokens: 600 });
    expect(m.getZone()).toBe('warn');
    m.update({ inputTokens: 800 });
    expect(m.getZone()).toBe('danger');
  });

  test('shouldWarnApproachingCompaction fires once at trigger-5%', () => {
    const m = new ContextMeter({ contextLength: 1000 });
    // threshold 80 → trigger at 75
    m.update({ inputTokens: 700 });
    expect(m.shouldWarnApproachingCompaction(80)).toBe(false);
    m.update({ inputTokens: 760 });
    expect(m.shouldWarnApproachingCompaction(80)).toBe(true);
    // does not fire again
    expect(m.shouldWarnApproachingCompaction(80)).toBe(false);
    m.update({ inputTokens: 900 });
    expect(m.shouldWarnApproachingCompaction(80)).toBe(false);
  });

  test('reset() re-arms the warn flag and clears counters', () => {
    const m = new ContextMeter({ contextLength: 1000 });
    m.update({ inputTokens: 800 });
    m.shouldWarnApproachingCompaction(80);
    m.reset();
    expect(m.getPercent()).toBe(0);
    m.update({ inputTokens: 800 });
    expect(m.shouldWarnApproachingCompaction(80)).toBe(true);
  });

  test('getThresholds returns the effective warn/danger percentages', () => {
    const m = new ContextMeter({ contextLength: 1000, warnAtPercent: 50, dangerAtPercent: 75 });
    expect(m.getThresholds()).toEqual({ warn: 50, danger: 75 });
  });

  test('uses defaults when thresholds are not provided', () => {
    const m = new ContextMeter({ contextLength: 1000 });
    expect(m.getThresholds()).toEqual({ warn: 60, danger: 80 });
  });

  test('partial updates do not lose previous values', () => {
    const m = new ContextMeter({ contextLength: 1000 });
    m.update({ inputTokens: 100 });
    m.update({ outputTokens: 50 });
    expect(m.getTokens()).toBe(150);
  });
});
