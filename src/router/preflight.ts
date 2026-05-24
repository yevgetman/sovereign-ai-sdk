// Boot-time lane preflight. Iterates every configured cost lane in the
// registry, resolves its provider, and runs the provider preflight check.
// Aggregates failures and throws a single `LanePreflightError` listing each
// failing lane so the user can fix credentials/config in one pass instead of
// playing whack-a-mole. The `delegator` lane is skipped — its provider/model
// is verified by the parent's existing preflight when their providers align
// (typically anthropic). Spec:
//   docs/specs/2026-05-23-multi-provider-task-routing-design.md

import type { LaneRegistry } from './laneRegistry.js';

export type RunLanePreflightOpts = {
  registry: LaneRegistry;
  harnessHome: string;
  resolveProvider: (
    provider: string,
    model: string,
    opts: { harnessHome: string },
  ) => Promise<{ transport: { name: string }; model: string }>;
  preflight: (opts: {
    provider: { name: string };
    providerName: string;
    model: string;
  }) => Promise<void>;
};

export class LanePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LanePreflightError';
  }
}

type LaneFailure = {
  lane: string;
  provider: string;
  model: string;
  reason: string;
};

export async function runLanePreflight(opts: RunLanePreflightOpts): Promise<void> {
  const failures: LaneFailure[] = [];
  for (const { name, config } of opts.registry.entries()) {
    // Skip delegator — its provider/model is verified by the parent's
    // existing preflight when their providers align.
    if (name === 'delegator') continue;
    try {
      const resolved = await opts.resolveProvider(config.provider, config.model, {
        harnessHome: opts.harnessHome,
      });
      await opts.preflight({
        provider: resolved.transport,
        providerName: resolved.transport.name,
        model: resolved.model,
      });
    } catch (err) {
      failures.push({
        lane: name,
        provider: config.provider,
        model: config.model,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failures.length === 0) return;
  const lines = failures.map(
    (f) => `  ${f.lane.padEnd(14)} ${f.provider}/${f.model}  — ${f.reason}`,
  );
  throw new LanePreflightError(
    `sov: cannot start with taskRouting enabled — preflight failures:\n${lines.join('\n')}\n\nSet credentials or override lanes in ~/.harness/config.json.`,
  );
}
