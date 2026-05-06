import { describe, expect, test } from 'bun:test';
import { SettingsSchema } from '../../src/config/schema.js';

describe('settings.review block', () => {
  test('accepts all fields', () => {
    const parsed = SettingsSchema.parse({
      review: {
        autoPromoteMemory: true,
        autoPromoteSkills: false,
        userTurnsForMemoryReview: 5,
        toolIterationsForSkillReview: 30,
        disabled: false,
      },
    });
    expect(parsed.review?.autoPromoteMemory).toBe(true);
    expect(parsed.review?.autoPromoteSkills).toBe(false);
    expect(parsed.review?.userTurnsForMemoryReview).toBe(5);
    expect(parsed.review?.toolIterationsForSkillReview).toBe(30);
    expect(parsed.review?.disabled).toBe(false);
  });

  test('block is optional and defaults to undefined', () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.review).toBeUndefined();
  });

  test('rejects negative thresholds', () => {
    expect(() => SettingsSchema.parse({ review: { userTurnsForMemoryReview: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ review: { toolIterationsForSkillReview: 0 } })).toThrow();
  });

  test('rejects unknown fields (strict)', () => {
    expect(() => SettingsSchema.parse({ review: { unknownField: true } })).toThrow();
  });
});
