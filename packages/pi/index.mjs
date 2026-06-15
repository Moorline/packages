import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const implementationPath = [
  join(here, 'runtimePackage.js'),
  join(here, 'dist', 'runtimePackage.js'),
  join(here, 'runtimePackage.ts')
].find((candidate) => existsSync(candidate));

if (!implementationPath) {
  throw new Error('Unable to locate Pi runtimePackage implementation.');
}

const module = await import(pathToFileURL(implementationPath).href);

export default module.default;
