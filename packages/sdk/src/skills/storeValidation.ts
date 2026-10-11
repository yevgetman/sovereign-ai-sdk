import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { splitFrontmatter } from './frontmatter.js';
import { formatGuardBlockMessage, guardSkillText } from './guard.js';
import { SkillFrontmatterSchema } from './loader.js';
import type {
  SkillStoreListOptions,
  SkillStoreListPage,
  SkillStoreWireEntry,
} from './storeTypes.js';
import type { SkillTrustTier } from './types.js';

export const SKILL_STORE_INTERNAL = '.sov-skill-store';
export const SKILL_STORE_LIMITS = { files: 512, bytes: 16 * 1024 * 1024, depth: 16 };

export function assertSkillStoreName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || name === 'agent-created') {
    throw new Error('skill name must be slash-command-safe and not a reserved store name');
  }
}

export function assertSkillStoreResource(path: string): void {
  const parts = path.split('/');
  if (
    !path ||
    path.includes('\\') ||
    parts.length > SKILL_STORE_LIMITS.depth ||
    parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))
  )
    throw new Error(`unsafe skill resource path: ${path}`);
}

export function validateSkillStoreEntry(entry: SkillStoreWireEntry, tier: SkillTrustTier): void {
  assertSkillStoreName(entry.name);
  const paths = Object.keys(entry.files);
  if (paths.length > SKILL_STORE_LIMITS.files) throw new Error('skill tree exceeds file limit');
  let bytes = 0;
  for (const path of paths) {
    assertSkillStoreResource(path);
    const file = entry.files[path];
    if (!file) continue;
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)
      throw new Error('invalid skill file mode');
    const data = Buffer.from(file.data, 'base64');
    bytes += data.byteLength;
    if (bytes > SKILL_STORE_LIMITS.bytes) throw new Error('skill tree exceeds byte limit');
    if (path.endsWith('.md') || path.endsWith('.txt')) {
      const guard = guardSkillText(data.toString('utf8'), tier);
      if (guard.action !== 'allow') throw new Error(formatGuardBlockMessage(guard));
    }
  }
  if (Object.keys(entry.directoryModes).length > SKILL_STORE_LIMITS.files)
    throw new Error('skill tree exceeds directory limit');
  for (const path of Object.keys(entry.directoryModes)) {
    const mode = entry.directoryModes[path];
    if (!Number.isInteger(mode) || (mode ?? -1) < 0 || (mode ?? 0o1000) > 0o777)
      throw new Error('invalid skill directory mode');
    if (path) assertSkillStoreResource(path);
  }
  const skill = entry.files['SKILL.md'];
  if (!skill) throw new Error('skill tree must contain SKILL.md');
  const raw = Buffer.from(skill.data, 'base64').toString('utf8');
  const frontmatter = SkillFrontmatterSchema.parse(parseYaml(splitFrontmatter(raw).frontmatter));
  if (frontmatter.name !== entry.name)
    throw new Error('SKILL.md name does not match stored identity');
}

export function skillStoreRevision(
  entry: Pick<SkillStoreWireEntry, 'files' | 'directoryModes'>,
): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(entry.directoryModes).sort()) {
    hash.update(JSON.stringify(['directory', path, entry.directoryModes[path]]));
  }
  for (const path of Object.keys(entry.files).sort()) {
    const file = entry.files[path];
    if (file) hash.update(JSON.stringify(['file', path, file.mode, file.data]));
  }
  return hash.digest('hex');
}

/** A names-only generation invalidates cursors on add/remove. Content edits
 *  keep the same identities; each subsequent read still returns its tree CAS. */
export function pageSkillStoreNames(
  names: string[],
  options: SkillStoreListOptions = {},
): SkillStoreListPage {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SKILL_STORE_LIMITS.files)
    throw new Error('skill store page limit must be 1–512');
  const generation = createHash('sha256').update(JSON.stringify(names)).digest('hex');
  let offset = 0;
  if (options.cursor) {
    if (options.cursor.length > 512) throw new Error('invalid skill store cursor');
    let parsed: { generation?: string; offset?: number };
    try {
      parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
    } catch {
      throw new Error('invalid skill store cursor');
    }
    if (
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0 ||
      (parsed.offset ?? -1) > names.length
    )
      throw new Error('invalid skill store cursor');
    if (parsed.generation !== generation)
      throw new Error('skill store catalog changed; restart pagination');
    offset = parsed.offset ?? 0;
  }
  const next = offset + limit;
  const truncated = next < names.length;
  return {
    names: names.slice(offset, next),
    generation,
    truncated,
    ...(truncated
      ? {
          nextCursor: Buffer.from(JSON.stringify({ generation, offset: next })).toString(
            'base64url',
          ),
        }
      : {}),
  };
}
