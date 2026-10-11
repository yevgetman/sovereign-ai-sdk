// Filesystem transactions run in a short-lived process. Its kernel cwd pins
// the selected root even if another process renames that root or replaces its
// pathname with a symlink. Node has no portable openat API (Mac /dev/fd does
// not support directory traversal); using absolute destination paths would
// leave a validation/rename race. Every filesystem operation below is relative.
import { randomUUID } from 'node:crypto';
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';
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
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
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
  if (
    process.platform !== 'win32' &&
    ((internal.mode & 0o077) !== 0 || internal.uid !== process.getuid?.())
  )
    throw new Error('skill store internal directory must be owned by this user with mode 0700');
  const token = randomUUID();
  const candidate = join(SKILL_STORE_INTERNAL, `owner-${token}`);
  const lock = join(SKILL_STORE_INTERNAL, 'lock');
  // Hard-link an already-written owner record. A crash cannot leave an empty
  // lock without a PID, so a later transaction can recover a dead owner.
  secureWrite(candidate, JSON.stringify({ pid: process.pid, token }));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(candidate, lock);
        return () => {
          unlinkSync(lock);
        };
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
        const st = lstatSync(lock);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error('unsafe skill store lock');
        const owner = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
          throw new Error('invalid skill store lock owner');
        try {
          process.kill(owner.pid, 0);
        } catch (ownerError) {
          if (code(ownerError) === 'ESRCH') {
            unlinkSync(lock);
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
  let count = 0;
  let directoryCount = 0;
  let bytes = 0;
  const visit = (path: string, relative: string, depth: number): void => {
    if (++directoryCount > SKILL_STORE_LIMITS.files)
      throw new Error('skill tree exceeds directory limit');
    if (depth > SKILL_STORE_LIMITS.depth) throw new Error('skill tree exceeds depth limit');
    directoryModes[relative] = assertDirectory(path).mode & 0o777;
    for (const child of readdirSync(path).sort()) {
      const resource = relative ? `${relative}/${child}` : child;
      assertSkillStoreResource(resource);
      const full = join(path, child);
      const info = lstatSync(full);
      if (info.isDirectory()) {
        visit(full, resource, depth + 1);
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`unsafe skill resource (symlink or special file): ${resource}`);
      if (++count > SKILL_STORE_LIMITS.files) throw new Error('skill tree exceeds file limit');
      if (bytes + info.size > SKILL_STORE_LIMITS.bytes)
        throw new Error('skill tree exceeds byte limit');
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
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
        bytes += data.byteLength;
        if (bytes > SKILL_STORE_LIMITS.bytes) throw new Error('skill tree exceeds byte limit');
        files[resource] = { data: data.toString('base64'), mode: info.mode & 0o777 };
      } finally {
        closeSync(fd);
      }
    }
  };
  visit(name, '', 0);
  return { name, files, directoryModes, revision: skillStoreRevision({ files, directoryModes }) };
}

type Journal = { name: string; action: 'publish' | 'delete'; phase: 'prepared' | 'committed' };
function recover(): void {
  for (const txn of readdirSync(SKILL_STORE_INTERNAL).sort()) {
    if (!/^txn-[a-f0-9-]+$/.test(txn)) continue;
    const dir = join(SKILL_STORE_INTERNAL, txn);
    assertDirectory(dir);
    const journalPath = join(dir, 'journal.json');
    if (!existsSync(journalPath)) {
      rmSync(dir, { recursive: true });
      continue;
    }
    const journalStat = lstatSync(journalPath);
    if (!journalStat.isFile() || journalStat.isSymbolicLink())
      throw new Error('unsafe skill transaction journal');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
    assertSkillStoreName(journal.name);
    if (
      !['publish', 'delete'].includes(journal.action) ||
      !['prepared', 'committed'].includes(journal.phase)
    ) {
      throw new Error('invalid skill transaction journal');
    }
    const backup = join(dir, 'backup');
    const staged = join(dir, 'staged');
    if (existsSync(backup)) {
      assertDirectory(backup);
      if (journal.phase === 'prepared') {
        // A published stage is identified by its disappearance. If commit's
        // marker was not flushed, roll forward when the new target exists.
        if (journal.action === 'publish' && !existsSync(staged) && existsSync(journal.name)) {
          assertDirectory(journal.name);
        } else {
          if (existsSync(journal.name))
            throw new Error('recovery conflict; refusing to replace an unexpected target');
          renameSync(backup, journal.name);
        }
      }
    }
    rmSync(dir, { recursive: true });
    syncDirectory('.');
  }
}

