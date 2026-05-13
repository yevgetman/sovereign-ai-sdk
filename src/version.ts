// Single source of truth for the package version. Reads from package.json
// at module load so /health, --version, and any other surface that prints
// a build identifier all agree with the manifest the package was installed
// under. Previously these were hardcoded literals that drifted (health
// reported '0.0.1' while package.json said '0.1.0').

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_PATH = join(dirname(fileURLToPath(import.meta.url)), '../package.json');

export const VERSION: string = (JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version: string })
  .version;
