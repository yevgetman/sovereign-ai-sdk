// resolveTranscriptsConfig — read-site defaults + legacy fallback (2026-06-15).

import { describe, expect, test } from 'bun:test';
import { type Settings, resolveTranscriptsConfig } from '@yevgetman/sov-sdk/config/schema';

const settings = (over: Partial<Settings> = {}): Settings => over as Settings;

describe('resolveTranscriptsConfig', () => {
  test('absent block → enabled + redactSecrets default TRUE (always-on like Claude Code)', () => {
    expect(resolveTranscriptsConfig(settings())).toEqual({ enabled: true, redactSecrets: true });
  });

  test('explicit enabled:false is honored', () => {
    expect(resolveTranscriptsConfig(settings({ transcripts: { enabled: false } }))).toMatchObject({
      enabled: false,
    });
  });

  test('explicit redactSecrets:false is honored', () => {
    expect(
      resolveTranscriptsConfig(settings({ transcripts: { redactSecrets: false } })),
    ).toMatchObject({ enabled: true, redactSecrets: false });
  });

  test('transcripts.dir wins; legacy debugMode.transcriptDir is the fallback', () => {
    expect(resolveTranscriptsConfig(settings({ transcripts: { dir: '/a' } })).dir).toBe('/a');
    expect(
      resolveTranscriptsConfig(settings({ debugMode: { transcriptDir: '/legacy' } })).dir,
    ).toBe('/legacy');
    // transcripts.dir takes precedence over the legacy field.
    expect(
      resolveTranscriptsConfig(
        settings({ transcripts: { dir: '/new' }, debugMode: { transcriptDir: '/legacy' } }),
      ).dir,
    ).toBe('/new');
  });
});
