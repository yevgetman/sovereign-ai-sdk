import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  SkillMutation,
  SkillMutationEvent,
  SkillMutationResult,
  SkillStoreFile,
  SkillStoreListOptions,
  SkillStoreListPage,
  SkillStoreWireEntry,
  SkillStoreWorkerRequest,
  SkillStoredEntry,
  SkillWritableStore,
} from './storeTypes.js';
import {
  SKILL_STORE_LIMITS,
  assertSkillStoreName,
  assertSkillStoreResource,
  pageSkillStoreNames,
  skillStoreRevision,
  validateSkillStoreEntry,
} from './storeValidation.js';
import type { SkillTrustTier } from './types.js';

export type {
  SkillMutation,
  SkillMutationEvent,
  SkillMutationResult,
  SkillStoredEntry,
  SkillStoreFile,
  SkillStoreListOptions,
  SkillStoreListPage,
  SkillWritableStore,
} from './storeTypes.js';

export type SkillStoreOptions = { trustTier?: SkillTrustTier };
export type FilesystemSkillStoreOptions = SkillStoreOptions & {
  root: string;
  /** Compiled hosts supply their embedded helper command. Default: Node/Bun
   *  launches the SDK's packaged storeWorker module with the same executable. */
  workerCommand?: { executable: string; args: string[] };
};

function encodeFiles(files: ReadonlyMap<string, SkillStoreFile>): SkillStoreWireEntry['files'] {
  const result: SkillStoreWireEntry['files'] = Object.create(null);
  for (const [path, file] of files) {
    assertSkillStoreResource(path);
    result[path] = { data: Buffer.from(file.data).toString('base64'), mode: file.mode ?? 0o600 };
  }
  return result;
}

function decodeEntry(entry: SkillStoreWireEntry, path?: string): SkillStoredEntry {
  return {
    name: entry.name,
    revision: entry.revision,
    content: Buffer.from(entry.files['SKILL.md']?.data ?? '', 'base64').toString('utf8'),
    files: new Map(
      Object.entries(entry.files).map(([path, file]) => [
        path,
        { data: new Uint8Array(Buffer.from(file.data, 'base64')), mode: file.mode },
      ]),
    ),
    directoryModes: new Map(Object.entries(entry.directoryModes)),
    ...(path ? { path } : {}),
  };
}

function prepareEntry(change: SkillMutation, previous?: SkillStoreWireEntry): SkillStoreWireEntry {
  const files = change.files ? encodeFiles(change.files) : structuredClone(previous?.files ?? {});
  if (change.content !== undefined) {
    files['SKILL.md'] = {
      data: Buffer.from(change.content).toString('base64'),
      mode: previous?.files['SKILL.md']?.mode ?? files['SKILL.md']?.mode ?? 0o600,
    };
  }
  const directoryModes = change.directoryModes
    ? Object.fromEntries(change.directoryModes)
    : structuredClone(previous?.directoryModes ?? { '': 0o700 });
  directoryModes[''] ??= previous?.directoryModes[''] ?? 0o700;
  // Recursive mkdir creates these ancestors on disk. Include them in the
  // accepted tree so the commit revision is the revision returned by read().
  for (const path of Object.keys(directoryModes)) {
    if (path) assertSkillStoreResource(path);
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const directory = parts.slice(0, depth).join('/');
      directoryModes[directory] ??= previous?.directoryModes[directory] ?? 0o700;
    }
  }
  for (const [path, file] of Object.entries(files)) {
    file.mode = previous?.files[path]?.mode ?? file.mode;
    const parts = path.split('/').slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++) {
      const directory = parts.slice(0, depth).join('/');
      directoryModes[directory] ??= 0o700;
    }
  }
  for (const path of Object.keys(directoryModes))
    directoryModes[path] = previous?.directoryModes[path] ?? directoryModes[path] ?? 0o700;
  return {
    name: change.name,
    files,
    directoryModes,
    revision: skillStoreRevision({ files, directoryModes }),
  };
}

abstract class ObservableSkillStore implements SkillWritableStore {
  private readonly listeners = new Set<(event: SkillMutationEvent) => void>();
  abstract list(options?: SkillStoreListOptions): Promise<SkillStoreListPage>;
  abstract read(name: string): Promise<SkillStoredEntry | undefined>;
  abstract mutate(change: SkillMutation): Promise<SkillMutationResult>;
  subscribe(listener: (event: SkillMutationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  protected committed(event: SkillMutationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...event });
      } catch {
        /* A committed write is not undone by an observer. */
      }
    }
  }
}

