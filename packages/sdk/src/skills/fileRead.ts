import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { assertSkillFileIdentity, captureSkillFileIdentity } from './fileIdentity.js';

/** Pin metadata before opening. A post-read stat alone can observe an outside
 * replacement which is restored before the separate realpath check. */
export async function readBoundedSkillContent(
  path: string,
  canonical: string,
  maxBytes: number,
  onRead?: (bytes: number) => void,
): Promise<string> {
  if ((await realpath(path)) !== canonical || (await realpath(canonical)) !== canonical)
    throw new Error('skill real path changed before reading');
  const identity = await captureSkillFileIdentity(canonical);
  if (identity.file.size > maxBytes) throw new Error('skill file exceeds the bounded read limit');
  if ((await realpath(path)) !== canonical || (await realpath(canonical)) !== canonical)
    throw new Error('skill real path changed before opening');
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    await assertSkillFileIdentity(canonical, handle, identity);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    onRead?.(Math.min(length, maxBytes));
    if (length > maxBytes) throw new Error('skill file exceeds the bounded read limit');
    if ((await realpath(path)) !== canonical || (await realpath(canonical)) !== canonical)
      throw new Error('skill real path or file identity changed while reading');
    await assertSkillFileIdentity(canonical, handle, identity);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}
