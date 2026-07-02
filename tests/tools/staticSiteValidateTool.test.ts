// StaticSiteValidateTool tests — missing local references, JS syntax, and
// read-only permission behavior for static website artifacts.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StaticSiteValidateTool,
  validateStaticSite,
} from '@yevgetman/sov-sdk/tools/StaticSiteValidateTool';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-static-site-tool-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeCtx(cwd: string) {
  return { cwd, bundleRoot: cwd, sessionId: 'static-site-tool-test' };
}

describe('StaticSiteValidateTool', () => {
  test('passes a complete static site with referenced JavaScript', async () => {
    await withTmp(async (dir) => {
      writeFileSync(
        join(dir, 'index.html'),
        '<!doctype html><link rel="stylesheet" href="style.css"><script src="app.js"></script>',
      );
      writeFileSync(join(dir, 'style.css'), 'body { color: green; }');
      writeFileSync(join(dir, 'app.js'), 'const ok = true;\n');

      const result = await StaticSiteValidateTool.call({ path: dir }, makeCtx(dir));

      expect(result.data.ok).toBe(true);
      expect(result.data.checks.find((check) => check.name === 'local references exist')?.ok).toBe(
        true,
      );
      expect(
        result.data.checks.find((check) => check.name === 'referenced JavaScript parses')?.ok,
      ).toBe(true);
      expect(
        result.data.checks.find((check) => check.name === 'local server returns 200')?.ok,
      ).toBe(true);
    });
  });

  test('fails when a referenced local asset is missing', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'index.html'), '<!doctype html><script src="missing.js"></script>');

      const result = await StaticSiteValidateTool.call({ path: dir }, makeCtx(dir));
      const refs = result.data.checks.find((check) => check.name === 'local references exist');

      expect(result.data.ok).toBe(false);
      expect(refs?.ok).toBe(false);
      expect(refs?.details).toContain('missing.js');
    });
  });

  test('fails when referenced JavaScript has a syntax error', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'index.html'), '<!doctype html><script src="app.js"></script>');
      writeFileSync(join(dir, 'app.js'), 'const broken = ;\n');

      const result = await StaticSiteValidateTool.call({ path: dir }, makeCtx(dir));
      const js = result.data.checks.find((check) => check.name === 'referenced JavaScript parses');

      expect(result.data.ok).toBe(false);
      expect(js?.ok).toBe(false);
      expect(js?.details).toContain('app.js');
    });
  });

  // F26: an `entry` containing `../` must not escape the site root. The read
  // phase must honor the same confinement the ephemeral server phase already
  // enforces (403), so an out-of-root file is neither read nor reflected.
  test('rejects an entry that escapes the site root and does not read the out-of-root file', async () => {
    await withTmp(async (base) => {
      const site = join(base, 'site');
      mkdirSync(site);
      writeFileSync(join(site, 'index.html'), '<!doctype html>');
      // A secret file OUTSIDE the site root, containing a distinctive href token
      // that would be reflected into the checks if the file were read.
      writeFileSync(join(base, 'secret.txt'), '<a href="LEAKED-REF-EXISTS.html">x</a>');

      const checks = await validateStaticSite(site, '../secret.txt');

      const entryCheck = checks.find((check) => check.name.startsWith('entry exists'));
      expect(entryCheck?.ok).toBe(false);
      expect(entryCheck?.details).toContain('escapes site root');
      // The out-of-root file's contents must never surface in the result.
      expect(JSON.stringify(checks)).not.toContain('LEAKED-REF');
    });
  });

  test('is read-only and allowed without prompting', async () => {
    expect(StaticSiteValidateTool.isReadOnly({ path: '/tmp/site' })).toBe(true);
    expect(StaticSiteValidateTool.isConcurrencySafe({ path: '/tmp/site' })).toBe(true);
    const result = await StaticSiteValidateTool.checkPermissions(
      { path: '/tmp/site' },
      makeCtx('/tmp'),
    );
    expect(result.behavior).toBe('allow');
  });
});