function writeJournal(dir: string, journal: Journal): void {
  const next = join(dir, `journal-${randomUUID()}`);
  secureWrite(next, JSON.stringify(journal));
  renameSync(next, join(dir, 'journal.json'));
  syncDirectory(dir);
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
    const transaction = join(SKILL_STORE_INTERNAL, `txn-${randomUUID()}`);
    mkdirSync(transaction, { mode: 0o700 });
    let committed = false;
    try {
      const staged = join(transaction, 'staged');
      let entry: SkillStoreWireEntry | undefined;
      if (request.action !== 'delete') {
        const files = request.files ?? previous?.files ?? {};
        const directoryModes = request.directoryModes ?? previous?.directoryModes ?? { '': 0o700 };
        // Keep existing destination security modes, including the root and
        // SKILL.md, when replacing a package from a more permissive source.
        for (const [path, file] of Object.entries(files)) {
          file.mode = previous?.files[path]?.mode ?? file.mode & 0o777;
        }
        for (const path of Object.keys(directoryModes)) {
          directoryModes[path] = previous?.directoryModes[path] ?? directoryModes[path] ?? 0o700;
        }
        entry = { name: request.name, files, directoryModes, revision: '' };
        validateSkillStoreEntry(entry, request.trustTier);
        mkdirSync(staged, { mode: 0o700 });
        for (const path of Object.keys(directoryModes)
          .filter(Boolean)
          .sort((a, b) => a.length - b.length)) {
          mkdirSync(join(staged, path), { recursive: true, mode: 0o700 });
        }
        for (const [path, file] of Object.entries(files)) {
          const destination = join(staged, path);
          mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
          secureWrite(destination, Buffer.from(file.data, 'base64'), file.mode);
          chmodSync(destination, file.mode);
        }
        for (const [path, mode] of Object.entries(directoryModes).sort(
          ([a], [b]) => b.length - a.length,
        )) {
          chmodSync(path ? join(staged, path) : staged, mode);
        }
        syncDirectory(staged);
        entry.revision = skillStoreRevision(entry);
      }
      const journal: Journal = {
        name: request.name,
        action: request.action === 'delete' ? 'delete' : 'publish',
        phase: 'prepared',
      };
      writeJournal(transaction, journal);
      assertRootPath(request);
      if (previous) {
        // Recheck the whole tree and destination type immediately before
        // commit. An out-of-band editor cannot overwrite an accepted revision.
        if (snapshot(request.name)?.revision !== previous.revision)
          throw new Error('skill changed during transaction');
        renameSync(request.name, join(transaction, 'backup'));
      } else if (existsSync(request.name)) throw new Error('skill appeared during transaction');
      if (entry) renameSync(staged, request.name);
      syncDirectory('.');
      committed = entry !== undefined;
      writeJournal(transaction, { ...journal, phase: 'committed' });
      committed = true;
      rmSync(transaction, { recursive: true });
      return {
        ...(entry ? { entry } : {}),
        ...(previous ? { previousRevision: previous.revision } : {}),
      };
    } catch (error) {
      // Never turn a successful publish into a reported failure merely because
      // cleanup was interrupted. Recovery treats the durable target as commit.
      if (committed) {
        const entry = snapshot(request.name);
        return {
          ...(entry ? { entry } : {}),
          ...(previous ? { previousRevision: previous.revision } : {}),
        };
      }
      recover();
      throw error;
    }
  } finally {
    release();
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
