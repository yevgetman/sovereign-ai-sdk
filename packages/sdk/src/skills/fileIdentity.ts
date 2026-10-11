// Pin canonical file and directory identities before a skill resource read.
// A later realpath check alone misses a temporary ancestor swap during open.
import type { Stats } from 'node:fs';
import { type FileHandle, lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

export type SkillFileIdentity = {
  file: Stats;
  directories: Map<string, Pick<Stats, 'dev' | 'ino'>>;
};

async function checkDirectoryChain(
  path: string,
  directories: SkillFileIdentity['directories'],
): Promise<void> {
  const parents: string[] = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    parents.push(parent);
    if (parent === dirname(parent)) break;
  }
  for (const parent of parents.reverse()) {
    const info = await lstat(parent);
    const expected = directories.get(parent);
    if (
      !info.isDirectory() ||
      (expected && (info.dev !== expected.dev || info.ino !== expected.ino))
    )
      throw new Error('skill file ancestor changed while reading');
    directories.set(parent, { dev: info.dev, ino: info.ino });
  }
}

function sameFile(left: Stats, right: Stats): boolean {
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

export async function captureSkillFileIdentity(path: string): Promise<SkillFileIdentity> {
  const directories: SkillFileIdentity['directories'] = new Map();
  await checkDirectoryChain(path, directories);
  const file = await lstat(path);
  if (!file.isFile()) throw new Error('skill file must be a regular file');
  await checkDirectoryChain(path, directories);
  if ((await realpath(path)) !== path) throw new Error('skill file path changed before reading');
  return { directories, file };
}

export async function assertSkillFileIdentity(
  path: string,
  handle: FileHandle,
  identity: SkillFileIdentity,
): Promise<void> {
  if (!sameFile(identity.file, await handle.stat()) || !sameFile(identity.file, await lstat(path)))
    throw new Error('skill file identity changed while reading');
  await checkDirectoryChain(path, identity.directories);
  if ((await realpath(path)) !== path) throw new Error('skill file path changed while reading');
}
