import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('gateway conduct binding', () => {
  test('the gateway does not import decorum', () => {
    const source = readFileSync(
      new URL('../../src/cli/gatewayCommand.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('@yevgetman/decorum');
    expect(source).not.toContain('createDecorumAdapter');
    expect(source).toContain('DECORUM_RETIRED');
  });
});
