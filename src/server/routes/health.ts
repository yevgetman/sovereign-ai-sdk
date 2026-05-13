// GET /health — liveness check. Returns ok=true and the package version.
// No auth, no side effects.

import { Hono } from 'hono';

const VERSION: string = process.env.SOV_VERSION ?? '0.0.1';

export const healthRoute = new Hono();

healthRoute.get('/health', (c) => c.json({ ok: true, version: VERSION }));
