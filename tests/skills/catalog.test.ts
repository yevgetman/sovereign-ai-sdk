import { describe, expect, test } from 'bun:test';
import {
  clipSkillText,
  resolveSkillContextBudget,
  skillTextTokenBound,
} from '@yevgetman/sov-sdk/skills/budget';
import { buildSkillCatalogIndex, listSkillCatalog } from '@yevgetman/sov-sdk/skills/catalog';
import type { Skill } from '@yevgetman/sov-sdk/skills/types';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { SkillsListTool } from '@yevgetman/sov-sdk/tools/SkillsListTool';
import type { z } from 'zod';

function skill(
  name: string,
  description = 'Small public fixture',
  whenToUse = 'When asked to use this fixture',
): Skill {
  return {
    name,
    description,
    whenToUse,
    body: '',
    allowedTools: [],
    path: '',
    realpath: '',
    dir: '',
    source: 'bundle',
    trustTier: 'builtin',
    allowShellInterpolation: false,
    metadata: {
      harness: {
        requiresTools: [],
        requiresToolsets: [],
        fallbackForTools: [],
        fallbackForToolsets: [],
      },
    },
    guard: { action: 'allow', findings: [] },
  };
}
const largeBudget = resolveSkillContextBudget({
  contextWindowTokens: 200_000,
  outputTokens: 8_192,
});

