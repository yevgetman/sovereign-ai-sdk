// Live conformance probe (T5-live) for the `manifest` model-router lane against a
// RUNNING router (a self-hosted Manifest instance by default).
//
// Gated OFF unless BOTH MANIFEST_LIVE=1 and MANIFEST_API_KEY are set — skipped
// cleanly otherwise, exactly like sov.live.test.ts (SOV_ENGINE_URL). Optionally
// MANIFEST_BASE_URL overrides the loopback default (http://localhost:2099/v1).
//
//   MANIFEST_LIVE=1 MANIFEST_API_KEY=mnfst_... bun test tests/providers/router.live.test.ts
//
// It proves the lane end-to-end against the real router wire: a single tiny
// `model: "auto"` turn completes with assistant text, and — best-effort — that
// the route-report seam surfaces a ResolvedRoute when the router emits its
// X-Manifest-* response headers. The header report is NOT hard-required: a proxy
// deployment may strip those headers, so the probe asserts the route's SHAPE only
// when one was observed, and logs what it saw either way. The offline tests in
// router.test.ts model the same wire with a fake fetch.

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, ContentBlock, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { type ResolvedRoute, RouterProvider } from '@yevgetman/sov-sdk/providers/router';

const LIVE = process.env.MANIFEST_LIVE === '1';
const KEY = process.env.MANIFEST_API_KEY;
const BASE = process.env.MANIFEST_BASE_URL ?? 'http://localhost:2099/v1';
// Both the flag and a key are required — otherwise skip (no live router to hit).
const live = LIVE && KEY ? test : test.skip;

async function drain(
  gen: AsyncGenerator<StreamEvent, AssistantMessage>,
): Promise<{ yielded: StreamEvent[]; returned: AssistantMessage }> {
  const yielded: StreamEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { yielded, returned: step.value };
    yielded.push(step.value);
  }
}

const find = <T extends ContentBlock['type']>(blocks: ContentBlock[], type: T) =>
  blocks.find((b): b is Extract<ContentBlock, { type: T }> => b.type === type);

// Only include apiKey when KEY is set (the gating guarantees it is, but the
// conditional spread also satisfies exactOptionalPropertyTypes without a cast —
// the sov.live.test.ts idiom).
const makeRouter = (onRouteResolved: (route: ResolvedRoute) => void) =>
  new RouterProvider({ ...(KEY ? { apiKey: KEY } : {}), baseURL: BASE, onRouteResolved });

describe('RouterProvider — live router (gated on MANIFEST_LIVE + MANIFEST_API_KEY)', () => {
  live(
    'routes a model:"auto" turn and reports the resolved route when headers are present',
    async () => {
      const observed: ResolvedRoute[] = [];
      const router = makeRouter((route) => {
        observed.push(route);
      });

      const { returned } = await drain(
        router.stream({
          model: 'auto',
          system: [],
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'Reply with the single word: ok.' }],
            },
          ],
          maxTokens: 32,
        }),
      );

      // The routed turn completed with assistant text.
      const text = find(returned.content, 'text');
      expect(text?.text.length ?? 0).toBeGreaterThan(0);

      // Route reporting is BEST-EFFORT: a proxy deployment may strip the
      // X-Manifest-* headers. Assert the ResolvedRoute SHAPE only when one was
      // observed (at least one populated field); log what was seen either way.
      if (observed.length > 0) {
        const route = observed[0] as ResolvedRoute;
        const populated = [route.model, route.provider, route.tier, route.reason].filter(
          (v) => v !== undefined,
        );
        expect(populated.length).toBeGreaterThan(0);
        console.log('[router.live] observed route:', JSON.stringify(route));
      } else {
        console.log('[router.live] no X-Manifest-* route headers observed (proxy may strip them)');
      }
    },
    120_000,
  );
});
