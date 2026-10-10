import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fallbackModelCatalog, findModel } from '@yevgetman/sov-sdk/providers/models/index';
import { diskModelCache } from '../../src/cli/modelDiscovery.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildServerCommandContext } from '../../src/server/commandContext.js';
import { buildRuntime } from '../../src/server/runtime.js';

for (const scenario of ['growing', 'image', 'explicit-effort', 'session-effort'] as const)
  test(`gateway model evidence ${scenario}`, async () => {
    const rejectImage = scenario === 'image';
    const rejectEffort = scenario.endsWith('effort');
    const window = rejectEffort ? 128_000 : 8_000_000;
    const home = mkdtempSync(join(tmpdir(), 'turn-model-evidence-'));
    const previous = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = home;
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'vendor/future',
    });
    let compactCalls = 0;
    try {
      const original = runtime.resolvedProvider.transport;
      runtime.resolvedProvider.transport = Object.assign(
        Object.create(Object.getPrototypeOf(original)),
        original,
        { name: 'openrouter' },
      );
      runtime.resolvedProvider.contextLength = 128_000;
      runtime.toolPool.splice(0);
      runtime.systemSegments.splice(0);
      runtime.compact = async () => {
        compactCalls += 1;
        throw new Error('Unexpected paid compaction');
      };
      const fallback = fallbackModelCatalog('openrouter-api');
      const fetchedAt = new Date().toISOString();
      await diskModelCache(join(home, 'model-catalog')).set('openrouter-api:public', {
        ...fallback,
        state: 'current',
        fetchedAt,
        models: [
          {
            ...findModel(fallback, 'vendor/future'),
            contextWindow: window,
            maxOutputTokens: 4000,
            capabilities: {
              textOutput: 'supported',
              tools: 'supported',
              images: 'unsupported',
              reasoning: rejectEffort ? 'unsupported' : 'unknown',
            },
            metadata: { source: 'fixture', stale: false, fetchedAt },
          },
        ],
      });
      const app = buildAppWithRuntime(runtime);
      const { sessionId } = (await (await app.request('/sessions', { method: 'POST' })).json()) as {
        sessionId: string;
      };
      if (scenario === 'session-effort') runtime.getSessionContext(sessionId).effort = 'high';
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [
          { type: 'text', text: 'x'.repeat(200_000) },
          ...(rejectImage
            ? [
                {
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: 'image/png', data: 'AA==' },
                },
              ]
            : []),
        ],
      });
      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Continue',
          ...(scenario === 'explicit-effort' ? { effort: 'high' } : {}),
        }),
      });
      const events = await (await app.request(`/sessions/${sessionId}/events`)).text();
      expect(compactCalls).toBe(0);
      expect(events).toContain(rejectImage || rejectEffort ? 'turn_error' : 'turn_complete');
      if (rejectImage) expect(events).toContain('image');
      if (rejectEffort) expect(events).toContain('effort');
      expect(runtime.getSessionContext(sessionId).modelBudget).toMatchObject({
        provider: 'openrouter',
        model: 'vendor/future',
        contextTokens: window,
      });
      expect(runtime.resolvedProvider.contextLength).toBe(128_000);
      expect(
        buildServerCommandContext(
          runtime,
          runtime.getSessionContext(sessionId),
          sessionId,
        ).ctx.getBudgetReport().totals.window,
      ).toBe(window);
    } finally {
      await runtime.dispose();
      if (previous === undefined) Reflect.deleteProperty(process.env, 'HARNESS_HOME');
      else process.env.HARNESS_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
