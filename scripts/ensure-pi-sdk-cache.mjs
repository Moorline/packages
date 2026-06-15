import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const piCodingAgentVersion = '0.79.3';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = join(projectRoot, '.cache', 'pi-sdk');
const packageJsonPath = join(cacheRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');

function installedVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return typeof packageJson.version === 'string' ? packageJson.version : null;
  } catch {
    return null;
  }
}

if (installedVersion() !== piCodingAgentVersion) {
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(
    join(cacheRoot, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        overrides: {}
      },
      null,
      2
    )}\n`
  );
  const result = spawnSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      `@earendil-works/pi-coding-agent@${piCodingAgentVersion}`
    ],
    {
      cwd: cacheRoot,
      stdio: 'inherit'
    }
  );
  if (result.status !== 0) {
    throw new Error(`Unable to install @earendil-works/pi-coding-agent@${piCodingAgentVersion} into ${cacheRoot}.`);
  }
}