/** Explicit no-disk writable store for embedded agents, tests and custom hosts. */
export class InMemorySkillStore extends ObservableSkillStore {
  private readonly entries = new Map<string, SkillStoreWireEntry>();
  constructor(private readonly options: SkillStoreOptions = {}) {
    super();
  }
  async list(options: SkillStoreListOptions = {}): Promise<SkillStoreListPage> {
    return pageSkillStoreNames([...this.entries.keys()].sort(), options);
  }
  async read(name: string): Promise<SkillStoredEntry | undefined> {
    assertSkillStoreName(name);
    const entry = this.entries.get(name);
    return entry ? decodeEntry(entry) : undefined;
  }
  async mutate(change: SkillMutation): Promise<SkillMutationResult> {
    assertSkillStoreName(change.name);
    const previous = this.entries.get(change.name);
    if (change.action === 'create' && previous)
      throw new Error(`skill '${change.name}' already exists`);
    if (change.action !== 'create' && !previous)
      throw new Error(`skill '${change.name}' does not exist`);
    if (
      change.action !== 'create' &&
      (!change.expectedRevision || change.expectedRevision !== previous?.revision)
    ) {
      throw new Error('expectedRevision is required and must match the current skill revision');
    }
    let entry: SkillStoreWireEntry | undefined;
    if (change.action !== 'delete') {
      entry = prepareEntry(change, previous);
      validateSkillStoreEntry(entry, this.options.trustTier ?? 'agent-created');
      this.entries.set(change.name, entry);
    } else this.entries.delete(change.name);
    const event: SkillMutationEvent = {
      action: change.action,
      name: change.name,
      ...(entry ? { revision: entry.revision } : {}),
      ...(previous ? { previousRevision: previous.revision } : {}),
    };
    this.committed(event);
    return { event, ...(entry ? { entry: decodeEntry(entry) } : {}) };
  }
}

/** Recoverable process-serialized filesystem store. A stable cwd worker keeps
 *  all destination effects inside the selected root through pathname races. */
