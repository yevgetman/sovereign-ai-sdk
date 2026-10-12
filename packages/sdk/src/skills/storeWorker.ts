// Filesystem transactions run in a short-lived process. Its kernel cwd pins
// the selected root even if another process renames that root or replaces its
// pathname with a symlink. Node has no portable openat API (Mac /dev/fd does
// not support directory traversal); using absolute destination paths would
// leave a validation/rename race. Every filesystem operation below is relative.
import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SkillStoreWireEntry, SkillStoreWorkerRequest } from './storeTypes.js';
import {
  SKILL_STORE_INTERNAL,
  SKILL_STORE_LIMITS,
  assertSkillStoreName,
  assertSkillStoreResource,
  pageSkillStoreNames,
  skillStoreRevision,
  validateSkillStoreEntry,
} from './storeValidation.js';

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function assertDirectory(path: string): Stats {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`unsafe store directory: ${path}`);
  return info;
}

/** Pin each child directory before reading through it. Checking a pathname
 * once is insufficient: an ancestor can be replaced while readdir/open runs.
 * The worker is single-threaded and restores/validates its parent before it
 * continues. No destination effect occurs through the restoration pathname. */
function inPinnedDirectory<T>(path: string, action: () => T): T {
  const parent = process.cwd();
  const parentIdentity = statSync('.');
  const expected = assertDirectory(path);
  process.chdir(path);
  const selected = statSync('.');
  const restore = (): void => {
    process.chdir(parent);
    const restored = statSync('.');
    if (restored.dev !== parentIdentity.dev || restored.ino !== parentIdentity.ino)
      throw new Error('skill parent directory changed during capture');
    const current = assertDirectory(path);
    if (current.dev !== expected.dev || current.ino !== expected.ino)
      throw new Error('skill directory changed during capture');
  };
  let result: T;
  try {
    if (selected.dev !== expected.dev || selected.ino !== expected.ino)
      throw new Error('skill directory changed during capture');
    result = action();
  } catch (error) {
    restore();
    throw error;
  }
  restore();
  return result;
}

function inPinnedPath<T>(path: string, action: () => T): T {
  const parts = path === '.' ? [] : path.split('/');
  const visit = (offset: number): T => {
    const part = parts[offset];
    return part === undefined ? action() : inPinnedDirectory(part, () => visit(offset + 1));
  };
  return visit(0);
}

let rootIdentity: { dev: number; ino: number };
let internalIdentity: { dev: number; ino: number };
function inStoreInternal<T>(action: () => T): T {
  return inPinnedDirectory(SKILL_STORE_INTERNAL, () => {
    const current = statSync('.');
    if (current.dev !== internalIdentity.dev || current.ino !== internalIdentity.ino)
      throw new Error('skill store internal directory changed during transaction');
    return action();
  });
}
function atPinnedRoot(): boolean {
  const current = statSync('.');
  return current.dev === rootIdentity.dev && current.ino === rootIdentity.ino;
}

/** Remove only leaf entries in pinned directories. Recursive rm(path) can
 * follow a directory ancestor that was replaced after its initial lstat. */
function removeTree(name: string): void {
  let info: Stats;
  try {
    info = lstatSync(name);
  } catch (error) {
    if (code(error) === 'ENOENT') return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    unlinkSync(name);
    return;
  }
  inPinnedDirectory(name, () => {
    syncDirectory('.', 0o700);
    for (const child of readdirSync('.')) removeTree(child);
  });
  rmdirSync(name);
}

