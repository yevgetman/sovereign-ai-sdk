import { expect, test } from 'bun:test';
import { SubscriptionRefreshError } from '@yevgetman/sov-sdk/providers/errors';
import { runSdkRunCommand } from '../../src/cli/sdkRunCommand.js';

for (const [reason, code] of [
  ['rate_limited', 'rate_limited'],
  ['provider_unavailable', 'provider_unavailable'],
  ['connection_failure', 'provider_unavailable'],
  ['timeout', 'provider_timeout'],
  ['malformed_response', 'provider_response_invalid'],
  ['request_rejected', 'provider_request_rejected'],
] as const) {
  test(`native refresh ${reason} retains an actionable secret-safe result`, async () => {
    const events: Record<string, unknown>[] = [];
    let booted = false;
    const result = await runSdkRunCommand(
      { json: true, stdin: true, route: 'grok-subscription', model: 'grok-4.7', toolset: 'chat' },
      {
        readStdin: async () => 'question',
        writeStdout: (line) => events.push(JSON.parse(line)),
      },
      {
        resolve: async () => {
          throw new SubscriptionRefreshError('grok', reason, true, 503, 1000);
        },
        runtime: async () => {
          booted = true;
          throw new Error('runtime must not start after refresh failure');
        },
      },
    );
    expect(result).toBe(1);
    expect(booted).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'turn.error',
      code,
      refreshReason: reason,
      retryAfterMs: 1000,
    });
    expect(events[0]?.error).not.toContain('Sign in');
    expect(JSON.stringify(events)).not.toContain('accessToken');
    expect(JSON.stringify(events)).not.toContain('refreshToken');
    expect(events[0]).not.toHaveProperty('upstream');
  });
}
