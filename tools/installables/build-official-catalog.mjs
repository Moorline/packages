import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const releaseBaseUrl = 'https://github.com/Moorline/packages/releases/download';
const surfaces = ['provider', 'transport', 'plugin', 'skill', 'bundle'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function archiveFileName(surface, packageDir, version) {
  const rel = relative(join(projectRoot, 'packages'), packageDir).replaceAll('\\', '-').replaceAll('/', '-');
  return `moorline-${surface}-${rel}-${version}.tar.gz`;
}

function findArchiveByBasename(root, archiveName) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = statSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile() && entry.name === archiveName) {
        return child;
      }
    }
  }
  return null;
}

function archiveSha256(archiveName) {
  const archiveRoot = join(projectRoot, 'dist', 'installable-archives');
  const archivePath = findArchiveByBasename(archiveRoot, archiveName);
  if (!archivePath) {
    return undefined;
  }
  return createHash('sha256').update(readFileSync(archivePath)).digest('hex');
}

function listPackageDirs(surface) {
  const root = join(projectRoot, 'packages');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((dir) => existsSync(join(dir, 'manifest.json')))
    .filter((dir) => {
      const manifest = readJson(join(dir, 'manifest.json'));
      return manifest.type === surface && typeof manifest.id === 'string' && manifest.id.startsWith('official/');
    })
    .sort();
}

function suggestedAfterInstall(catalog, surface, packageId) {
  if (surface !== 'transport') {
    return [];
  }
  return catalog
    .filter((entry) => entry.surface === 'plugin' && entry.requires.includes(packageId))
    .map((entry) => entry.packageId)
    .sort();
}

function buildCatalog() {
  const catalog = [];
  for (const surface of surfaces) {
    for (const packageDir of listPackageDirs(surface)) {
      const manifest = readJson(join(packageDir, 'manifest.json'));
      const distro = readJson(join(packageDir, 'moorline.dist.json'));
      const version = distro.display?.version ?? manifest.version;
      const recommendedForSetup = distro.distribution?.recommendedForSetup === true;
      const releaseRef = recommendedForSetup ? distro.release?.recommendedRef ?? 'v0.0.1' : 'v0.0.1';
      const archiveName = archiveFileName(surface, packageDir, version);
      const sha256 = archiveSha256(basename(archiveName));
      if (recommendedForSetup && !sha256 && process.env.MOORLINE_ALLOW_MISSING_RECOMMENDED_CHECKSUMS !== '1') {
        throw new Error(`Recommended official package ${manifest.id} is missing a generated archive checksum.`);
      }
      catalog.push({
        kind: surface,
        surface,
        packageId: manifest.id,
        name: distro.display?.name ?? manifest.name,
        description: distro.display?.description ?? manifest.description,
        version,
        recommendedForSetup,
        tags: distro.display?.tags ?? [],
        source: {
          kind: 'remote_archive',
          url: `${releaseBaseUrl}/${releaseRef}/${archiveName}`,
          ...(sha256 ? { sha256 } : {})
        },
        requires: Array.isArray(manifest.dependencies)
          ? manifest.dependencies.map((dependency) => dependency.packageId)
          : [],
        ...(Array.isArray(manifest.members) ? { members: manifest.members } : {})
      });
    }
  }

  return catalog.map((entry) => {
    const suggestions = suggestedAfterInstall(catalog, entry.surface, entry.packageId);
    return suggestions.length > 0 ? { ...entry, suggestedAfterInstall: suggestions } : entry;
  });
}

const outputPath = join(projectRoot, 'dist', 'resources', 'official-catalog.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(buildCatalog(), null, 2)}\n`, 'utf8');
console.log(`[moorline] wrote ${relative(projectRoot, outputPath)}`);
