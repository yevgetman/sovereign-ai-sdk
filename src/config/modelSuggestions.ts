import type { CommandContext } from '@yevgetman/sov-sdk/commands/types';
import type { Settings } from '@yevgetman/sov-sdk/config/schema';
import { readConfig } from '@yevgetman/sov-sdk/config/store';
import { PROVIDER_REGISTRY } from '@yevgetman/sov-sdk/providers/models';
import { type ModelCatalog, findModel } from '@yevgetman/sov-sdk/providers/models/index';
import { readModelCatalogSnapshot, routeForProvider } from '../cli/modelDiscovery.js';

/** Config/lane/REPL/TUI all read one current offline snapshot. */
export function providerModelCatalog(
  provider: string,
  settings: Settings = {},
  harnessHome?: string,
): ModelCatalog {
  const route = routeForProvider(provider);
  if (route) return readModelCatalogSnapshot(route, settings, harnessHome);
  const model = PROVIDER_REGISTRY[provider]?.defaultModel;
  const empty: ModelCatalog = { version: 1, routeId: provider, state: 'unavailable', models: [] };
  if (!model) return empty;
  const record = findModel(empty, model);
  return {
    ...empty,
    models: [{ ...record, provider, metadata: { source: 'bundled-suggestions', stale: true } }],
  };
}
export function modelsForProvider(
  provider: string | undefined,
  settings: Settings = {},
): readonly string[] {
  return providerModelCatalog(provider ?? 'anthropic', settings).models.map((model) => model.id);
}

import { modelAuthor as catalogModelAuthor } from '../cli/modelDiscovery.js';
export function modelAuthor(
  model: import('@yevgetman/sov-sdk/providers/models/index').ModelRecord,
): string {
  return catalogModelAuthor(model) ?? 'unattributed';
}
export function modelDetails(
  model: import('@yevgetman/sov-sdk/providers/models/index').ModelRecord,
): string {
  return `tools:${model.capabilities.tools} · images:${model.capabilities.images} · efforts:${model.efforts?.join('/') ?? 'unknown'} · context:${model.contextWindow ?? 'unknown'} · availability:${model.availability}`;
}
export function modelProviderForSetting(path: string, settings: Settings): string | undefined {
  if (path === 'defaultModel') return settings.defaultProvider ?? 'anthropic';
  const direct = /^providers\.([^.]+)\.model$/.exec(path);
  if (direct) return direct[1];
  const lane = /^taskRouting\.lanes\.([^.]+)\.model$/.exec(path);
  if (lane)
    return (
      settings.taskRouting?.lanes?.[lane[1] as 'cheap-task' | 'moderate-task' | 'frontier-task']
        ?.provider ?? 'anthropic'
    );
  return undefined;
}

/** Use the same host settings and state root as turn execution. */
export function commandModelSettings(ctx: CommandContext): Settings {
  return (
    ctx.getModelCatalogSettings?.() ??
    readConfig(ctx.harnessHome === undefined ? {} : { harnessHome: ctx.harnessHome })
  );
}