function readRecord(name: string): string {
  const expected = lstatSync(name);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > 4096)
    throw new Error('unsafe skill store record');
  const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== expected.dev || opened.ino !== expected.ino || !opened.isFile())
      throw new Error('skill store record changed during capture');
    const data = Buffer.alloc(4097);
    let length = 0;
    for (;;) {
      const count = readSync(fd, data, length, data.length - length, length);
      if (count === 0) break;
      length += count;
      if (length > 4096) throw new Error('skill store record exceeds limit');
    }
    return data.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function pinRoot(request: SkillStoreWorkerRequest): void {
  const actual = statSync('.');
  if (actual.dev !== request.ancestorIdentity.dev || actual.ino !== request.ancestorIdentity.ino) {
    throw new Error(
      'skill store ancestor changed before transaction; retry with an explicit stable root',
    );
  }
  for (const segment of request.segments) {
    if (!segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment)) {
      throw new Error('invalid store root segment');
    }
    try {
      mkdirSync(segment, { mode: 0o700 });
      // Sync the parent entry before descending into a newly selected root.
      // Syncing only the new directory does not persist its own pathname.
      syncDirectory('.');
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
    const expected = assertDirectory(segment);
    process.chdir(segment);
    const pinned = statSync('.');
    if (pinned.dev !== expected.dev || pinned.ino !== expected.ino) {
      throw new Error('skill store directory changed during root selection');
    }
  }
}

function assertRootPath(request: SkillStoreWorkerRequest): void {
  const selected = statSync('.');
  const current = lstatSync(request.rootPath);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== selected.dev ||
    current.ino !== selected.ino
  )
    throw new Error('skill store root changed during transaction');
}

function secureWrite(path: string, data: Uint8Array | string, mode = 0o600): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(fd, data);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string, mode?: number): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (mode !== undefined) fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (error) {
    // Windows does not expose fsync for directory handles; the journal still
    // recovers process interruption there. POSIX durability errors fail loudly.
    if (process.platform !== 'win32') throw error;
  } finally {
    closeSync(fd);
  }
}

function acquireLock(): () => void {
  try {
    mkdirSync(SKILL_STORE_INTERNAL, { mode: 0o700 });
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error;
  }
  const internal = assertDirectory(SKILL_STORE_INTERNAL);
  internalIdentity = { dev: internal.dev, ino: internal.ino };
  // Persist the private directory before it can hold the only backup copy.
  syncDirectory('.');
  if (
    process.platform !== 'win32' &&
    ((internal.mode & 0o077) !== 0 || internal.uid !== process.getuid?.())
  )
    throw new Error('skill store internal directory must be owned by this user with mode 0700');
  const token = randomUUID();
  return inStoreInternal(() => {
    const candidate = `owner-${token}`;
    secureWrite(candidate, JSON.stringify({ pid: process.pid, token }));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          linkSync(candidate, 'lock');
          const owned = lstatSync('lock');
          return () => {
            // A capture failure can leave cwd at an untrusted replacement.
            // Leave the dead-owner lock for recovery rather than cleaning there.
            if (!atPinnedRoot()) return;
            try {
              inStoreInternal(() => {
                const current = statSync('.');
                if (current.dev !== internal.dev || current.ino !== internal.ino) return;
                const lock = lstatSync('lock');
                if (lock.dev === owned.dev && lock.ino === owned.ino) unlinkSync('lock');
              });
            } catch {
              /* A replaced private directory must not redirect cleanup. */
            }
          };
        } catch (error) {
          if (code(error) !== 'EEXIST') throw error;
          const owner = JSON.parse(readRecord('lock')) as { pid: number };
          if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
            throw new Error('invalid skill store lock owner');
          try {
            process.kill(owner.pid, 0);
          } catch (ownerError) {
            if (code(ownerError) === 'ESRCH') {
              unlinkSync('lock');
              continue;
            }
            throw ownerError;
          }
          throw new Error('skill store is busy; retry after the current transaction');
        }
      }
      throw new Error('could not acquire skill store lock');
    } finally {
      unlinkSync(candidate);
    }
  });
}

