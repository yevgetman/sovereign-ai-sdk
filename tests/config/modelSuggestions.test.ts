import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PickerOpenConfig } from '@yevgetman/sov-sdk/commands/types';
import { readConfig, writeConfig } from '@yevgetman/sov-sdk/config/store';
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

test('node model menus and config writes use the active home without changing the ambient home', async () => {
  const node = mkdtempSync(join(tmpdir(), 'model-node-isolation-'));
  const nodeCatalog = fallbackModelCatalog('openrouter-api');
  try {
    await diskModelCache(join(node, 'model-catalog')).set('openrouter-api:public', {
      ...nodeCatalog,
      state: 'current',
      fetchedAt: new Date().toISOString(),
      models: [
        {
          ...findModel(nodeCatalog, 'node-author/node-model'),
          author: 'node-author',
          metadata: { source: 'fixture', stale: false },
        },
      ],
    });
    writeConfig(
      { defaultProvider: 'openrouter', defaultModel: 'node-author/node-model' },
      join(node, 'config.json'),
    );
    const ambientBefore = readConfig();
    let picker: PickerOpenConfig | undefined;
    const ctx = makeCtx({
      sessionId: 'model-node-isolation',
      harnessHome: node,
      providerName: 'openrouter',
      model: 'node-author/node-model',
      requestPicker: (value) => {
        picker = value;
      },
    });
    await dispatchSlashCommand('/model --search model', ctx);
    expect(
      picker?.items
        .filter((item) => item.label !== 'type custom model ID…')
        .map((item) => item.value),
    ).toEqual(['node-author/node-model']);
    await dispatchConfigCommand('edit defaultModel --search model', ctx);
    expect(
      picker?.items
        .filter((item) => item.label !== 'type custom model ID…')
        .map((item) => item.value),
    ).toEqual(['node-author/node-model']);
    await dispatchConfigCommand('set defaultModel node-author/new-model', ctx);
    expect(readConfig({ harnessHome: node }).defaultModel).toBe('node-author/new-model');
    expect(readConfig()).toEqual(ambientBefore);
    await dispatchConfigCommand('discard', ctx);
    expect(readConfig({ harnessHome: node }).defaultModel).toBe('node-author/node-model');
    expect(readConfig()).toEqual(ambientBefore);
  } finally {
    rmSync(node, { recursive: true, force: true });
  }
});

test('model menus use host-injected account settings without falling back to the ambient account', async () => {
  const { createHash } = await import('node:crypto');
  const catalog = fallbackModelCatalog('openai-api');
  const hostSettings = { providers: { openai: { apiKey: 'fixture-node-account' } } };
  const key = createHash('sha256').update('fixture-node-account').digest('hex');
  const oldKey = process.env.OPENAI_API_KEY;
  Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
  try {
    await diskModelCache(join(root, 'model-catalog')).set(`openai-api:${key}`, {
      ...catalog,
      state: 'current',
      fetchedAt: new Date().toISOString(),
      models: [
        {
          ...findModel(catalog, 'host-account-model'),
          metadata: { source: 'fixture', stale: false },
        },
      ],
    });
    let picker: PickerOpenConfig | undefined;
    const ctx = makeCtx({
      providerName: 'openai',
      model: 'host-account-model',
      harnessHome: root,
      getModelCatalogSettings: () => hostSettings,
      requestPicker: (value) => {
        picker = value;
      },
    });
    await dispatchSlashCommand('/model --search host-account', ctx);
    expect(picker?.items[0]?.value).toBe('host-account-model');
    expect(picker?.subtitle).toContain('cached metadata');
  } finally {
    if (oldKey === undefined) Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
    else process.env.OPENAI_API_KEY = oldKey;
  }
});
