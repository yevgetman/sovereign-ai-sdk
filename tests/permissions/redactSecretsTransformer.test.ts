import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { redactSecretsTransformer } from '../../src/permissions/redactSecretsTransformer.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool } from '../../src/tool/types.js';

function fakeTool(name: string, aliases?: readonly string[]): Tool<unknown, unknown> {
  return buildTool({
    name,
    ...(aliases ? { aliases: [...aliases] } : {}),
    description: () => name,
    inputSchema: z.object({}).passthrough(),
    async call() {
      return { data: 'ok' };
    },
  }) as unknown as Tool<unknown, unknown>;
}

const GH_TOKEN = 'gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('redactSecretsTransformer — tool name gating', () => {
  test('canonical FileWrite (the actual tool name) input is redacted', async () => {
    // Regression: the harness's Write tool's `name` is `FileWrite`, with
    // `Write` as an alias. The transformer must key on the canonical name
    // (or fall through via aliases). Original wiring keyed only on the
    // alias and silently no-op'd on every real tool dispatch.
    const result = await redactSecretsTransformer(fakeTool('FileWrite'), {
      file_path: '/tmp/x.txt',
      content: GH_TOKEN,
    });
    const updated = result?.updatedInput as Record<string, string>;
    expect(updated.content).toContain('<REDACTED:github-oauth>');
    expect(updated.content).not.toContain(GH_TOKEN);
  });

  test('canonical FileEdit input.new_string is redacted', async () => {
    const result = await redactSecretsTransformer(fakeTool('FileEdit'), {
      file_path: '/tmp/x.txt',
      old_string: 'placeholder',
      new_string: GH_TOKEN,
    });
    const updated = result?.updatedInput as Record<string, string>;
    expect(updated.new_string).toContain('<REDACTED:github-oauth>');
  });

  test('alias-only tool (Write alias on a non-FileWrite name) is redacted via alias resolution', async () => {
    // A future tool that registers Write as an alias should still trigger
    // redaction even if its canonical name is something we don't know.
    const result = await redactSecretsTransformer(fakeTool('SomeOtherWriter', ['Write']), {
      file_path: '/tmp/x.txt',
      content: GH_TOKEN,
    });
    const updated = result?.updatedInput as Record<string, string>;
    expect(updated.content).toContain('<REDACTED:github-oauth>');
  });

  test('Write input.content with a secret is redacted', async () => {
    const result = await redactSecretsTransformer(fakeTool('Write'), {
      file_path: '/tmp/x.txt',
      content: `before ${GH_TOKEN} after`,
    });
    expect(result?.updatedInput).toEqual({
      file_path: '/tmp/x.txt',
      content: 'before <REDACTED:github-oauth> after',
    });
    expect(result?.reason).toContain('redacted 1 secret');
    expect(result?.reason).toContain('github-oauth');
  });

  test('Edit input.new_string is redacted; old_string is NOT touched', async () => {
    const result = await redactSecretsTransformer(fakeTool('Edit'), {
      file_path: '/tmp/x.txt',
      old_string: `keep ${GH_TOKEN} as-is`,
      new_string: `replace ${GH_TOKEN} with redaction`,
    });
    const updated = result?.updatedInput as Record<string, string>;
    // old_string preserves the live secret so the Edit can match in the
    // file (legitimate "remove a secret" workflow).
    expect(updated.old_string).toBe(`keep ${GH_TOKEN} as-is`);
    expect(updated.new_string).toBe('replace <REDACTED:github-oauth> with redaction');
  });

  test('NotebookEdit input.new_source is redacted', async () => {
    const result = await redactSecretsTransformer(fakeTool('NotebookEdit'), {
      notebook_path: '/tmp/n.ipynb',
      cell_id: 'abc',
      new_source: `os.environ['GH'] = '${GH_TOKEN}'`,
    });
    const updated = result?.updatedInput as Record<string, string>;
    expect(updated.new_source).toContain('<REDACTED:github-oauth>');
    expect(updated.new_source).not.toContain(GH_TOKEN);
  });

  test('non-Write tool (e.g. Bash) is ignored', async () => {
    const result = await redactSecretsTransformer(fakeTool('Bash'), {
      command: `echo ${GH_TOKEN}`,
    });
    expect(result).toBeUndefined();
  });

  test('non-Write tool (Read) is ignored even with secret-shaped paths', async () => {
    const result = await redactSecretsTransformer(fakeTool('Read'), {
      file_path: `/tmp/${GH_TOKEN}.txt`,
    });
    expect(result).toBeUndefined();
  });
});

describe('redactSecretsTransformer — content variations', () => {
  test('clean Write content returns undefined (no rewrite)', async () => {
    const result = await redactSecretsTransformer(fakeTool('Write'), {
      file_path: '/tmp/x.txt',
      content: 'just a plain document with no secrets in it.',
    });
    expect(result).toBeUndefined();
  });

  test('Write with empty content returns undefined', async () => {
    const result = await redactSecretsTransformer(fakeTool('Write'), {
      file_path: '/tmp/x.txt',
      content: '',
    });
    expect(result).toBeUndefined();
  });

  test('Write with content not a string returns undefined', async () => {
    const result = await redactSecretsTransformer(fakeTool('Write'), {
      file_path: '/tmp/x.txt',
      content: 123, // wrong type — schema validation handles it elsewhere
    });
    expect(result).toBeUndefined();
  });

  test('multiple secrets in one Write content all redact; reason reports total + kinds', async () => {
    const aws = 'AKIAIOSFODNN7EXAMPLE';
    const stripe = 'sk_live_dddddddddddddddddddddddd';
    const result = await redactSecretsTransformer(fakeTool('Write'), {
      file_path: '/tmp/x.txt',
      content: `gh=${GH_TOKEN}\naws=${aws}\nstripe=${stripe}\n`,
    });
    const updated = result?.updatedInput as Record<string, string>;
    expect(updated.content).not.toContain(GH_TOKEN);
    expect(updated.content).not.toContain(aws);
    expect(updated.content).not.toContain(stripe);
    expect(result?.reason).toContain('redacted 3 secrets');
    expect(result?.reason).toContain('aws-access-key-id');
    expect(result?.reason).toContain('github-oauth');
    expect(result?.reason).toContain('stripe-secret-live');
  });

  test('non-object input returns undefined', async () => {
    const result = await redactSecretsTransformer(fakeTool('Write'), 'not an object');
    expect(result).toBeUndefined();
  });

  test('null input returns undefined', async () => {
    const result = await redactSecretsTransformer(fakeTool('Write'), null);
    expect(result).toBeUndefined();
  });
});

describe('redactSecretsTransformer — reason grammar', () => {
  test('singular vs plural in the reason text', async () => {
    const single = await redactSecretsTransformer(fakeTool('Write'), {
      file_path: '/tmp/a.txt',
      content: GH_TOKEN,
    });
    expect(single?.reason).toMatch(/redacted 1 secret \(/);

    const plural = await redactSecretsTransformer(fakeTool('Write'), {
      file_path: '/tmp/b.txt',
      content: `${GH_TOKEN}\n${GH_TOKEN}`,
    });
    expect(plural?.reason).toMatch(/redacted 2 secrets \(/);
  });
});
