// Phase 18 T7 — GET /v1/models.
//
// Returns the list of models the harness can route to in OpenAI's standard
// /v1/models shape. The catalog is sourced from SUPPORTED_MODELS (defined
// in modelResolution.ts) so the list stays in lock-step with what
// resolveModelForRequest() will accept on POST /v1/chat/completions.
//
// Currently only `harness-default` is routable (the runtime's bootstrapped
// transport + model). T9 will expand the explicit-name branch — but the
// /v1/models catalog already surfaces the canonical names so OpenAI-SDK
// clients (Open WebUI, LibreChat, etc.) can pre-populate their model
// pickers with the full intended surface.
//
// Shape per entry: { id, object: 'model', created, owned_by }. We use a
// fixed `created` (0) since the harness doesn't track per-model release
// dates — any stable timestamp satisfies the OpenAI shape; clients use
// it for sort-order display only.
//
// Mounted under the /v1/* auth group in app.ts.

import { Hono } from 'hono';
import type { Runtime } from '../../server/runtime.js';
import { SUPPORTED_MODELS } from '../modelResolution.js';

export type ModelEntry = {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
};

export type ModelListResponse = {
  object: 'list';
  data: ModelEntry[];
};

const FIXED_CREATED = 0;
const OWNED_BY = 'sovereign-ai';

export function modelsRoute(_runtime: Runtime): Hono {
  const app = new Hono();

  app.get('/v1/models', (c) => {
    const data: ModelEntry[] = SUPPORTED_MODELS.map((id) => ({
      id,
      object: 'model',
      created: FIXED_CREATED,
      owned_by: OWNED_BY,
    }));
    const body: ModelListResponse = { object: 'list', data };
    return c.json(body);
  });

  return app;
}
