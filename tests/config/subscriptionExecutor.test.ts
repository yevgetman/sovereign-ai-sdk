// Spike — `subscriptionExecutor` config block validation. Pins the
// strict-mode behavior, the off-by-default (absent-parent) gotcha, and the
// enum coverage — including that `permissionMode` accepts `bypass` (the
// default → `--dangerously-skip-permissions` for the attended,
// interactive-only executor) while the Claude-CLI spelling
// `bypassPermissions` is NOT a valid config token.

import { describe, expect, test } from 'bun:test';
import { SettingsSchema } from '@yevgetman/sov-sdk/config/schema';

describe('SettingsSchema — subscriptionExecutor block', () => {
  test('absent block parses (off by default) — empty config does not enable it', () => {
    const parsed = SettingsSchema.parse({});
    // The whole point of the spike's off-by-default posture: an empty config
    // must not carry an enabled subscriptionExecutor. The block is absent.
    expect(parsed.subscriptionExecutor).toBeUndefined();
  });

  test('accepts a fully-specified block', () => {
    const parsed = SettingsSchema.parse({
      subscriptionExecutor: {
        enabled: true,
        engine: 'claude-code',
        binary: 'claude',
        permissionMode: 'plan',
        timeoutMs: 120_000,
        maxTurns: 8,
      },
    });
    expect(parsed.subscriptionExecutor?.enabled).toBe(true);
    expect(parsed.subscriptionExecutor?.engine).toBe('claude-code');
    expect(parsed.subscriptionExecutor?.permissionMode).toBe('plan');
  });

  test('accepts an empty block (all fields optional)', () => {
    const parsed = SettingsSchema.parse({ subscriptionExecutor: {} });
    expect(parsed.subscriptionExecutor).toEqual({});
    // enabled is undefined — the runtime treats absent as false.
    expect(parsed.subscriptionExecutor?.enabled).toBeUndefined();
  });

  test('permissionMode accepts all four modes incl. the default bypass', () => {
    for (const mode of ['plan', 'acceptEdits', 'default', 'bypass'] as const) {
      expect(() =>
        SettingsSchema.parse({ subscriptionExecutor: { permissionMode: mode } }),
      ).not.toThrow();
    }
  });

  test('permissionMode rejects unknown tokens (incl. the Claude-CLI `bypassPermissions` spelling)', () => {
    // The harness token is `bypass` (→ --dangerously-skip-permissions); the
    // Claude-CLI spelling `bypassPermissions` is NOT a valid config value, and
    // neither is any other unknown string.
    expect(() =>
      SettingsSchema.parse({
        subscriptionExecutor: { permissionMode: 'bypassPermissions' },
      }),
    ).toThrow();
    expect(() =>
      SettingsSchema.parse({ subscriptionExecutor: { permissionMode: 'whatever' } }),
    ).toThrow();
  });

  test('engine enum rejects unknown engines', () => {
    expect(() =>
      SettingsSchema.parse({ subscriptionExecutor: { engine: 'gemini-cli' } }),
    ).toThrow();
  });

  test('rejects unknown nested keys (strict)', () => {
    expect(() => SettingsSchema.parse({ subscriptionExecutor: { unknown: true } })).toThrow();
  });

  test('timeoutMs and maxTurns must be positive integers', () => {
    expect(() => SettingsSchema.parse({ subscriptionExecutor: { timeoutMs: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ subscriptionExecutor: { timeoutMs: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ subscriptionExecutor: { maxTurns: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ subscriptionExecutor: { maxTurns: 1.5 } })).toThrow();
  });
});