function snapshot(name: string): SkillStoreWireEntry | undefined {
  try {
    assertDirectory(name);
  } catch (error) {
    if (code(error) === 'ENOENT') return undefined;
    throw error;
  }
  const files: SkillStoreWireEntry['files'] = Object.create(null);
  const directoryModes: Record<string, number> = Object.create(null);
  const capturedFiles = new Map<string, Stats>();
  const capturedDirectories = new Map<string, Stats>();
  let count = 0;
  let directoryCount = 0;
  let bytes = 0;
  const visit = (relative: string, depth: number): void => {
    if (++directoryCount > SKILL_STORE_LIMITS.files)
      throw new Error('skill tree exceeds directory limit');
    if (depth > SKILL_STORE_LIMITS.depth) throw new Error('skill tree exceeds depth limit');
    const directory = statSync('.');
    directoryModes[relative] = directory.mode & 0o777;
    capturedDirectories.set(relative, directory);
    for (const child of readdirSync('.').sort()) {
      const resource = relative ? `${relative}/${child}` : child;
      assertSkillStoreResource(resource);
      const info = lstatSync(child);
      if (info.isDirectory()) {
        inPinnedDirectory(child, () => visit(resource, depth + 1));
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`unsafe skill resource (symlink or special file): ${resource}`);
      if (++count > SKILL_STORE_LIMITS.files) throw new Error('skill tree exceeds file limit');
      if (bytes + info.size > SKILL_STORE_LIMITS.bytes)
        throw new Error('skill tree exceeds byte limit');
      const fd = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (!sameCapturedFile(info, opened))
          throw new Error('skill resource changed during capture');
        const chunks: Buffer[] = [];
        let length = 0;
        for (;;) {
          const buffer = Buffer.alloc(
            Math.min(65536, SKILL_STORE_LIMITS.bytes - bytes - length + 1),
          );
          const count = readSync(fd, buffer, 0, buffer.length, length);
          if (count === 0) break;
          length += count;
          if (bytes + length > SKILL_STORE_LIMITS.bytes)
            throw new Error('skill tree exceeds byte limit');
          chunks.push(buffer.subarray(0, count));
        }
        const data = Buffer.concat(chunks, length);
        const captured = fstatSync(fd);
        if (!sameCapturedFile(opened, captured) || !sameCapturedFile(opened, lstatSync(child)))
          throw new Error('skill resource changed during capture');
        bytes += data.byteLength;
        if (bytes > SKILL_STORE_LIMITS.bytes) throw new Error('skill tree exceeds byte limit');
        files[resource] = { data: data.toString('base64'), mode: info.mode & 0o777 };
        capturedFiles.set(resource, captured);
      } finally {
        closeSync(fd);
      }
    }
    const current = statSync('.');
    if (
      current.mode !== directory.mode ||
      current.mtimeMs !== directory.mtimeMs ||
      current.ctimeMs !== directory.ctimeMs
    )
      throw new Error('skill directory changed during capture');
  };
  inPinnedDirectory(name, () => {
    visit('', 0);
    // A later resource read can change a leaf whose bytes were captured
    // earlier. Recheck all leaves before accepting the complete tree revision.
    for (const [resource, captured] of capturedFiles) {
      inPinnedPath(dirname(resource), () => {
        if (!sameCapturedFile(captured, lstatSync(basename(resource))))
          throw new Error('skill resource changed during capture');
      });
    }
    for (const [resource, captured] of capturedDirectories) {
      inPinnedPath(resource || '.', () => {
        if (!sameCapturedMetadata(captured, statSync('.')))
          throw new Error('skill directory changed during capture');
      });
    }
  });
  return { name, files, directoryModes, revision: skillStoreRevision({ files, directoryModes }) };
}

function sameCapturedFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && sameCapturedMetadata(left, right);
}

