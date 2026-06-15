// Transcript path/slug resolution + traversal containment (2026-06-15).

import { describe, expect, test } from 'bun:test';
import { resolveTranscriptPath, slugifyCwd, transcriptsRoot } from '../../src/transcript/paths.js';

describe('transcriptsRoot', () => {
  test('no owner → legacy top-level projects dir', () => {
    expect(transcriptsRoot('/hh')).toBe('/hh/projects');
  });
  test('with owner → per-user scoped projects dir', () => {
    expect(transcriptsRoot('/hh', 'alice')).toBe('/hh/users/alice/projects');
  });
  test('a traversal owner id is rejected (validatePrincipalId)', () => {
    expect(() => transcriptsRoot('/hh', '../bob')).toThrow();
    expect(() => transcriptsRoot('/hh', 'a/b')).toThrow();
  });
});

describe('slugifyCwd', () => {
  test('every non-alphanumeric becomes a dash (Claude-Code rule)', () => {
    // A non-existent path → realpath falls back to the raw value (deterministic).
    expect(slugifyCwd('/a/b-c.d')).toBe('-a-b-c-d');
    expect(slugifyCwd('/Users/x/code/foo')).toBe('-Users-x-code-foo');
  });
  test('the slug contains only [A-Za-z0-9-]', () => {
    expect(slugifyCwd('/weird path/with.dots & spaces')).toMatch(/^[A-Za-z0-9-]+$/);
  });
});

describe('resolveTranscriptPath', () => {
  test('builds <projectsRoot>/<slug>/<sessionId>.jsonl', () => {
    expect(resolveTranscriptPath('/hh/projects', '/a/b', 'sess1')).toBe(
      '/hh/projects/-a-b/sess1.jsonl',
    );
  });
  test('a colon-delimited channel session id is preserved in the stem', () => {
    expect(resolveTranscriptPath('/hh/projects', '/a', 'agent:main:slack:dm:U1')).toBe(
      '/hh/projects/-a/agent:main:slack:dm:U1.jsonl',
    );
  });
  test('a traversal session id is sanitized (cannot escape the project dir)', () => {
    const p = resolveTranscriptPath('/hh/projects', '/a', '../../etc/passwd');
    expect(p.startsWith('/hh/projects/-a/')).toBe(true);
    expect(p.includes('..')).toBe(false);
    expect(p.endsWith('.jsonl')).toBe(true);
  });
});
