import type { Settings } from '@yevgetman/sov-sdk/config/schema';
/** SOV snapshots model evidence once per turn. No network or credential refresh. */
import { readConfig } from '@yevgetman/sov-sdk/config/store';
import {
  type EffectiveModelLimits,
  requestInputTokenBound,
  resolveModelLimits,
} from '@yevgetman/sov-sdk/providers/modelLimits';
import { type ModelRecord, findModel } from '@yevgetman/sov-sdk/providers/models/index';
import { estimateUsageCost, pricingSnapshotForModel } from '@yevgetman/sov-sdk/providers/pricing';
import { readModelCatalogSnapshot, routeForProvider } from '../cli/modelDiscovery.js';

export function selectedTurnModel(
  provider: string,
  model: string,
  options: {
    settings?: Settings | undefined;
    harnessHome?: string | undefined;
    maxTokens?: number | undefined;
    modelMetadata?: ModelRecord | undefined;
  } = {},
) {
  const route = routeForProvider(provider);
  if (!route) return undefined; // Custom/injected providers retain their existing contract.
  const record =
    options.modelMetadata ??
    (route
      ? findModel(
          readModelCatalogSnapshot(
            route,
            options.settings ??
              readConfig(
                options.harnessHome === undefined ? {} : { harnessHome: options.harnessHome },
              ),
            options.harnessHome,
          ),
          model,
        )
      : undefined);
  if (!record) return undefined; // Custom/injected providers retain their existing contract.
  if (record.id !== model || record.provider !== provider || record.routeId !== route)
    throw new Error('Selected model metadata belongs to another model or route');
  const metadata = structuredClone(record);
  const limits = resolveModelLimits(
    {
      ...(metadata.contextWindow !== undefined ? { contextTokens: metadata.contextWindow } : {}),
      ...(metadata.maxOutputTokens !== undefined ? { outputTokens: metadata.maxOutputTokens } : {}),
      stale: metadata.metadata.stale,
      source: metadata.metadata.source,
    },
    options.maxTokens === undefined ? {} : { outputTokens: options.maxTokens },
  );
  return { metadata, limits, pricing: pricingSnapshotForModel(metadata) };
}

/** Match SDK request accounting before invoking the paid history summarizer.
 * A system/schema-only overflow cannot improve by summarizing history. */
export function shouldCompactModelRequest(
  messages: readonly import('@yevgetman/sov-sdk/core/types').Message[],
  system: readonly import('@yevgetman/sov-sdk/core/types').SystemSegment[],
  tools: readonly import('@yevgetman/sov-sdk/providers/types').ToolSchema[],
  limits: EffectiveModelLimits,
  threshold = 0.75,
): boolean {
  const baseline = requestInputTokenBound([], system, tools);
  if (baseline >= limits.contextTokens) return false;
  const totalInput = requestInputTokenBound(messages, system, tools);
  const boundary = limits.contextTokens * threshold;
  // A ceiling that will shrink must not suppress reducible history forever,
  // or summarize every short turn. Measure occupancy of the remaining space.
  if (baseline + limits.outputTokens >= boundary)
    return totalInput >= baseline + (limits.contextTokens - baseline) * threshold;
  return totalInput + limits.outputTokens >= boundary;
}

/** The host owns billing when no SDK SessionStore is bound. One receipt per run,
 * including cancelled/truncated streams with no complete usage report. */
export function modelRunUsageWriter(
  runtime: Pick<import('./runtime.js').Runtime, 'sessionDb'>,
  sessionId: string,
  provider: string,
  model: string,
) {
  let recorded = false;
  return (
    result?: Pick<
      import('@yevgetman/sov-sdk/agent/createAgent').RunResult,
      'usage' | 'costEstimate'
    >,
  ): void => {
    if (recorded) return;
    recorded = true;
    runtime.sessionDb.recordUsageEstimate(
      sessionId,
      result?.usage ?? {},
      result?.costEstimate ??
        estimateUsageCost(provider, model, result?.usage ?? {}, {
          state: 'unknown',
          source: 'usage-unavailable',
        }),
    );
  };
}

/** Tool descriptions already travel in request schemas. For an unverified
 * window, omit that duplicate help and list only the tools this turn has.
 * Standing directives, governance, preferences and project files stay intact. */
export function modelSystemPrompt(
  system: readonly import('@yevgetman/sov-sdk/core/types').SystemSegment[],
  tools: readonly { name: string }[],
  model?: ModelRecord,
): import('@yevgetman/sov-sdk/core/types').SystemSegment[] {
  if (!model || (!model.metadata.stale && model.contextWindow !== undefined)) return [...system];
  return system.flatMap((segment) => {
    if (!segment.text.startsWith('<available-tools>\n')) return [segment];
    return tools.length === 0
      ? []
      : [
          {
            ...segment,
            text: `<available-tools>\n${tools.map((tool) => `- ${tool.name}`).join('\n')}\nTool descriptions and input schemas are supplied with the tool request.\n</available-tools>`,
          },
        ];
  });
}
