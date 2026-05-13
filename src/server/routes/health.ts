// GET /health — liveness check. Returns ok=true and the package version.
// No auth, no side effects.

import { Hono } from 'hono';
import { VERSION as PKG_VERSION } from '../../version.js';

const VERSION: string = process.env.SOV_VERSION ?? PKG_VERSION;

export const healthRoute = new Hono();

healthRoute.get('/health', (c) => c.json({ ok: true, version: VERSION }));