export class FilesystemSkillStore extends ObservableSkillStore {
  readonly root: string;
  constructor(private readonly options: FilesystemSkillStoreOptions) {
    super();
    if (!options.root) throw new Error('an explicit writable skill root is required');
    this.root = resolve(options.root);
  }
  async list(options: SkillStoreListOptions = {}): Promise<SkillStoreListPage> {
    const result = await this.request({ name: 'store-list', action: 'list', ...options });
    return {
      names: result.names ?? [],
      truncated: result.truncated ?? false,
      generation: result.generation ?? '',
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }
  async read(name: string): Promise<SkillStoredEntry | undefined> {
    const result = await this.request({ name, action: 'read' });
    return result.entry ? decodeEntry(result.entry, join(this.root, name, 'SKILL.md')) : undefined;
  }
  async mutate(change: SkillMutation): Promise<SkillMutationResult> {
    assertSkillStoreName(change.name);
    let entry: SkillStoreWireEntry | undefined;
    if (change.action !== 'delete') {
      // Snapshot sidecars only when editing in place. The worker compares the
      // caller's expected revision again under the process lock at publication.
      const previous =
        change.action === 'edit'
          ? await this.request({ name: change.name, action: 'read' })
          : undefined;
      if (change.action === 'edit' && !previous?.entry)
        throw new Error(`skill '${change.name}' does not exist`);
      entry = prepareEntry(change, previous?.entry);
      validateSkillStoreEntry(entry, this.options.trustTier ?? 'agent-created');
    }
    const result = await this.request({
      name: change.name,
      action: change.action,
      ...(change.expectedRevision !== undefined
        ? { expectedRevision: change.expectedRevision }
        : {}),
      ...(entry ? { files: entry.files, directoryModes: entry.directoryModes } : {}),
    });
    const path = join(this.root, change.name, 'SKILL.md');
    const event: SkillMutationEvent = {
      action: change.action,
      name: change.name,
      path,
      ...(result.entry ? { revision: result.entry.revision } : {}),
      ...(result.previousRevision ? { previousRevision: result.previousRevision } : {}),
    };
    this.committed(event);
    return { event, ...(result.entry ? { entry: decodeEntry(result.entry, path) } : {}) };
  }

  private async request(
    change: Pick<
      SkillStoreWorkerRequest,
      'name' | 'action' | 'files' | 'directoryModes' | 'expectedRevision' | 'cursor' | 'limit'
    >,
  ): Promise<{
    entry?: SkillStoreWireEntry;
    previousRevision?: string;
    names?: string[];
    truncated?: boolean;
    generation?: string;
    nextCursor?: string;
  }> {
    assertSkillStoreName(change.name);
    let ancestor = this.root;
    const segments: string[] = [];
    let selectedIdentity: { dev: number; ino: number } | undefined;
    for (;;) {
      try {
        let info = await lstat(ancestor);
        if (info.isSymbolicLink() && segments.length > 0) info = await stat(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('skill store root must be a real directory, not a symlink');
        selectedIdentity = { dev: info.dev, ino: info.ino };
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        segments.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
    ancestor = await realpath(ancestor);
    const info = await lstat(ancestor);
    if (info.dev !== selectedIdentity?.dev || info.ino !== selectedIdentity?.ino)
      throw new Error('skill store ancestor changed during selection');
    const request: SkillStoreWorkerRequest = {
      ...change,
      ancestorIdentity: { dev: info.dev, ino: info.ino },
      segments,
      rootPath: join(ancestor, ...segments),
      trustTier: this.options.trustTier ?? 'agent-created',
    };
    const modulePath = fileURLToPath(
      new URL(
        import.meta.url.endsWith('.ts') ? './storeWorkerEntry.ts' : './storeWorkerEntry.js',
        import.meta.url,
      ),
    );
    const command = this.options.workerCommand ?? {
      executable: process.execPath,
      args: [modulePath, '--sov-skill-store-worker'],
    };
    if (!this.options.workerCommand && !existsSync(modulePath))
      throw new Error('compiled host must supply an embedded skill store workerCommand');
    return await new Promise((resolveResult, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd: ancestor,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let diagnostic = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('skill store worker timed out; retry to recover its transaction'));
      }, 20_000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > SKILL_STORE_LIMITS.bytes * 2 + 1024 * 1024) {
          child.kill();
          reject(new Error('skill store response exceeds limit'));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (diagnostic.length < 4096) diagnostic += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        try {
          if (exitCode !== 0)
            throw new Error(`skill store worker failed (${exitCode}): ${diagnostic}`);
          const result = JSON.parse(output) as {
            ok: boolean;
            reason?: string;
            entry?: SkillStoreWireEntry;
            previousRevision?: string;
            names?: string[];
            truncated?: boolean;
            generation?: string;
            nextCursor?: string;
          };
          if (!result.ok) throw new Error(result.reason ?? 'skill transaction failed');
          resolveResult(result);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.on('error', () => {
        /* Worker failure is reported from close/error. */
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

type SourceDirectoryIdentities = Map<string, Pick<Stats, 'dev' | 'ino'>>;

async function checkSourceDirectoryChain(
  path: string,
  identities: SourceDirectoryIdentities,
): Promise<void> {
  const parents: string[] = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    parents.push(parent);
    if (parent === dirname(parent)) break;
  }
  for (const parent of parents.reverse()) {
    const info = await lstat(parent);
    const expected = identities.get(parent);
    if (
      !info.isDirectory() ||
      (expected && (info.dev !== expected.dev || info.ino !== expected.ino))
    )
      throw new Error('skill source changed during capture');
    identities.set(parent, { dev: info.dev, ino: info.ino });
  }
}

function sameSourceFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function checkCapturedSourceFile(
  path: string,
  file: FileHandle,
  captured: Stats,
  identities: SourceDirectoryIdentities,
): Promise<void> {
  // Realpath equality alone misses an ancestor swapped away for the read and
  // restored afterward. Compare the captured handle to the current leaf too.
  if (!sameSourceFile(captured, await file.stat()) || !sameSourceFile(captured, await lstat(path)))
    throw new Error('skill source changed during capture');
  await checkSourceDirectoryChain(path, identities);
}

/** Capture imported resources without copying links into the writable store.
 *  In-tree aliases retain their bytes and modes; outside/dangling links fail. */
export async function readSkillSourceTree(source: string): Promise<{
  files: ReadonlyMap<string, SkillStoreFile>;
  directoryModes: ReadonlyMap<string, number>;
}> {
  const root = await realpath(source);
  const identities: SourceDirectoryIdentities = new Map();
  await checkSourceDirectoryChain(root, identities);
  const files = new Map<string, SkillStoreFile>();
  const directories = new Map<string, number>();
  let bytes = 0;
  const visit = async (path: string, resource: string, ancestors: Set<string>): Promise<void> => {
    const actual = await realpath(path);
    const rel = relative(root, actual);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
      throw new Error(`symlink escapes skill source: ${resource}`);
    await checkSourceDirectoryChain(actual, identities);
    const info = await lstat(actual);
    if (info.isDirectory()) {
      if (ancestors.has(actual)) throw new Error('skill source contains a directory symlink cycle');
      if (resource.split('/').length > SKILL_STORE_LIMITS.depth)
        throw new Error('skill tree exceeds depth limit');
      if (directories.size >= SKILL_STORE_LIMITS.files)
        throw new Error('skill source exceeds directory limit');
      const expected = identities.get(actual);
      if (expected && (info.dev !== expected.dev || info.ino !== expected.ino))
        throw new Error('skill source changed during capture');
      identities.set(actual, { dev: info.dev, ino: info.ino });
      directories.set(resource, info.mode & 0o777);
      const next = new Set([...ancestors, actual]);
      for (const child of (await readdir(actual)).sort())
        await visit(join(actual, child), resource ? `${resource}/${child}` : child, next);
      const current = await lstat(actual);
      if (
        !current.isDirectory() ||
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        current.mode !== info.mode ||
        current.mtimeMs !== info.mtimeMs ||
        current.ctimeMs !== info.ctimeMs
      )
        throw new Error('skill source changed during capture');
      await checkSourceDirectoryChain(actual, identities);
      return;
    }
    assertSkillStoreResource(resource);
    if (!info.isFile()) throw new Error('skill source contains a special file');
    if (files.size >= SKILL_STORE_LIMITS.files || info.size + bytes > SKILL_STORE_LIMITS.bytes)
      throw new Error('skill source exceeds file or byte limit');
    await checkSourceDirectoryChain(actual, identities);
    const file = await open(
      actual,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await file.stat();
      if (!sameSourceFile(info, opened)) throw new Error('skill source changed during capture');
      const data = await readSourceData(file, SKILL_STORE_LIMITS.bytes - bytes);
      bytes += data.length;
      if (
        bytes > SKILL_STORE_LIMITS.bytes ||
        (await realpath(source)) !== root ||
        (await realpath(path)) !== actual
      )
        throw new Error('skill source changed during capture or exceeded limits');
      await checkCapturedSourceFile(actual, file, opened, identities);
      files.set(resource, { data: new Uint8Array(data), mode: info.mode & 0o777 });
    } finally {
      await file.close();
    }
  };
  await visit(root, '', new Set());
  if ((await realpath(source)) !== root) throw new Error('skill source changed during capture');
  return { files, directoryModes: directories };
}

async function readSourceData(file: FileHandle, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const buffer = Buffer.alloc(Math.min(65536, maximum - bytes + 1));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, bytes);
    if (!bytesRead) break;
    bytes += bytesRead;
    if (bytes > maximum) throw new Error('skill source exceeds byte limit');
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, bytes);
}

export async function readSkillSourceFile(path: string): Promise<Uint8Array> {
  const selected = await realpath(path);
  const identities: SourceDirectoryIdentities = new Map();
  await checkSourceDirectoryChain(selected, identities);
  const info = await lstat(selected);
  if (!info.isFile() || info.size > SKILL_STORE_LIMITS.bytes)
    throw new Error('invalid skill source file or byte limit exceeded');
  await checkSourceDirectoryChain(selected, identities);
  const file = await open(
    selected,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (!sameSourceFile(info, opened)) throw new Error('skill source changed during capture');
    const data = await readSourceData(file, SKILL_STORE_LIMITS.bytes);
    if ((await realpath(path)) !== selected) throw new Error('skill source changed during capture');
    await checkCapturedSourceFile(selected, file, opened, identities);
    return new Uint8Array(data);
  } finally {
    await file.close();
  }
}
