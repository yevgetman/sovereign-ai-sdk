// Plugin disclosure builder tests (T6). The disclosure is the capability-framed
// string the operator sees at the consent prompt; this pins its format directly
// (the install tests exercise it end-to-end via the injected confirm). Pure —
// no I/O; the ComponentScan is constructed in-test.

import { describe, expect, test } from 'bun:test';
import { type ComponentScan, buildDisclosure, plural } from '../../src/plugins/disclosure.js';
import { parsePluginManifest } from '../../src/plugins/manifest.js';

const EMPTY_SCAN: ComponentScan = {
  skillCount: 0,
  commandCount: 0,
  totalComponents: 0,
  disabled: [],
  advisories: [],
  scripts: [],
  referenceFiles: [],
};

describe('plural', () => {
  test('singular has no trailing s', () => {
    expect(plural(1, 'skill')).toBe('1 skill');
  });
  test('zero and plural get s', () => {
    expect(plural(0, 'skill')).toBe('0 skills');
    expect(plural(2, 'command')).toBe('2 commands');
  });
});

describe('buildDisclosure', () => {
  test('a minimal plugin shows identity + active contribution counts', () => {
    const manifest = parsePluginManifest({
      name: 'tiny',
      version: '0.1.0',
      description: 'tiny plugin',
    });
    const scan: ComponentScan = {
      ...EMPTY_SCAN,
      skillCount: 2,
      commandCount: 1,
      totalComponents: 3,
    };
    const out = buildDisclosure(manifest, scan);
    expect(out).toContain('Plugin tiny v0.1.0');
    expect(out).toContain('tiny plugin');
    expect(out).toContain('Contributes: 2 skills, 1 command.');
    // No inert block, ignored, scripts, advisories, or disabled lines.
    expect(out).not.toContain('INERT');
    expect(out).not.toContain('disabled by policy');
  });

  test('author is rendered when present', () => {
    const manifest = parsePluginManifest({
      name: 'tiny',
      version: '0.1.0',
      description: 'd',
      author: 'Grace',
    });
    expect(buildDisclosure(manifest, EMPTY_SCAN)).toContain('by Grace');
  });

  test('inert hooks + mcp servers are framed as declared-but-never-run', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      version: '1.0.0',
      description: 'd',
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'cleanup.sh' }] }],
      },
      mcpServers: {
        a: { type: 'http', url: 'https://one.example.com/mcp' },
        b: { type: 'stdio', command: 'mcp-local' },
      },
    });
    const out = buildDisclosure(manifest, EMPTY_SCAN);
    expect(out).toContain('Declares (INERT in v1 — disclosed, never run):');
    expect(out).toContain('2 hooks running shell');
    expect(out).toContain('echo hi');
    expect(out).toContain('cleanup.sh');
    expect(out).toContain('2 MCP servers connecting to');
    expect(out).toContain('one.example.com');
    expect(out).toContain("local 'mcp-local'");
  });

  test('ignored CC-only keys are disclosed', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      version: '1.0.0',
      description: 'd',
      keywords: ['x'],
      homepage: 'https://h',
    });
    const out = buildDisclosure(manifest, EMPTY_SCAN);
    expect(out).toContain('Ignores CC-only feature(s): keywords, homepage.');
  });

  test('bundled scripts are disclosed as not-run-but-runnable', () => {
    const manifest = parsePluginManifest({ name: 'p', version: '1.0.0', description: 'd' });
    const scan: ComponentScan = { ...EMPTY_SCAN, scripts: ['setup.sh', 'tools/build.py'] };
    const out = buildDisclosure(manifest, scan);
    expect(out).toContain('Bundles 2 scripts');
    expect(out).toContain('setup.sh');
    expect(out).toContain('tools/build.py');
    expect(out.toLowerCase()).toContain('induced to run');
  });

  test('bundled reference files are disclosed (named/counted)', () => {
    const manifest = parsePluginManifest({ name: 'p', version: '1.0.0', description: 'd' });
    const scan: ComponentScan = {
      ...EMPTY_SCAN,
      referenceFiles: ['skills/greet/reference.txt', 'skills/wipe/payload.txt'],
    };
    const out = buildDisclosure(manifest, scan);
    expect(out).toContain('Bundles 2 reference files');
    expect(out).toContain('skills/greet/reference.txt');
    expect(out).toContain('skills/wipe/payload.txt');
  });

  test('disabled-by-policy components reduce active counts and list the N of M line', () => {
    const manifest = parsePluginManifest({ name: 'p', version: '1.0.0', description: 'd' });
    const scan: ComponentScan = {
      ...EMPTY_SCAN,
      skillCount: 2,
      commandCount: 0,
      totalComponents: 2,
      disabled: [
        { kind: 'skill', name: 'skills/wipe/SKILL.md', reason: 'destructive-operation pattern' },
      ],
    };
    const out = buildDisclosure(manifest, scan);
    // 2 skills found, 1 disabled → 1 active.
    expect(out).toContain('Contributes: 1 skill, 0 commands.');
    expect(out).toContain('⛔ 1 of 2 component(s) disabled by policy:');
    expect(out).toContain('skills/wipe/SKILL.md (destructive-operation pattern)');
  });

  test('non-blocking guard advisories render with a ⚠ marker', () => {
    const manifest = parsePluginManifest({ name: 'p', version: '1.0.0', description: 'd' });
    const scan: ComponentScan = {
      ...EMPTY_SCAN,
      advisories: [{ component: 'setup.sh', level: 'medium', category: 'persistence' }],
    };
    const out = buildDisclosure(manifest, scan);
    expect(out).toContain('⚠ guard advisory: persistence (medium) in setup.sh');
  });
});
