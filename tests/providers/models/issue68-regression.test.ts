import { expect, test } from 'bun:test';
import { fallbackModelCatalog, findModel } from '../../../packages/sdk/src/providers/models/index';
import { getRoute, validateRouteSelection } from '../../../packages/sdk/src/providers/routes/index';

test('issue 68: Grok 4.6 has documented 500K context', () => {
  expect(findModel(fallbackModelCatalog('grok-subscription'), 'grok-4.6').contextWindow).toBe(
    500_000,
  );
});

test('issue 68: owner evidence selects an exact unbundled subscription ID', () => {
  const model = {
    ...findModel(fallbackModelCatalog('grok-subscription'), 'grok-4.7'),
    id: 'grok-owner-test',
    metadata: { source: 'owner-reviewed-test', stale: false, ownerManaged: true },
  };
  expect(
    validateRouteSelection(getRoute('grok-subscription'), {
      model: model.id,
      modelMetadata: model,
      effort: 'high',
    }).model,
  ).toBe(model.id);
});
