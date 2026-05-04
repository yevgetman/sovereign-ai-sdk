import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConsentChecker, buildFileConsentStore, consentKey } from '../../src/hooks/consent.js';
import type { AskResponse, AskUser } from '../../src/permissions/types.js';

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
    const check = buildConsentChecker({ store: store, ask: asker.ask });

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
    const check = buildConsentChecker({ store: store, ask: asker.ask });

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
    const check = buildConsentChecker({ store: store, ask: asker.ask });

    expect(await check('PreToolUse', '/x.sh')).toBe('deny');
    expect(await check('PreToolUse', '/x.sh')).toBe('deny');
    expect(asker.calls).toBe(1);

    rmSync(path, { force: true });
  });

  test('always answer is treated the same as allow (file is the always record)', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker(['always']);
    const check = buildConsentChecker({ store: store, ask: asker.ask });

    expect(await check('PreToolUse', '/x.sh')).toBe('allow');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.decisions['PreToolUse:/x.sh']).toBe('allow');

    rmSync(path, { force: true });
  });

  test('moving a hook to a different event re-prompts', async () => {
    const path = tmpFile();
    const store = buildFileConsentStore(path);
    const asker = scriptAsker(['allow', 'deny']);
    const check = buildConsentChecker({ store: store, ask: asker.ask });

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
});
