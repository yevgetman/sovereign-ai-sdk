import { describe, expect, test } from 'bun:test';
import { formatMaxTokensWarning, suggestHigherMaxTokens } from '../../src/ui/terminalMessages.js';

describe('terminal max-token messages', () => {
  test('suggestHigherMaxTokens rounds a larger budget to the next thousand', () => {
    expect(suggestHigherMaxTokens(12000)).toBe(18000);
    expect(suggestHigherMaxTokens(4096)).toBe(7000);
  });

  test('formatMaxTokensWarning includes resume guidance and quotes bundle paths', () => {
    const warning = formatMaxTokensWarning({
      maxTokens: 12000,
      sessionId: 'session-1',
      bundlePath: '/tmp/path with spaces/bundle',
    });

    expect(warning).toContain('[max tokens]');
    expect(warning).toContain('--resume session-1');
    expect(warning).toContain("--bundle '/tmp/path with spaces/bundle'");
    expect(warning).toContain('--max-tokens 18000');
    expect(warning).toContain('FileWrite/FileEdit');
  });
});
