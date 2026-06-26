// Documentation default-value sync checks.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readRepoFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function extractDefaultMaxTokens(source: string): string {
  const match = source.match(/const DEFAULT_MAX_TOKENS = (\d+);/);
  if (!match) throw new Error('DEFAULT_MAX_TOKENS not found in src/main.ts');
  return match[1] ?? '';
}

describe('documentation defaults', () => {
  test('max-token default matches the CLI constant', () => {
    const defaultMaxTokens = extractDefaultMaxTokens(readRepoFile('src/main.ts'));
    const readme = readRepoFile('README.md');
    const usage = readRepoFile('docs/03-cli-reference/usage.md');

    expect(readme).toContain(`--max-tokens <n>\` (default \`${defaultMaxTokens}\`)`);
    expect(usage).toContain(`Default: \`${defaultMaxTokens}\`.`);
    expect(readme).not.toContain('--max-tokens <n>` (default `4096`)');
    expect(usage).not.toContain('Default: `4096`.');
  });
});
