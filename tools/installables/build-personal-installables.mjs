import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const validateOnly = process.argv.includes('--validate-only');

function removeDirWithRetries(path, attempts = 5) {
  console.log(`[moorline] removing generated installable output: ${path}`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (error) {
      if (attempt === attempts - 1) {
        throw error;
      }
    }
  }
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
      return manifest.type === surface && typeof manifest.id === 'string' && manifest.id.startsWith('rync/');
    })
    .sort();
}

function archiveFileName(surface, packageDir, version) {
  const rel = relative(join(projectRoot, 'packages'), packageDir).replaceAll('\\', '-').replaceAll('/', '-');
  return `moorline-${surface}-${rel}-${version}.tar.gz`;
}

const bundleRoot = join(projectRoot, 'dist', 'installables');
const archiveRoot = join(projectRoot, 'dist', 'installable-archives');

if (!validateOnly) {
  removeDirWithRetries(bundleRoot);
  removeDirWithRetries(archiveRoot);
} else {
  console.log('[moorline] validate-only installables run; generated installable output is not removed.');
}
mkdirSync(bundleRoot, { recursive: true });
mkdirSync(archiveRoot, { recursive: true });

const { bundlePackage, validatePackagePath } = await loadPackageKit();
const surfaces = ['provider', 'transport', 'plugin', 'skill', 'bundle'];

for (const surface of surfaces) {
  for (const packageDir of listPackageDirs(surface)) {
    const rel = relative(join(projectRoot, 'packages'), packageDir);
    const outputDir = join(bundleRoot, `${surface}s`, rel);
    const validated = await validatePackagePath({
      path: packageDir,
      surface
    });
    const archiveName = archiveFileName(surface, packageDir, validated.manifest.version);
    if (!validateOnly) {
      await bundlePackage({
        sourceDir: packageDir,
        outDir: outputDir,
        archive: true,
        archiveFormat: 'tar.gz',
        surface,
        archiveFileName: archiveName,
        archiveOutDir: join(archiveRoot, `${surface}s`, dirname(rel)),
        runtimeSmoke: false
      });
    } else {
      await validatePackagePath({
        path: outputDir,
        surface
      });
    }
  }
}
