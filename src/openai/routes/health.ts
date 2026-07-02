// Phase 18 T1 — GET /health for the OpenAI-compatible API server.
// Mirrors the TUI server's /health pattern: no auth, ok=true + version.

import { Hono } from 'hono';
import { VERSION as PKG_VERSION } from '../../wrapperVersion.js';

const VERSION: string = process.env.SOV_VERSION ?? PKG_VERSION;

export const healthRoute = new Hono();

healthRoute.get('/health', (c) => c.json({ ok: true, version: VERSION }));
