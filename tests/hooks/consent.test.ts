import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildConsentChecker,
  buildFileConsentStore,
  consentKey,
} from '@yevgetman/sov-sdk/hooks/consent';
import type { AskResponse, AskUser } from '@yevgetman/sov-sdk/permissions/types';

function scriptAsker(queue: AskResponse[]): { ask: AskUser; calls: number } {
  let i = 0;
  let calls = 0;
  const ask: AskUser = async () => {
    calls = ++i;
    const next = queue.shift();
    if (next === undefined) throw new Error('ask called beyond scripted queue');
    return next;
  };
  return {
    ask,
    get calls() {
      return calls;
    },
  };
}

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hook-consent-'));
  return join(dir, 'allowlist.json');
}

describe('consent', () => {
  test('consentKey concatenates event and command', () => {
    expect(consentKey('PreToolUse', '/bin/true')).toBe('PreToolUse:/bin/true');
  });

  test('first-use prompts and persists allow', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker(['allow']);
    const check = buildConsentChecker({ store: store, ask: asker.ask, interactive: true });

    const decision = await check('PreToolUse', '~/bin/audit.sh');
    expect(decision).toBe('allow');
    expect(asker.calls).toBe(1);
    expect(existsSync(path)).toBe(true);

    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.version).toBe(1);
    expect(file.decisions['PreToolUse:~/bin/audit.sh']).toBe('allow');

    rmSync(path, { force: true });
  });

  test('second invocation skips the prompt for an already-allowed hook', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker(['allow']);
    const check = buildConsentChecker({ store: store, ask: asker.ask, interactive: true });

    await check('PreToolUse', '/x.sh');
    const second = await check('PreToolUse', '/x.sh');
    expect(second).toBe('allow');
    expect(asker.calls).toBe(1);

    rmSync(path, { force: true });
  });

  test('deny is persisted; subsequent calls return deny without prompting', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker(['deny']);
    const check = buildConsentChecker({ store: store, ask: asker.ask, interactive: true });

    expect(await check('PreToolUse', '/x.sh')).toBe('deny');
    expect(await check('PreToolUse', '/x.sh')).toBe('deny');
    expect(asker.calls).toBe(1);

    rmSync(path, { force: true });
  });

  test('always answer is treated the same as allow (file is the always record)', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker(['always']);
    const check = buildConsentChecker({ store: store, ask: asker.ask, interactive: true });

    expect(await check('PreToolUse', '/x.sh')).toBe('allow');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.decisions['PreToolUse:/x.sh']).toBe('allow');

    rmSync(path, { force: true });
  });

  test('moving a hook to a different event re-prompts', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker(['allow', 'deny']);
    const check = buildConsentChecker({ store: store, ask: asker.ask, interactive: true });

    expect(await check('PreToolUse', '/same.sh')).toBe('allow');
    expect(await check('PostToolUse', '/same.sh')).toBe('deny');
    expect(asker.calls).toBe(2);

    rmSync(path, { force: true });
  });

  test('store reads existing decisions from a pre-populated file', () => {
    const path = tmpFile();
    const fixture = {
      version: 1,
      decisions: { 'PreToolUse:/preset.sh': 'allow' as const },
    };
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

    const store = buildFileConsentStore(path);
    expect(store.read('PreToolUse', '/preset.sh')).toBe('allow');
    expect(store.read('PreToolUse', '/unknown.sh')).toBeUndefined();

    rmSync(path, { force: true });
  });

  test('store survives a corrupt allowlist file (treats as empty)', () => {
    const path = tmpFile();
    writeFileSync(path, '{this is not json', 'utf8');
    const store = buildFileConsentStore(path);
    expect(store.read('PreToolUse', '/x.sh')).toBeUndefined();
    rmSync(path, { force: true });
  });

  // FIX 1 — a non-interactive (environment) auto-deny must NOT be persisted as
  // a user decision. The default (no `interactive` flag) is the non-interactive
  // posture the runtime wires (`ask: () => 'deny'`).
  test('non-interactive auto-deny returns skip and writes NO row', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker([]); // non-interactive: ask is never reached
    const check = buildConsentChecker({ store, ask: asker.ask });

    const decision = await check('PreToolUse', '/x.sh');
    expect(decision).toBe('skip');
    // No file written — there was no genuine user decision to record.
    expect(existsSync(path)).toBe(false);
    expect(asker.calls).toBe(0);

    rmSync(path, { force: true });
  });

  test('non-interactive auto-deny re-evaluates every time (never sticks)', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker([]); // non-interactive short-circuits BEFORE asking
    const check = buildConsentChecker({ store, ask: asker.ask });

    expect(await check('PreToolUse', '/x.sh')).toBe('skip');
    expect(await check('PreToolUse', '/x.sh')).toBe('skip');
    // The asker is never consulted (no interactive prompt) and the transient
    // skip is never cached — so a later genuine consent can still take effect.
    expect(asker.calls).toBe(0);
    expect(existsSync(path)).toBe(false);

    rmSync(path, { force: true });
  });

  test('interactive deny IS persisted as a genuine user decision', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker(['deny']);
    const check = buildConsentChecker({ store, ask: asker.ask, interactive: true });

    expect(await check('PreToolUse', '/x.sh')).toBe('deny');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.decisions['PreToolUse:/x.sh']).toBe('deny');
    // Persisted: the second call short-circuits without re-asking.
    expect(await check('PreToolUse', '/x.sh')).toBe('deny');
    expect(asker.calls).toBe(1);

    rmSync(path, { force: true });
  });

  test('interactive allow IS persisted', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker(['allow']);
    const check = buildConsentChecker({ store, ask: asker.ask, interactive: true });

    expect(await check('PreToolUse', '/x.sh')).toBe('allow');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.decisions['PreToolUse:/x.sh']).toBe('allow');

    rmSync(path, { force: true });
  });

  test('a previously persisted deny still short-circuits even when non-interactive', async () => {
    const path = tmpFile();
    // Pre-populate a genuine user deny.
    writeFileSync(
      path,
      `${JSON.stringify({ version: 1, decisions: { 'PreToolUse:/x.sh': 'deny' } }, null, 2)}\n`,
      'utf8',
    );
    const store = buildFileConsentStore(path);
    const asker = scriptAsker([]); // must never be called
    const check = buildConsentChecker({ store, ask: asker.ask });

    expect(await check('PreToolUse', '/x.sh')).toBe('deny');
    expect(asker.calls).toBe(0);

    rmSync(path, { force: true });
  });
});
