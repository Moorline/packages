import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function removeDir(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function loadPackageKit() {
  return await import('@moorline/package-kit');
}

function listPackageDirs(surface) {
  const root = join(projectRoot, 'packages');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((dir) => existsSync(join(dir, 'manifest.json')))
    .filter((dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      return manifest.type === surface && typeof manifest.id === 'string' && manifest.id.startsWith('official/');
    })
    .sort();
}

function officialNpmName(packageId) {
  const [namespace, name] = packageId.split('/');
  if (namespace !== 'official' || !name) {
    throw new Error(`Official npm packages must use official/* package ids: ${packageId}`);
  }
  return `@moorline/${name}`;
}

const packageRoot = join(projectRoot, 'dist', 'npm-packages');
const tarballRoot = join(projectRoot, 'dist', 'npm-tarballs');
removeDir(packageRoot);
removeDir(tarballRoot);
mkdirSync(packageRoot, { recursive: true });
mkdirSync(tarballRoot, { recursive: true });

const { npmPackPackage, validatePackagePath } = await loadPackageKit();
const packages = [];
const surfaces = ['provider', 'transport', 'plugin', 'skill', 'bundle'];

for (const surface of surfaces) {
  for (const packageDir of listPackageDirs(surface)) {
    const validated = await validatePackagePath({
      path: packageDir,
      surface
    });
    const npmName = officialNpmName(validated.manifest.id);
    const packed = await npmPackPackage({
      sourceDir: packageDir,
      outDir: packageRoot,
      npmName,
      access: 'public'
    });
    packages.push({
      packageId: packed.packageId,
      kind: packed.kind,
      version: packed.version,
      npmName: packed.npmName,
      directory: relative(projectRoot, packed.npmPackageDir),
      tarball: packed.tarballPath ? relative(projectRoot, packed.tarballPath) : null
    });
  }
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  packages
};
writeFileSync(join(packageRoot, 'moorline-npm-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(`[moorline] built ${packages.length} official npm package(s).`);
