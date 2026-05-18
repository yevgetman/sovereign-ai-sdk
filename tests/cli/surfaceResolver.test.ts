// Phase 16.1 M11 — surface resolver precedence tests.
//
// Pins the resolution order: CLI flag > env SOV_UI > config ui.surface
// > 'tui' default. Each layer is exercised in isolation and in the
// presence of conflicting lower-priority values.

import { describe, expect, test } from 'bun:test';

import type { Settings } from '../../src/config/schema.js';
import { resolveSurface } from '../../src/cli/surfaceResolver.js';

function captureStderr(): {
  write: (m: string) => void;
  output: () => string;
} {
  const buffer: string[] = [];
  return {
    write: (m: string) => {
      buffer.push(m);
    },
    output: () => buffer.join(''),
  };
}

describe('resolveSurface — CLI flag wins', () => {
  test('cli=tui beats env=repl + config=repl + default', () => {
    const result = resolveSurface({
      cliFlag: 'tui',
      env: { SOV_UI: 'repl' },
      config: { ui: { surface: 'repl' } },
    });
    expect(result).toEqual({ surface: 'tui', source: 'cli' });
  });

  test('cli=repl beats env=tui + config=tui + default', () => {
    const result = resolveSurface({
      cliFlag: 'repl',
      env: { SOV_UI: 'tui' },
      config: { ui: { surface: 'tui' } },
    });
    expect(result).toEqual({ surface: 'repl', source: 'cli' });
  });
});

describe('resolveSurface — invalid CLI value warns and falls through', () => {
  test("cli='foo' with env='repl' → env wins, warning printed", () => {
    const stderr = captureStderr();
    const result = resolveSurface({
      cliFlag: 'foo',
      env: { SOV_UI: 'repl' },
      stderr: stderr.write,
    });
    expect(result).toEqual({ surface: 'repl', source: 'env' });
    expect(stderr.output()).toContain("unknown --ui value 'foo'");
    expect(stderr.output()).toContain("expected 'tui' or 'repl'");
  });

  test("cli='foo' with no env or config → default 'tui' wins, warning printed", () => {
    const stderr = captureStderr();
    const result = resolveSurface({
      cliFlag: 'foo',
      env: {},
      stderr: stderr.write,
    });
    expect(result).toEqual({ surface: 'tui', source: 'default' });
    expect(stderr.output()).toContain("unknown --ui value 'foo'");
  });

  test('valid cli does NOT print warning', () => {
    const stderr = captureStderr();
    resolveSurface({ cliFlag: 'tui', env: {}, stderr: stderr.write });
    expect(stderr.output()).toBe('');
  });
});

describe('resolveSurface — env wins when CLI is absent', () => {
  test('env=tui wins over config=repl + default', () => {
    const result = resolveSurface({
      env: { SOV_UI: 'tui' },
      config: { ui: { surface: 'repl' } },
    });
    expect(result).toEqual({ surface: 'tui', source: 'env' });
  });

  test('env=repl wins over config=tui + default', () => {
    const result = resolveSurface({
      env: { SOV_UI: 'repl' },
      config: { ui: { surface: 'tui' } },
    });
    expect(result).toEqual({ surface: 'repl', source: 'env' });
  });
});

describe('resolveSurface — invalid env value falls through silently', () => {
  test("env='bar' with config='repl' → config wins, no stderr output", () => {
    const stderr = captureStderr();
    const result = resolveSurface({
      env: { SOV_UI: 'bar' },
      config: { ui: { surface: 'repl' } },
      stderr: stderr.write,
    });
    expect(result).toEqual({ surface: 'repl', source: 'config' });
    expect(stderr.output()).toBe('');
  });

  test("env='bar' with nothing else → default 'tui' wins", () => {
    const stderr = captureStderr();
    const result = resolveSurface({
      env: { SOV_UI: 'bar' },
      stderr: stderr.write,
    });
    expect(result).toEqual({ surface: 'tui', source: 'default' });
    expect(stderr.output()).toBe('');
  });
});

describe('resolveSurface — config wins when CLI + env are absent', () => {
  test('config=tui (CLI + env absent)', () => {
    const result = resolveSurface({
      env: {},
      config: { ui: { surface: 'tui' } },
    });
    expect(result).toEqual({ surface: 'tui', source: 'config' });
  });

  test('config=repl (CLI + env absent)', () => {
    const result = resolveSurface({
      env: {},
      config: { ui: { surface: 'repl' } },
    });
    expect(result).toEqual({ surface: 'repl', source: 'config' });
  });

  test('config.ui present but surface field absent → default', () => {
    const result = resolveSurface({
      env: {},
      config: { ui: { theme: 'dark' } } as Settings,
    });
    expect(result).toEqual({ surface: 'tui', source: 'default' });
  });
});

describe("resolveSurface — default 'tui' when all layers absent", () => {
  test('empty input', () => {
    const result = resolveSurface({ env: {} });
    expect(result).toEqual({ surface: 'tui', source: 'default' });
  });

  test('config object exists but no ui block', () => {
    const result = resolveSurface({
      env: {},
      config: { defaultProvider: 'anthropic' },
    });
    expect(result).toEqual({ surface: 'tui', source: 'default' });
  });
});

describe('resolveSurface — process.env fallback', () => {
  test('omitting input.env reads from process.env (default surface when SOV_UI is unset)', () => {
    const saved = process.env.SOV_UI;
    delete process.env.SOV_UI;
    try {
      const result = resolveSurface({});
      expect(result).toEqual({ surface: 'tui', source: 'default' });
    } finally {
      if (saved !== undefined) process.env.SOV_UI = saved;
    }
  });

  test('omitting input.env reads from process.env (env hit when SOV_UI=repl)', () => {
    const saved = process.env.SOV_UI;
    process.env.SOV_UI = 'repl';
    try {
      const result = resolveSurface({});
      expect(result).toEqual({ surface: 'repl', source: 'env' });
    } finally {
      if (saved === undefined) delete process.env.SOV_UI;
      else process.env.SOV_UI = saved;
    }
  });
});