function sameCapturedMetadata(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

type Journal = {
  name: string;
  action: 'publish' | 'delete';
  phase: 'prepared' | 'committed';
  layout?: 'root-leaves';
  revision?: string;
  rootMode?: number;
};
function leaves(txn: string): { staged: string; backup: string } {
  if (!/^txn-[a-f0-9-]+$/.test(txn)) throw new Error('invalid skill transaction identity');
  const id = txn.slice(4);
  return { staged: `.sov-skill-stage-${id}`, backup: `.sov-skill-backup-${id}` };
}

function createStage(staged: string, entry: SkillStoreWireEntry): Stats {
  mkdirSync(staged, { mode: 0o700 });
  const identity = assertDirectory(staged);
  inPinnedDirectory(staged, () => {
    for (const path of Object.keys(entry.directoryModes)
      .filter(Boolean)
      .sort((a, b) => a.length - b.length)) {
      inPinnedPath(dirname(path), () => mkdirSync(basename(path), { mode: 0o700 }));
    }
    for (const [path, file] of Object.entries(entry.files)) {
      inPinnedPath(dirname(path), () =>
        secureWrite(basename(path), Buffer.from(file.data, 'base64'), file.mode),
      );
    }
    for (const [path, mode] of Object.entries(entry.directoryModes)
      .filter(([path]) => path)
      .sort(([a], [b]) => b.length - a.length)) {
      inPinnedPath(path, () => syncDirectory('.', mode));
    }
    // The complete stage stays private until its root is published.
    syncDirectory('.');
  });
  syncDirectory('.');
  return identity;
}

function assertPublishedTree(
  path: string,
  entry: SkillStoreWireEntry,
  identity: Pick<Stats, 'dev' | 'ino'>,
  staged = false,
): void {
  const current = assertDirectory(path);
  if (current.dev !== identity.dev || current.ino !== identity.ino)
    throw new Error('skill publication directory changed during transaction');
  const captured = snapshot(path);
  // A stage is private until its published root mode has been applied.
  if (captured && staged) captured.directoryModes[''] = entry.directoryModes[''] ?? 0o700;
  if (!captured || skillStoreRevision(captured) !== entry.revision)
    throw new Error('skill staged tree changed during transaction');
}

function removeTransaction(txn: string): void {
  inStoreInternal(() => {
    removeTree(txn);
    syncDirectory('.');
  });
}

function recover(): void {
  const transactions = inStoreInternal(() => readdirSync('.').sort());
  for (const txn of transactions) {
    if (!/^txn-[a-f0-9-]+$/.test(txn)) continue;
    const paths = leaves(txn);
    const captured = inStoreInternal(() =>
      inPinnedDirectory(txn, () => {
        if (!existsSync('journal.json')) return undefined;
        const journal = JSON.parse(readRecord('journal.json')) as Journal;
        assertSkillStoreName(journal.name);
        if (
          !['publish', 'delete'].includes(journal.action) ||
          !['prepared', 'committed'].includes(journal.phase) ||
          (journal.layout !== undefined && journal.layout !== 'root-leaves')
        )
          throw new Error('invalid skill transaction journal');
        if (
          journal.layout === 'root-leaves' &&
          journal.action === 'publish' &&
          (!/^[a-f0-9]{64}$/.test(journal.revision ?? '') ||
            !Number.isInteger(journal.rootMode) ||
            (journal.rootMode ?? -1) < 0 ||
            (journal.rootMode ?? 0o1000) > 0o777)
        )
          throw new Error('invalid published skill transaction revision or mode');
        // Legacy records put backup/staged below the private txn. Capture their
        // tree from a pinned cwd; never rename through that mutable ancestor.
        const legacyBackup = journal.layout === undefined ? snapshot('backup') : undefined;
        return {
          journal,
          legacyBackup,
          legacyStaged: journal.layout === undefined && existsSync('staged'),
        };
      }),
    );
    if (!captured) {
      removeTree(paths.staged);
      removeTree(paths.backup);
      removeTransaction(txn);
      continue;
    }
    const { journal, legacyBackup, legacyStaged } = captured;
    const backup = journal.layout === 'root-leaves' ? snapshot(paths.backup) : legacyBackup;
    const stagedExists = journal.layout === 'root-leaves' ? existsSync(paths.staged) : legacyStaged;
    const published = journal.action === 'publish' && !stagedExists && existsSync(journal.name);
    if (published) {
      const accepted = snapshot(journal.name);
      if (!accepted) throw new Error('published skill disappeared during recovery');
      if (journal.layout === 'root-leaves') {
        accepted.directoryModes[''] = journal.rootMode ?? 0o700;
        if (skillStoreRevision(accepted) !== journal.revision)
          throw new Error('recovery conflict; refusing to discard backup for an unexpected target');
        inPinnedDirectory(journal.name, () => syncDirectory('.', journal.rootMode));
      }
    } else if (backup && journal.phase === 'prepared') {
      if (existsSync(journal.name))
        throw new Error('recovery conflict; refusing to replace an unexpected target');
      if (journal.layout === 'root-leaves') renameSync(paths.backup, journal.name);
      else {
        createStage(paths.staged, backup);
        renameSync(paths.staged, journal.name);
      }
      inPinnedDirectory(journal.name, () => syncDirectory('.', backup.directoryModes[''] ?? 0o700));
      syncDirectory('.');
    }
    removeTree(paths.staged);
    removeTree(paths.backup);
    removeTransaction(txn);
    syncDirectory('.');
  }
}

function writeJournal(txn: string, journal: Journal): void {
  inStoreInternal(() =>
    inPinnedDirectory(txn, () => {
      const next = `journal-${randomUUID()}`;
      secureWrite(next, JSON.stringify(journal));
      renameSync(next, 'journal.json');
      syncDirectory('.');
    }),
  );
}

function execute(request: SkillStoreWorkerRequest): {
  entry?: SkillStoreWireEntry;
  previousRevision?: string;
  names?: string[];
  truncated?: boolean;
  generation?: string;
  nextCursor?: string;
} {
  assertSkillStoreName(request.name);
  pinRoot(request);
  assertRootPath(request);
  const root = statSync('.');
  rootIdentity = { dev: root.dev, ino: root.ino };
  const release = acquireLock();
  try {
    recover();
    if (request.action === 'list') {
      const names: string[] = [];
      const directory = opendirSync('.');
      let scanned = 0;
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++scanned > 100_000)
            throw new Error(
              'skill store enumeration exceeds 100000 entries; narrow the explicit store root',
            );
          if (
            !/^[A-Za-z][A-Za-z0-9_-]*$/.test(entry.name) ||
            entry.name === 'agent-created' ||
            !entry.isDirectory() ||
            entry.isSymbolicLink()
          )
            continue;
          const skill = join(entry.name, 'SKILL.md');
          if (existsSync(skill) && lstatSync(skill).isFile() && !lstatSync(skill).isSymbolicLink())
            names.push(entry.name);
        }
      } finally {
        directory.closeSync();
      }
      return pageSkillStoreNames(names.sort(), {
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
      });
    }
    const previous = snapshot(request.name);
    if (request.action === 'read') return previous ? { entry: previous } : {};
    if (request.action === 'create' && previous)
      throw new Error(`skill '${request.name}' already exists`);
    if (request.action !== 'create' && !previous)
      throw new Error(`skill '${request.name}' does not exist`);
    if (
      request.action !== 'create' &&
      (!request.expectedRevision || request.expectedRevision !== previous?.revision)
    ) {
      throw new Error('expectedRevision is required and must match the current skill revision');
    }
    const transaction = `txn-${randomUUID()}`;
    const { staged, backup } = leaves(transaction);
    inStoreInternal(() => {
      mkdirSync(transaction, { mode: 0o700 });
      syncDirectory('.');
    });
    let committed = false;
    let published = false;
    let entry: SkillStoreWireEntry | undefined;
    let stagedIdentity: Pick<Stats, 'dev' | 'ino'> | undefined;
    try {
      if (request.action !== 'delete') {
        const files = request.files ?? previous?.files ?? {};
        const directoryModes = request.directoryModes ?? previous?.directoryModes ?? { '': 0o700 };
        for (const [path, file] of Object.entries(files)) {
          file.mode = previous?.files[path]?.mode ?? file.mode & 0o777;
        }
        for (const path of Object.keys(directoryModes)) {
          directoryModes[path] =
            (previous && Object.hasOwn(previous.directoryModes, path)
              ? previous.directoryModes[path]
              : undefined) ??
            directoryModes[path] ??
            0o700;
        }
        entry = { name: request.name, files, directoryModes, revision: '' };
        validateSkillStoreEntry(entry, request.trustTier);
        entry.revision = skillStoreRevision(entry);
        stagedIdentity = createStage(staged, entry);
      }
      const journal: Journal = {
        name: request.name,
        action: request.action === 'delete' ? 'delete' : 'publish',
        phase: 'prepared',
        layout: 'root-leaves',
        ...(entry ? { revision: entry.revision, rootMode: entry.directoryModes[''] ?? 0o700 } : {}),
      };
      writeJournal(transaction, journal);
      assertRootPath(request);
      if (entry && stagedIdentity) assertPublishedTree(staged, entry, stagedIdentity, true);
      if (previous) {
        // Recheck the whole tree and destination type immediately before
        // commit. An out-of-band editor cannot overwrite an accepted revision.
        if (snapshot(request.name)?.revision !== previous.revision)
          throw new Error('skill changed during transaction');
        renameSync(request.name, backup);
        syncDirectory('.');
        // The pathname can change after the last snapshot and before rename.
        // Validate the tree we actually moved before publishing or deleting it.
        // A mismatch leaves the prepared journal to restore that newer tree.
        if (snapshot(backup)?.revision !== previous.revision)
          throw new Error('skill changed during transaction');
      } else if (existsSync(request.name)) throw new Error('skill appeared during transaction');
      if (entry) {
        renameSync(staged, request.name);
        published = true;
        inPinnedDirectory(request.name, () =>
          syncDirectory('.', entry?.directoryModes[''] ?? 0o700),
        );
        if (!stagedIdentity) throw new Error('missing skill stage identity');
        // Verify what the rename actually published before returning its
        // receipt. Validation of the supplied bytes alone cannot detect a
        // changed stage at the publication boundary.
        assertPublishedTree(request.name, entry, stagedIdentity);
      }
      syncDirectory('.');
      committed = entry !== undefined;
      writeJournal(transaction, { ...journal, phase: 'committed' });
      committed = true;
      removeTree(backup);
      removeTransaction(transaction);
      syncDirectory('.');
      return {
        ...(entry ? { entry } : {}),
        ...(previous ? { previousRevision: previous.revision } : {}),
      };
    } catch (error) {
      // Never turn a successful publish into a reported failure merely because
      // cleanup was interrupted. Recovery treats the durable target as commit.
      if (!atPinnedRoot()) throw error;
      if (committed) {
        return {
          ...(entry ? { entry } : {}),
          ...(previous ? { previousRevision: previous.revision } : {}),
        };
      }
      if (request.action === 'delete' && previous && existsSync(backup)) {
        if (existsSync(request.name)) throw new Error('recovery conflict after deletion failure');
        // A committed marker that failed its flush is not a completed delete.
        // Restore before recovery can interpret that visible marker as final.
        renameSync(backup, request.name);
        syncDirectory('.');
      }
      if (published) {
        // Publication followed by a failed durability check must not become a
        // failed mutation that nevertheless replaced the accepted tree.
        const current = assertDirectory(request.name);
        if (
          !stagedIdentity ||
          current.dev !== stagedIdentity.dev ||
          current.ino !== stagedIdentity.ino
        )
          throw new Error('recovery conflict after publication failure');
        // A changed tree inside our own uncommitted stage can be rolled back.
        // An unrelated replacement directory must remain for manual recovery.
        renameSync(request.name, staged);
        if (previous) renameSync(backup, request.name);
        syncDirectory('.');
      }
      recover();
      throw error;
    }
  } finally {
    if (atPinnedRoot()) release();
  }
}

export async function runSkillStoreWorker(): Promise<void> {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > SKILL_STORE_LIMITS.bytes * 2 + 1024 * 1024)
        throw new Error('skill transaction request exceeds limit');
    }
    const result = execute(JSON.parse(input) as SkillStoreWorkerRequest);
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : String(error) }),
    );
  }
}
