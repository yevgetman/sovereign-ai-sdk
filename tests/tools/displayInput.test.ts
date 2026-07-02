// displayInput previews for the seven noisy tools. Renders are checked
// against the Claude-Code-style readable forms documented in the
// `displayInput?` JSDoc on src/tool/types.ts.
//
// The REPL wraps the displayInput output in parens for the slot label
// (`→ Bash(ls -la)` etc.). These tests just check the unwrapped string.

import { describe, expect, test } from 'bun:test';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { AgentTool } from '@yevgetman/sov-sdk/tools/AgentTool';
import { BashTool } from '@yevgetman/sov-sdk/tools/BashTool';
import { FileEditTool } from '@yevgetman/sov-sdk/tools/FileEditTool';
import { FileReadTool } from '@yevgetman/sov-sdk/tools/FileReadTool';
import { FileWriteTool } from '@yevgetman/sov-sdk/tools/FileWriteTool';
import { GlobTool } from '@yevgetman/sov-sdk/tools/GlobTool';
import { GrepTool } from '@yevgetman/sov-sdk/tools/GrepTool';
import type { z } from 'zod';

// Cast each Tool to a permissive shape so we can call displayInput
// with the real input types without re-importing each Input definition.
type WithDisplay = Tool<unknown, unknown> & {
  displayInput?: (input: Record<string, unknown>) => string;
};

const Bash = BashTool as unknown as WithDisplay;
const Read = FileReadTool as unknown as WithDisplay;
const Write = FileWriteTool as unknown as WithDisplay;
const Edit = FileEditTool as unknown as WithDisplay;
const Grep = GrepTool as unknown as WithDisplay;
const Glob = GlobTool as unknown as WithDisplay;
const Agent = AgentTool as unknown as WithDisplay;

describe('Bash.displayInput', () => {
  test('returns the command verbatim', () => {
    expect(Bash.displayInput?.({ command: 'ls -la' })).toBe('ls -la');
  });
  test('handles long pipelines (REPL truncates downstream if needed)', () => {
    const cmd = 'find . -name "*.ts" | xargs grep -l "TODO" | head -20';
    expect(Bash.displayInput?.({ command: cmd })).toBe(cmd);
  });
});

describe('FileRead.displayInput', () => {
  test('path only when no offset/limit', () => {
    expect(Read.displayInput?.({ path: 'src/foo.ts' })).toBe('src/foo.ts');
  });
  test('path with offset only renders as `path:offset+`', () => {
    expect(Read.displayInput?.({ path: 'src/foo.ts', offset: 50 })).toBe('src/foo.ts:50+');
  });
  test('path with offset and limit renders as `path:start-end`', () => {
    expect(Read.displayInput?.({ path: 'src/foo.ts', offset: 50, limit: 20 })).toBe(
      'src/foo.ts:50-70',
    );
  });
  test('limit only (offset defaults to 0)', () => {
    expect(Read.displayInput?.({ path: 'src/foo.ts', limit: 10 })).toBe('src/foo.ts:0-10');
  });
});

describe('FileWrite.displayInput', () => {
  test('renders just the path (content is shown via inline diff)', () => {
    expect(Write.displayInput?.({ path: 'src/new.ts', content: 'export const x = 1;' })).toBe(
      'src/new.ts',
    );
  });
});

describe('FileEdit.displayInput', () => {
  test('renders just the path by default', () => {
    expect(Edit.displayInput?.({ path: 'src/foo.ts', old_string: 'a', new_string: 'b' })).toBe(
      'src/foo.ts',
    );
  });
  test('appends `(all)` when replace_all is true', () => {
    expect(
      Edit.displayInput?.({
        path: 'src/foo.ts',
        old_string: 'a',
        new_string: 'b',
        replace_all: true,
      }),
    ).toBe('src/foo.ts (all)');
  });
});

describe('Grep.displayInput', () => {
  test('pattern only when no path/glob', () => {
    expect(Grep.displayInput?.({ pattern: 'TODO' })).toBe('"TODO"');
  });
  test('appends `in <path>` when path is set', () => {
    expect(Grep.displayInput?.({ pattern: 'TODO', path: 'src/' })).toBe('"TODO" in src/');
  });
  test('appends `(<glob>)` when glob is set', () => {
    expect(Grep.displayInput?.({ pattern: 'TODO', path: 'src/', glob: '*.ts' })).toBe(
      '"TODO" in src/ (*.ts)',
    );
  });
});

describe('Glob.displayInput', () => {
  test('pattern only when no path', () => {
    expect(Glob.displayInput?.({ pattern: '**/*.ts' })).toBe('**/*.ts');
  });
  test('appends `in <path>` when path is set', () => {
    expect(Glob.displayInput?.({ pattern: '*.md', path: 'docs/' })).toBe('*.md in docs/');
  });
});

describe('AgentTool.displayInput', () => {
  test('renders `<subagent_type>: <prompt>`', () => {
    expect(
      Agent.displayInput?.({
        subagent_type: 'explore',
        prompt: 'investigate src/auth.py',
      }),
    ).toBe('explore: investigate src/auth.py');
  });
});

describe('displayInput wiring', () => {
  test('every covered tool has a displayInput function', () => {
    for (const [name, tool] of [
      ['Bash', Bash],
      ['FileRead', Read],
      ['FileWrite', Write],
      ['FileEdit', Edit],
      ['Grep', Grep],
      ['Glob', Glob],
      ['AgentTool', Agent],
    ] as const) {
      expect(typeof tool.displayInput, `${name}.displayInput must be a function`).toBe('function');
    }
  });

  test('input shape from the AgentToolInputSchema accepts what AgentTool.displayInput expects', () => {
    // Sanity check that the displayInput contract aligns with the
    // schema — guards against future schema changes silently breaking
    // the preview formatter.
    const schema = AgentTool.inputSchema as z.ZodType<{ subagent_type: string; prompt: string }>;
    const parsed = schema.parse({ subagent_type: 'plan', prompt: 'design X' });
    expect(Agent.displayInput?.(parsed)).toBe('plan: design X');
  });
});
