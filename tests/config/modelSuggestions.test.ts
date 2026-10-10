import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PickerOpenConfig } from '@yevgetman/sov-sdk/commands/types';
import { writeConfig } from '@yevgetman/sov-sdk/config/store';
import { fallbackModelCatalog, findModel } from '@yevgetman/sov-sdk/providers/models/index';
import { diskModelCache } from '../../src/cli/modelDiscovery.js';
import { dispatchConfigCommand } from '../../src/commands/configOps.js';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import { findItem } from '../../src/config/catalog.js';
import { providerModelCatalog } from '../../src/config/modelSuggestions.js';
import { makeCtx } from '../commands/_makeCtx.js';

let root: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.HARNESS_HOME;
  root = mkdtempSync(join(tmpdir(), 'shared-model-menu-'));
  process.env.HARNESS_HOME = root;
  const catalog = fallbackModelCatalog('openrouter-api');
  await diskModelCache(join(root, 'model-catalog')).set('openrouter-api:public', {
    ...catalog,
    state: 'current',
    fetchedAt: new Date().toISOString(),
    models: ['vendor-a/new-model', 'vendor-b/future-model'].map((id) => ({
      ...findModel(catalog, id),
      author: id.split('/')[0],
      contextWindow: 8_000_000,
      efforts: ['off', 'high'],
      metadata: { source: 'fixture', fetchedAt: new Date().toISOString(), stale: false },
    })),
  });
  writeConfig({ defaultProvider: 'openrouter', defaultModel: 'missing/current-model' });
});
afterEach(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, 'HARNESS_HOME');
  else process.env.HARNESS_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});

test('config, lanes and model picker share a catalog without reseating missing current IDs', async () => {
  let picker: PickerOpenConfig | undefined;
  const selected: string[] = [];
  const ctx = makeCtx({
    providerName: 'openrouter',
    model: 'missing/current-model',
    setModel: (value) => selected.push(value),
    requestPicker: (value) => {
      picker = value;
    },
  });
  await dispatchSlashCommand('/model', ctx);
  expect(picker?.title).toBe('model author');
  expect(picker?.items.some((item) => item.label === 'missing')).toBe(true);
  expect(selected).toEqual([]);
  await dispatchSlashCommand('/model --author vendor-b', ctx);
  expect(picker?.items.some((item) => item.value === 'vendor-b/future-model')).toBe(true);
  expect(picker?.items.find((item) => item.value === 'vendor-b/future-model')?.hint).toContain(
    'context:8000000',
  );
  await dispatchConfigCommand('edit defaultModel --author vendor-b', ctx);
  expect(picker?.onSelect.command).toBe('config set defaultModel');
  expect(picker?.items.some((item) => item.value === 'vendor-b/future-model')).toBe(true);
  const lane = findItem('taskRouting.lanes.cheap-task.model');
  if (lane?.editor.kind !== 'string') throw Error('missing model editor');
  expect(
    lane.editor.dynamicChoices?.({
      taskRouting: {
        enabled: false,
        delegator: { model: 'unused' },
        trivialFastPath: false,
        lanes: { 'cheap-task': { provider: 'openrouter' } },
      },
    }),
  ).toEqual(providerModelCatalog('openrouter').models.map((model) => model.id));
});

test('search and explicit custom selection preserve route and unknown current metadata', async () => {
  let picker: PickerOpenConfig | undefined;
  const selected: string[] = [];
  const ctx = makeCtx({
    providerName: 'openrouter',
    model: 'missing/current-model',
    setModel: (value) => selected.push(value),
    requestPicker: (value) => {
      picker = value;
    },
  });
  await dispatchSlashCommand('/model --search future', ctx);
  expect(
    picker?.items.filter((item) => item.value !== '--custom').map((item) => item.value),
  ).toEqual(['vendor-b/future-model']);
  await dispatchSlashCommand('/model exact/custom-2040', ctx);
  expect(selected).toEqual(['exact/custom-2040']);
  expect(ctx.providerName).toBe('openrouter');
  await dispatchSlashCommand('/model --author %', ctx);
  expect(selected).toEqual(['exact/custom-2040']);
});
