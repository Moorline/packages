import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const implementationPath = existsSync(join(here, 'runtimePackage.js'))
  ? join(here, 'runtimePackage.js')
  : join(here, 'runtimePackage.ts');

const module = await import(pathToFileURL(implementationPath).href);

export default module.default;
