// Proprietary persistence adapter. The shared SDK owns guidance validation,
// retention budgets and lifecycle. This table is private session state and
// cannot become a permission grant or a public session metadata field.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  type SkillContinuityDiagnostic,
  type SkillContinuityPort,
  type SkillContinuityRecord,
  type SkillContinuityScope,
  type SkillContinuityStore,
  createSkillContinuity,
} from '@yevgetman/sov-sdk/skills/continuity';
import { type SessionDb, skillContinuityOwnerKey } from '../agent/sessionDb.js';

const MAX_LINEAGE_DEPTH = 8;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const CONTINUITY_SCHEMA_VERSION = 7;

/** Profiles are host-owned roots. No client-supplied owner/profile selectors. */
export function skillContinuityProfileKey(harnessHome: string): string {
  return createHash('sha256').update(resolve(harnessHome)).digest('hex');
}

function parseSnapshot(serialized: string): SkillContinuityRecord[] {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('invalid skill continuity snapshot');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('invalid skill continuity snapshot');
  }
  if (!Array.isArray(parsed) || parsed.length > 1024) {
    throw new Error('invalid skill continuity snapshot');
  }
  // The core validates hashes, fields, per-record and aggregate bounds before
  // using any guidance. Parsing here never restores a tool activation state.
  return parsed as SkillContinuityRecord[];
}

export class SessionSkillContinuityStore implements SkillContinuityStore {
  constructor(
    private readonly db: SessionDb,
    private readonly profile: string,
    private readonly observe?: (event: SkillContinuityDiagnostic) => void,
  ) {}

  async load(scope: SkillContinuityScope): Promise<readonly SkillContinuityRecord[]> {
    this.assertScope(scope);
    const own = this.db.loadSkillContinuity(scope.profile, scope.owner, scope.session);
    if (own !== null) return parseSnapshot(own);
    // New sessions copied every available profile snapshot at creation. An
    // absent profile is a frozen empty state, not permission to adopt a later
    // parent activation. Only genuinely older rows need lineage fallback.
    const allowLegacyInheritance =
      (this.db.getSession(scope.session)?.schemaVersion ?? CONTINUITY_SCHEMA_VERSION) <
      CONTINUITY_SCHEMA_VERSION;
    // Existing pre-feature child sessions can resume from the nearest private
    // snapshot. Never cross a principal boundary or resurrect a completed
    // workflow from an older ancestor after encountering an empty snapshot.
    const visited = new Set([scope.session]);
    let parentId = this.db.getSession(scope.session)?.parentSessionId ?? null;
    let inherited: SkillContinuityRecord[] = [];
    for (let depth = 0; parentId !== null; depth++) {
      if (depth >= MAX_LINEAGE_DEPTH || visited.has(parentId)) {
        this.emitInvalidLineage();
        break;
      }
      visited.add(parentId);
      const parent = this.db.getSession(parentId);
      if (parent === null || skillContinuityOwnerKey(parent.ownerId) !== scope.owner) {
        this.emitInvalidLineage();
        break;
      }
      const snapshot = this.db.loadSkillContinuity(scope.profile, scope.owner, parent.sessionId);
      if (snapshot !== null) {
        if (allowLegacyInheritance)
          inherited = parseSnapshot(snapshot).filter((record) => record?.lifetime !== 'turn');
        break;
      }
      parentId = parent.parentSessionId;
    }
    // Persist even the empty snapshot, so later parent edits or deletions do
    // not silently replace the lineage selected for this child.
    this.db.saveSkillContinuity(
      scope.profile,
      scope.owner,
      scope.session,
      JSON.stringify(inherited),
    );
    return structuredClone(inherited);
  }

  async save(
    scope: SkillContinuityScope,
    records: readonly SkillContinuityRecord[],
  ): Promise<void> {
    this.assertScope(scope);
    if (!Array.isArray(records) || records.length > 1024) {
      throw new Error('invalid skill continuity snapshot');
    }
    const serialized = JSON.stringify(records);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
      throw new Error('invalid skill continuity snapshot');
    }
    this.db.saveSkillContinuity(scope.profile, scope.owner, scope.session, serialized);
  }

  private assertScope(scope: SkillContinuityScope): void {
    const session = this.db.getSession(scope.session);
    if (
      scope.profile !== this.profile ||
      session === null ||
      skillContinuityOwnerKey(session.ownerId) !== scope.owner
    ) {
      throw new Error('skill continuity session unavailable');
    }
  }

  private emitInvalidLineage(): void {
    try {
      Promise.resolve(this.observe?.({ code: 'invalid-record' })).catch(() => undefined);
    } catch {
      /* diagnostics are advisory */
    }
  }
}

/** Construct once per trusted SessionContext; the core lazily reads the store. */
export function buildSovSkillContinuity(options: {
  db: SessionDb;
  harnessHome: string;
  sessionId: string;
  observe?: (event: SkillContinuityDiagnostic) => void;
}): SkillContinuityPort {
  const session = options.db.getSession(options.sessionId);
  if (session === null) throw new Error('skill continuity session unavailable');
  const scope = {
    profile: skillContinuityProfileKey(options.harnessHome),
    owner: skillContinuityOwnerKey(session.ownerId),
    session: session.sessionId,
  };
  return createSkillContinuity({
    scope,
    store: new SessionSkillContinuityStore(options.db, scope.profile, options.observe),
    ...(options.observe !== undefined ? { observe: options.observe } : {}),
  });
}
