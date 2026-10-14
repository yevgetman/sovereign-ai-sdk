import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGptSubscriptionProvider } from '@yevgetman/sov-sdk/providers/chatgpt';
import { getRoute } from '@yevgetman/sov-sdk/providers/routes/index';
import type { Transport } from '@yevgetman/sov-sdk/providers/types';
import { runSdkRunCommand } from '../../src/cli/sdkRunCommand.js';
import type { SdkRunDependencies } from '../../src/cli/sdkRunCommand.js';
import { buildRuntime } from '../../src/server/runtime.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
for (const partial of [false, true]) {
  test(`native subscription wire retains ${partial ? 'incomplete' : 'pre-delivery'} stream diagnostic`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'sdk-stream-delivery-'));
    homes.push(home);
    let calls = 0;
    const provider = new ChatGptSubscriptionProvider({
      port: {
        read: async () => ({
          accessToken: 'fake-secret',
          refreshToken: 'fake-refresh',
          expiresAt: 1e15,
        }),
        write: async () => {},
        delete: async () => {},
      },
      fetchImpl: async () => {
        calls++;
        return new Response(
          partial
            ? 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
            : ': heartbeat\n\n',
        );
      },
      deps: { sleep: async () => {}, random: () => 0, now: () => 0 },
    });
    const resolve: NonNullable<SdkRunDependencies['resolve']> = async () => ({
      route: getRoute('chatgpt-subscription', {}),
      model: 'gpt-5.3-codex',
      effort: 'high',
      provider,
      resolved: {
        // Native runtime uses the injected provider; no transport normalization runs.
        transport: provider as unknown as Transport,
        client: provider,
        baseUrl: 'mock://',
        model: 'gpt-5.3-codex',
        contextLength: 200000,
        authType: 'oauth',
        metadata: { provider: 'chatgpt', apiMode: 'responses', purpose: 'main' },
      },
    });
    const runtime: NonNullable<SdkRunDependencies['runtime']> = (opts) =>
      buildRuntime({
        ...opts,
        harnessHome: home,
        dbPath: join(home, 'sessions.db'),
        cronEnabled: false,
        settings: {
          learning: {
            disabled: true,
            recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 },
          },
          review: { disabled: true },
        },
      });
    const events: Record<string, unknown>[] = [];
    const code = await runSdkRunCommand(
      {
        json: true,
        stdin: true,
        route: 'chatgpt-subscription',
        inputFormat: 'json',
        toolset: 'chat',
      },
      {
        readStdin: async () => JSON.stringify({ inputVersion: 1, text: 'fixture' }),
        writeStdout: (data) => {
          events.push(JSON.parse(data));
        },
      },
      { resolve, runtime },
    );
    expect(code).toBe(1);
    expect(calls).toBe(partial ? 1 : 3);
    expect(events.filter((e) => e.type === 'turn.error')).toHaveLength(1);
    expect(events.find((e) => e.type === 'turn.error')).toMatchObject({
      code: 'provider_failed',
      deliveryPhase: partial ? 'incomplete_delivery' : 'before_delivery',
      deliveryReason: 'premature_eof',
      recoverable: false,
    });
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(partial ? 1 : 0);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('fake-secret');
  });
}
