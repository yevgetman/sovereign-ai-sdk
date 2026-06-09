// Plugin manifest schema tests (T1). The manifest is a STRICT KNOWN-SUBSET
// schema, NOT `.strict()`-rejecting: a real Claude-Code plugin.json must parse,
// with every unknown / CC-only top-level key collected into `ignored[]` (so the
// consent disclosure can list exactly what we ignore) rather than rejected.
// Identity is validated hard; the declared-but-inert hooks/mcpServers blocks
// are validated for disclosure (well-formed accepted, malformed rejected) but
// never executed in v1.

import { describe, expect, test } from 'bun:test';
import { PluginManifestSchema, parsePluginManifest } from '../../src/plugins/manifest.js';

describe('PluginManifestSchema — identity + defaults', () => {
  test('parses a minimal valid manifest with component-dir defaults', () => {
    const result = PluginManifestSchema.parse({
      name: 'my-plugin',
      version: '1.0.0',
      description: 'a tidy little plugin',
    });
    expect(result.name).toBe('my-plugin');
    expect(result.version).toBe('1.0.0');
    expect(result.description).toBe('a tidy little plugin');
    // Component-dir overrides default to the CC conventional dir names.
    expect(result.skills).toBe('skills');
    expect(result.commands).toBe('commands');
    // No unknown keys ⇒ empty ignored list.
    expect(result.ignored).toEqual([]);
  });

  test('accepts an optional author', () => {
    const result = PluginManifestSchema.parse({
      name: 'authored',
      version: '0.1.0',
      description: 'has an author',
      author: 'Ada Lovelace',
    });
    expect(result.author).toBe('Ada Lovelace');
  });

  test('honours explicit component-dir overrides', () => {
    const result = PluginManifestSchema.parse({
      name: 'custom-dirs',
      version: '2.0.0',
      description: 'custom component dirs',
      skills: 'my-skills',
      commands: 'slash',
    });
    expect(result.skills).toBe('my-skills');
    expect(result.commands).toBe('slash');
  });
});

describe('PluginManifestSchema — name validation', () => {
  test('rejects an uppercase name (Foo)', () => {
    expect(() =>
      PluginManifestSchema.parse({ name: 'Foo', version: '1.0.0', description: 'x' }),
    ).toThrow();
  });

  test('rejects a name starting with a digit (1bad)', () => {
    expect(() =>
      PluginManifestSchema.parse({ name: '1bad', version: '1.0.0', description: 'x' }),
    ).toThrow();
  });

  test('rejects an empty name', () => {
    expect(() =>
      PluginManifestSchema.parse({ name: '', version: '1.0.0', description: 'x' }),
    ).toThrow();
  });

  test('rejects a name with an underscore', () => {
    expect(() =>
      PluginManifestSchema.parse({ name: 'bad_name', version: '1.0.0', description: 'x' }),
    ).toThrow();
  });

  test('accepts a hyphenated lowercase name with digits', () => {
    const result = PluginManifestSchema.parse({
      name: 'a-b-2',
      version: '1.0.0',
      description: 'x',
    });
    expect(result.name).toBe('a-b-2');
  });
});

describe('PluginManifestSchema — unknown CC-only keys collected into ignored[]', () => {
  test('collects unknown top-level keys into ignored[] instead of rejecting', () => {
    const result = PluginManifestSchema.parse({
      name: 'cc-plugin',
      version: '1.0.0',
      description: 'a real CC plugin shape',
      // CC-only / unknown top-level keys the harness does not consume in v1:
      agents: 'agents',
      keywords: ['ai', 'tools'],
      homepage: 'https://example.com',
      license: 'MIT',
    });
    expect(result.name).toBe('cc-plugin');
    expect(result.ignored.sort()).toEqual(['agents', 'homepage', 'keywords', 'license'].sort());
  });

  test('known keys never leak into ignored[]', () => {
    const result = PluginManifestSchema.parse({
      name: 'clean',
      version: '1.0.0',
      description: 'x',
      author: 'a',
      skills: 'skills',
      commands: 'commands',
      hooks: {},
      mcpServers: {},
    });
    expect(result.ignored).toEqual([]);
  });
});

describe('PluginManifestSchema — declared-but-inert hooks/mcpServers (disclosure)', () => {
  test('accepts a well-formed hooks block and exposes it for disclosure', () => {
    const result = PluginManifestSchema.parse({
      name: 'with-hooks',
      version: '1.0.0',
      description: 'declares hooks',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    });
    expect(result.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe('echo hi');
  });

  test('rejects a malformed hooks block (hook missing command)', () => {
    expect(() =>
      PluginManifestSchema.parse({
        name: 'bad-hooks',
        version: '1.0.0',
        description: 'x',
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' }] }] },
      }),
    ).toThrow();
  });

  test('accepts a well-formed mcpServers block and exposes it for disclosure', () => {
    const result = PluginManifestSchema.parse({
      name: 'with-mcp',
      version: '1.0.0',
      description: 'declares an mcp server',
      mcpServers: {
        deploy: { type: 'http', url: 'https://api.example.com/mcp' },
      },
    });
    const server = result.mcpServers?.deploy;
    expect(server?.type).toBe('http');
  });

  test('accepts a legacy stdio mcp config (no type) via the shared schema', () => {
    const result = PluginManifestSchema.parse({
      name: 'legacy-mcp',
      version: '1.0.0',
      description: 'x',
      mcpServers: { local: { command: 'node', args: ['server.js'] } },
    });
    expect(result.mcpServers?.local?.type).toBe('stdio');
  });

  test('rejects a malformed mcpServers block (http with no url)', () => {
    expect(() =>
      PluginManifestSchema.parse({
        name: 'bad-mcp',
        version: '1.0.0',
        description: 'x',
        mcpServers: { broken: { type: 'http' } },
      }),
    ).toThrow();
  });
});

describe('parsePluginManifest', () => {
  test('parses valid JSON-shaped unknown input', () => {
    const manifest = parsePluginManifest({
      name: 'parsed',
      version: '1.0.0',
      description: 'via the parse helper',
    });
    expect(manifest.name).toBe('parsed');
    expect(manifest.skills).toBe('skills');
  });

  test('throws on an invalid manifest', () => {
    expect(() =>
      parsePluginManifest({ name: 'Bad', version: '1.0.0', description: 'x' }),
    ).toThrow();
  });

  test('does not mutate its input', () => {
    const input = { name: 'immut', version: '1.0.0', description: 'x', extra: 'cc-only' };
    const snapshot = JSON.parse(JSON.stringify(input));
    parsePluginManifest(input);
    expect(input).toEqual(snapshot);
  });
});
