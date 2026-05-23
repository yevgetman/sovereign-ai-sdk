// Delivery abstraction. Routes the 'local' target to the outbox filesystem.
// Future adapters register here when Phase 16.5+ channel adapters land.
//
// Phase 17: `[SILENT]` prefix short-circuits delivery (returns silent:true,
// writes nothing). When invoked from cron with `cronJobId`, writes to
// `<harnessHome>/cron/outbox/<cronJobId>/` instead of the free-form local
// outbox.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHarnessHome } from '../config/paths.js';
import type { DeliveryResult } from './types.js';

const SILENT_PREFIX = '[silent]';

export type SendOptions = {
  cronJobId?: string;
};

export async function send(
  target: string,
  content: string,
  harnessHome: string = resolveHarnessHome(),
  options: SendOptions = {},
): Promise<DeliveryResult> {
  // [SILENT] prefix: short-circuit before any delivery. Intent is "don't
  // deliver anywhere" — target is irrelevant.
  const trimmed = content.trimStart();
  if (trimmed.toLowerCase().startsWith(SILENT_PREFIX)) {
    return { ok: true, silent: true };
  }

  if (target !== 'local') {
    return { ok: false, error: `unknown delivery target: ${target}` };
  }

  try {
    const outboxDir = options.cronJobId
      ? join(harnessHome, 'cron', 'outbox', options.cronJobId)
      : join(harnessHome, 'outbox', 'local');
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(join(outboxDir, `${Date.now()}.txt`), content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