describe('complete bounded skill catalogs', () => {
  test('names projection returns 33 long-description skills in one compact page', () => {
    const input = Array.from({ length: 33 }, (_, index) =>
      skill(`skill-${String(index).padStart(2, '0')}`, 'description '.repeat(2_000)),
    );
    const page = listSkillCatalog(input, {
      detail: 'names',
      limit: 100,
      budget: { ...largeBudget, pageTokens: 2_000 },
    });
    expect(page).toMatchObject({
      detail: 'names',
      total: 33,
      returned: 33,
      remaining: 0,
      truncated: false,
    });
    expect(page.skills).toEqual(input.map(({ name }) => ({ name })));
    expect(page.nextCursor).toBeUndefined();
  });

  test('production names budget fits 33 long names at limit 100', () => {
    const budget = resolveSkillContextBudget({
      contextWindowTokens: 200_000,
      outputTokens: 8_192,
    });
    expect(budget.pageTokens).toBe(1_024);
    const nameOf = (index: number, length: number) => {
      const suffix = String(index).padStart(4, '0');
      return `${'n'.repeat(length - suffix.length)}${suffix}`;
    };
    const input = Array.from({ length: 33 }, (_, index) =>
      skill(nameOf(index, 40), 'description '.repeat(2_000), 'when '.repeat(2_000)),
    );
    expect(input.every((entry) => entry.name.length >= 40)).toBe(true);
    const page = listSkillCatalog(input, { detail: 'names', limit: 100, budget });
    expect(page).toMatchObject({
      detail: 'names',
      total: 33,
      returned: 33,
      remaining: 0,
      truncated: false,
    });
    expect(page.skills).toEqual(input.map(({ name }) => ({ name })));
    expect(page.nextCursor).toBeUndefined();
    const ordinary = Array.from({ length: 101 }, (_, index) => skill(nameOf(index, 64)));
    const first = listSkillCatalog(ordinary, { detail: 'names', limit: 100, budget });
    expect(first.returned).toBe(100);
    expect(first.skills.every((entry) => Object.keys(entry).length === 1)).toBe(true);
    const continuation = first.nextCursor;
    if (!continuation) throw new Error('names cursor missing');
    expect(() =>
      listSkillCatalog(ordinary, { detail: 'names', generation: 2, cursor: continuation, budget }),
    ).toThrow('changed');
    const second = listSkillCatalog(ordinary, {
      detail: 'names',
      limit: 100,
      cursor: continuation,
      budget,
    });
    expect(second).toMatchObject({ returned: 1, remaining: 0, truncated: false });
    expect(second.nextCursor).toBeUndefined();
    expect([...first.skills, ...second.skills].map((entry) => entry.name)).toEqual(
      ordinary.map((entry) => entry.name),
    );
    for (const detail of ['summary', 'activation'] as const) {
      const rich = listSkillCatalog(input, { detail, limit: 100, budget });
      expect(rich.returned).toBeLessThan(33);
      expect(rich.nextCursor).toBeDefined();
      expect(skillTextTokenBound(JSON.stringify(rich))).toBeLessThanOrEqual(budget.pageTokens);
    }
    const described = SkillsListTool.description({});
    expect(described).toContain('detail names');
    expect(described).toContain('limit 100');
  });

  test('raw queries cannot bypass length or serialized page limits', () => {
    expect(() => listSkillCatalog([], { query: ' '.repeat(10_000), budget: largeBudget })).toThrow(
      '256',
    );
    expect(() => listSkillCatalog([], { query: '\u0001'.repeat(256) })).toThrow('page budget');
    const valid = listSkillCatalog([skill('review')], { query: ' review ', budget: largeBudget });
    expect(valid.skills.map((entry) => entry.name)).toEqual(['review']);
    expect(valid.query).toBe(' review ');
    expect(skillTextTokenBound(JSON.stringify(valid))).toBeLessThanOrEqual(largeBudget.pageTokens);
  });

  test('all 530 entries enumerate and long metadata cannot hide the next skill', () => {
    const input = Array.from({ length: 530 }, (_, i) =>
      skill(`fixture-${String(i).padStart(4, '0')}`),
    );
    const firstSkill = input[0];
    if (!firstSkill) throw new Error('fixture missing');
    firstSkill.description = '巨'.repeat(100_000);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = listSkillCatalog(input, {
        generation: 4,
        budget: largeBudget,
        ...(cursor ? { cursor } : {}),
      });
      expect(skillTextTokenBound(JSON.stringify(page))).toBeLessThanOrEqual(largeBudget.pageTokens);
      expect(page.budgetExhausted).toBeUndefined();
      if (pages === 0) expect(page.skills[0]?.metadataTruncated).toBe(true);
      seen.push(...page.skills.map((s) => s.name));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 1_000);
    expect(seen).toEqual(input.map((s) => s.name));
    expect(pages).toBeLessThan(1_000);
    expect(
      listSkillCatalog(input, { query: 'fixture-0529', budget: largeBudget }).skills[0]?.name,
    ).toBe('fixture-0529');
  });

  test('oversized identities can be reconstructed without blocking other entries', () => {
    const name = `a${'b'.repeat(10_000)}`;
    const input = [skill(name), skill('z-last')];
    let cursor: string | undefined;
    let recovered = '';
    let reachedLast = false;
    do {
      const page = listSkillCatalog(input, { budget: largeBudget, ...(cursor ? { cursor } : {}) });
      expect(skillTextTokenBound(JSON.stringify(page))).toBeLessThanOrEqual(largeBudget.pageTokens);
      for (const item of page.skills) {
        if (item.nameFragment) recovered += item.name;
        if (item.name === 'z-last') reachedLast = true;
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(recovered).toBe(name);
    expect(reachedLast).toBe(true);
  });

  test('escaped and Unicode host identities stay within serialized page budgets and enumerate fully', () => {
    // Public host catalogs carry opaque string identities. Their JSON escapes
    // must count toward the page allowance, including fragmented names.
    for (const name of [
      `a${'"'.repeat(5_000)}`,
      `a${'\u0000'.repeat(3_000)}`,
      `a${'😀'.repeat(3_000)}`,
    ]) {
      const input = [skill(name), skill('z-last')];
      let cursor: string | undefined;
      let recovered = '';
      let reachedLast = false;
      let pages = 0;
      const cursors = new Set<string>();
      do {
        const page = listSkillCatalog(input, {
          budget: largeBudget,
          ...(cursor ? { cursor } : {}),
        });
        expect(skillTextTokenBound(JSON.stringify(page))).toBeLessThanOrEqual(
          largeBudget.pageTokens,
        );
        expect(page.budgetExhausted).toBeUndefined();
        for (const item of page.skills) {
          if (item.nameFragment) {
            expect(item.nameFragment.offset).toBe(recovered.length);
            recovered += item.name;
          }
          if (item.name === 'z-last') reachedLast = true;
        }
        cursor = page.nextCursor;
        if (cursor) {
          expect(cursors.has(cursor)).toBe(false);
          cursors.add(cursor);
        }
        if (++pages > 100) throw new Error('catalog pagination did not terminate');
      } while (cursor);
      expect(recovered).toBe(name);
      expect(reachedLast).toBe(true);
    }
  });

  test('generation, metadata, visibility and query changes reject stale cursors', () => {
    const skills = [skill('one'), skill('two'), skill('three')];
    const first = listSkillCatalog(skills, { generation: 1, limit: 1 });
    expect(first.nextCursor).toBeDefined();
    const continuation = first.nextCursor;
    if (!continuation) throw new Error('fixture cursor missing');
    expect(() => listSkillCatalog(skills, { generation: 2, cursor: continuation })).toThrow(
      'changed',
    );
    expect(() =>
      listSkillCatalog(skills.slice(1), { generation: 1, cursor: continuation }),
    ).toThrow('changed');
    expect(() =>
      listSkillCatalog(skills, { generation: 1, query: 'one', cursor: continuation }),
    ).toThrow('query');
    const firstSkill = skills[0];
    if (!firstSkill) throw new Error('fixture missing');
    firstSkill.description = 'edited';
    expect(() => listSkillCatalog(skills, { generation: 1, cursor: continuation })).toThrow(
      'changed',
    );
    expect(() => listSkillCatalog(skills, { cursor: 'bad' })).toThrow('invalid');
  });

  test('context budgets follow frozen numeric metadata with unknown fallback and task headroom', () => {
    const unknown = resolveSkillContextBudget();
    expect(unknown.contextWindowTokens).toBe(32_768);
    expect(unknown.source).toBe('fallback');
    const small = resolveSkillContextBudget({
      contextWindowTokens: 8_192,
      outputTokens: 1_024,
      reservedInputTokens: 2_048,
    });
    const large = resolveSkillContextBudget({
      contextWindowTokens: 1_000_000,
      outputTokens: 32_768,
      reservedInputTokens: 100_000,
    });
    expect(small.indexTokens).toBeLessThan(large.indexTokens);
    expect(large.indexTokens).toBe(2_048);
    expect(large.retentionTokens).toBe(8_192);
    const exhausted = resolveSkillContextBudget({ contextWindowTokens: 100, outputTokens: 100 });
    expect(exhausted.indexTokens).toBe(0);
    expect(exhausted.retentionTokens).toBe(0);
    expect(listSkillCatalog([skill('one')], { budget: exhausted }).budgetExhausted).toBe(true);
  });

  test('initial metadata is complete for small catalogs, searchable fallback for larger catalogs', () => {
    const small = buildSkillCatalogIndex([skill('one'), skill('two')], { budget: largeBudget });
    expect(small.shown).toBe(2);
    expect(small.omitted).toBe(0);
    expect(small.text).toContain('one');
    const many = buildSkillCatalogIndex(
      Array.from({ length: 1_000 }, (_, i) => skill(`fixture-${i}`)),
      { budget: largeBudget },
    );
    expect(many.shown).toBe(0);
    expect(many.omitted).toBe(1_000);
    expect(many.text).toContain('search/page');
    expect(many.estimatedTokens).toBeLessThanOrEqual(largeBudget.indexTokens);
    const largeDescription = buildSkillCatalogIndex([skill('huge', '😀'.repeat(20_000))], {
      budget: largeBudget,
    });
    expect(largeDescription.text).toContain('metadataTruncated');
    expect(largeDescription.estimatedTokens).toBeLessThanOrEqual(largeBudget.indexTokens);
  });

  test('UTF-8 clipping never cuts a Unicode codepoint and bounds arbitrary text', () => {
    expect(clipSkillText('😀😀x', 5)).toEqual({ text: '😀', clipped: true });
    expect(skillTextTokenBound('😀')).toBe(4);
    expect(() => clipSkillText('large', Number.NaN)).toThrow('byte limit');
    expect(() => resolveSkillContextBudget({ outputTokens: Number.NaN })).toThrow('reservations');
  });
});

describe('skills_list cursor detail', () => {
  const input = Array.from({ length: 6 }, (_, index) =>
    skill(`skill-${String(index).padStart(2, '0')}`),
  );
  const ctx: ToolContext = {
    cwd: '/tmp/skills-list-cursor',
    sessionId: 'skills-list-cursor',
    skills: { skills: input, byName: new Map(input.map((entry) => [entry.name, entry])) },
    skillContextBudget: largeBudget,
  };

  test('cursor description and next_actions require the same detail', async () => {
    const schema = SkillsListTool.inputSchema as z.ZodObject<{
      cursor: z.ZodOptional<z.ZodString>;
    }>;
    expect(schema.shape.cursor.description).toContain('same query and detail');
    const page = await SkillsListTool.call({ detail: 'activation', limit: 1 }, ctx);
    expect(page.data.truncated).toBe(true);
    expect(page.observation?.next_actions).toEqual([
      'call skills_list with nextCursor and the same query and detail',
    ]);
  });

  test('a pinned cursor detail continues when the follow-up omits detail', async () => {
    for (const detail of ['summary', 'activation'] as const) {
      const queried = await SkillsListTool.call({ detail, limit: 1, query: 'skill-' }, ctx);
      const queriedCursor = queried.data.nextCursor;
      if (!queriedCursor) throw new Error(`${detail} query cursor missing`);
      const repeatedQuery = await SkillsListTool.call(
        { cursor: queriedCursor, query: 'skill-' },
        ctx,
      );
      expect(repeatedQuery.data.detail).toBe(detail);
      expect(repeatedQuery.data.skills[0]?.description).toBeDefined();

      const first = await SkillsListTool.call({ detail, limit: 1 }, ctx);
      const nextCursor = first.data.nextCursor;
      if (!nextCursor) throw new Error(`${detail} cursor missing`);
      const continued = await SkillsListTool.call({ cursor: nextCursor }, ctx);
      expect(continued.data.detail).toBe(detail);
      expect(continued.data.skills[0]?.name).not.toBe(first.data.skills[0]?.name);
      expect(continued.data.skills[0]?.description).toBeDefined();
      await expect(
        SkillsListTool.call({ cursor: nextCursor, detail: 'names' }, ctx),
      ).rejects.toThrow('restart enumeration');
    }
    const names = await SkillsListTool.call({}, ctx);
    expect(names.data.detail).toBe('names');
    expect(names.data.truncated).toBe(false);
    expect(
      names.data.skills.every(
        (entry) => entry.description === undefined && entry.whenToUse === undefined,
      ),
    ).toBe(true);
    const namesPage = await SkillsListTool.call({ limit: 1 }, ctx);
    const namesCursor = namesPage.data.nextCursor;
    if (!namesCursor) throw new Error('names cursor missing');
    expect(namesPage.data.detail).toBe('names');
    const namesContinued = await SkillsListTool.call({ cursor: namesCursor }, ctx);
    expect(namesContinued.data.detail).toBe('names');
    await expect(SkillsListTool.call({ cursor: 'bad' }, ctx)).rejects.toThrow('invalid');
  });

  test('description does not assign whenToUse or activation to summary', async () => {
    const described = SkillsListTool.description({});
    expect(described).toContain('detail names');
    expect(described).toContain('limit 100');
    expect(described).toContain('names to enumerate');
    expect(described).toContain('summary to discover');
    expect(described).toContain('activation before selection');
    expect(described).not.toContain('summary for discovery and activation');
    for (const sentence of described.split(/(?<=\.)\s+/)) {
      const lower = sentence.toLowerCase();
      expect(lower).not.toMatch(/summary[^.\n]{0,80}whentouse/);
      expect(lower).not.toMatch(/whentouse[^.\n]{0,80}summary/);
      expect(lower).not.toMatch(/(?:default|defaults|omitted)[^.\n]{0,80}activation/);
      expect(lower).not.toMatch(/activation[^.\n]{0,80}(?:default|defaults|omitted)/);
    }
    const omitted = await SkillsListTool.call({}, ctx);
    expect(omitted.data.detail).toBe('names');
    expect(omitted.data.skills.every((entry) => entry.whenToUse === undefined)).toBe(true);
    const summary = await SkillsListTool.call({ detail: 'summary', limit: 1 }, ctx);
    expect(summary.data.detail).toBe('summary');
    expect(summary.data.skills[0]?.description).toBeDefined();
    expect(summary.data.skills[0]?.whenToUse).toBeUndefined();
    const activation = await SkillsListTool.call({ detail: 'activation', limit: 1 }, ctx);
    expect(activation.data.detail).toBe('activation');
    expect(activation.data.skills[0]?.whenToUse).toBeDefined();
  });
});
