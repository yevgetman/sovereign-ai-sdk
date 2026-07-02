import { describe, expect, test } from 'bun:test';
import { SettingsSchema } from '@yevgetman/sov-sdk/config/schema';

describe('settings.review block', () => {
  test('accepts all fields including childReviewEveryN and minIntervalMs', () => {
    const parsed = SettingsSchema.parse({
      review: {
        autoPromoteMemory: true,
        autoPromoteSkills: false,
        userTurnsForMemoryReview: 5,
        toolIterationsForSkillReview: 30,
        childReviewEveryN: 2,
        minIntervalMs: 15000,
        disabled: false,
      },
    });
    expect(parsed.review?.autoPromoteMemory).toBe(true);
    expect(parsed.review?.autoPromoteSkills).toBe(false);
    expect(parsed.review?.userTurnsForMemoryReview).toBe(5);
    expect(parsed.review?.toolIterationsForSkillReview).toBe(30);
    expect(parsed.review?.childReviewEveryN).toBe(2);
    expect(parsed.review?.minIntervalMs).toBe(15000);
    expect(parsed.review?.disabled).toBe(false);
  });

  test('block is optional and defaults to undefined', () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.review).toBeUndefined();
  });

  test('rejects negative thresholds', () => {
    expect(() => SettingsSchema.parse({ review: { userTurnsForMemoryReview: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ review: { toolIterationsForSkillReview: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ review: { childReviewEveryN: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ review: { childReviewEveryN: -5 } })).toThrow();
  });

  test('rejects negative minIntervalMs', () => {
    expect(() => SettingsSchema.parse({ review: { minIntervalMs: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ review: { minIntervalMs: 0 } })).toThrow();
  });

  test('rejects unknown fields (strict)', () => {
    expect(() => SettingsSchema.parse({ review: { unknownField: true } })).toThrow();
  });
});
