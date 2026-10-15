import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';
import { DEFAULT_SKILL_DISCOVERY_LIMITS } from '../skills/discovery.js';

export class ConfigurationError extends Error {
  readonly code = 'configuration_invalid';
  constructor(
    readonly source: string,
    readonly field = 'document',
    reason = 'invalid settings',
  ) {
    super(`Invalid configuration in ${source}: ${field} (${reason}). Check the configuration.`);
    this.name = 'ConfigurationError';
  }
}

/** Bounded regular-file read. Never include rejected values or filesystem errors. */
export function readConfiguration<T>(
  path: string,
  source: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  trustedFile = false,
): T | undefined {
  let fd: number | undefined;
  let parentRealpath: string | undefined;
  try {
    if (trustedFile) {
      try {
        if (lstatSync(dirname(path)).isSymbolicLink())
          throw new ConfigurationError(source, 'document', 'redirected parent');
        parentRealpath = realpathSync(dirname(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (trustedFile ? constants.O_NOFOLLOW : 0),
    );
    if (
      trustedFile &&
      (lstatSync(dirname(path)).isSymbolicLink() || realpathSync(dirname(path)) !== parentRealpath)
    )
      throw new ConfigurationError(source, 'document', 'redirected parent');
    const info = fstatSync(fd);
    if (trustedFile) {
      const current = statSync(path);
      if (current.ino !== info.ino || current.dev !== info.dev)
        throw new ConfigurationError(source, 'document', 'file changed during read');
    }
    const cap = DEFAULT_SKILL_DISCOVERY_LIMITS.maxFileBytes;
    if (!info.isFile() || info.size > cap)
      throw new ConfigurationError(source, 'document', 'not a bounded regular file');
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < buffer.length) {
      const size = readSync(fd, buffer, length, buffer.length - length, null);
      if (size === 0) break;
      length += size;
    }
    if (length > cap) throw new ConfigurationError(source, 'document', 'file too large');
    let raw: unknown;
    try {
      raw = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    } catch {
      throw new ConfigurationError(source, 'document', 'invalid JSON');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // Record schema field names only. Map keys and rejected values are private.
      const safeFields = new Set([
        'skills',
        'discovery',
        'allowedLinkRoots',
        'projectRoot',
        'permissions',
        'allow',
        'deny',
        'ask',
        'permissionMode',
        'hooks',
        'mcpServers',
        'type',
        'url',
        'command',
        'args',
        'env',
        'cwd',
      ]);
      const field =
        parsed.error.issues[0]?.path
          .filter((part) => typeof part === 'string' && safeFields.has(part))
          .join('.') || 'document';
      throw new ConfigurationError(source, field, 'unsupported field or invalid value');
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(source, 'document', 'unreadable or unsafe file');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
