// Delivery abstraction. Routes the 'local' target to the outbox filesystem.
// Future adapters register here when Phase 16.5+ channel adapters land.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHarnessHome } from '../config/paths.js';
import type { DeliveryResult } from './types.js';

export async function send(
  target: string,
  content: string,
  harnessHome: string = resolveHarnessHome(),
): Promise<DeliveryResult> {
  if (target !== 'local') {
    return { ok: false, error: `unknown delivery target: ${target}` };
  }
  try {
    const outboxDir = join(harnessHome, 'outbox', 'local');
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(join(outboxDir, `${Date.now()}.txt`), content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
