import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const legacyRepoSlug = [`Ryz${'on3'}`, 'Moorline'].join('/');
const officialPackages = [
  'admin-control',
  'basic-essentials',
  'channel-lifecycle',
  'codex',
  'codex-default',
  'discord',
  'discord-default',
  'main-chat',
  'memory',
  'model-picker',
  'persona',
  'self-edit',
  'session-agent',
  'session-commands',
  'session-orchestration',
  'skills',
  'status'
];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function packageJson(name: string): Record<string, unknown> {
  return readJson(join(root, 'packages', name, 'package.json'));
}

describe('official package repository contract', () => {
  it('contains only official installable packages', () => {
    expect(readdirSync(join(root, 'packages')).sort()).toEqual(officialPackages);
    expect(existsSync(join(root, 'packages', 'http'))).toBe(false);
    expect(existsSync(join(root, 'packages', 'package-kit'))).toBe(false);
  });

  it('keeps the workspace private and points at the packages repo', () => {
    const pkg = readJson(join(root, 'package.json'));
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe('MIT');
    expect(pkg.repository).toMatchObject({
      url: 'git+ssh://git@github.com/Moorline/packages.git'
    });
    expect((pkg.devDependencies as Record<string, string>)['@moorline/package-kit']).toBe('0.0.1');
  });

  it('keeps official package metadata aligned with manifest surfaces', () => {
    const expectedKinds: Record<string, string> = {
      codex: 'provider',
      discord: 'transport',
      'basic-essentials': 'bundle',
      'codex-default': 'bundle',
      'discord-default': 'bundle'
    };
    for (const name of officialPackages) {
      const manifest = readJson(join(root, 'packages', name, 'manifest.json')) as { id: string; type: string };
      const expectedKind = expectedKinds[name] ?? 'plugin';
      expect(manifest.id).toBe(`official/${name}`);
      expect(manifest.type).toBe(expectedKind);
      expect(packageJson(name).license).toBe('MIT');
      expect(packageJson(name).moorline).toMatchObject({
        packageId: manifest.id,
        kind: expectedKind
      });
    }
  });

  it('keeps self-edit fallback SOUL asset packaged locally', () => {
    const source = readFileSync(join(root, 'packages', 'self-edit', 'index.mjs'), 'utf8');
    expect(source).toContain("new URL('./SOUL.md', import.meta.url)");
    expect(existsSync(join(root, 'packages', 'self-edit', 'SOUL.md'))).toBe(true);
  });

  it('builds archives and catalog artifacts from package-kit without a local kit source tree', () => {
    const installables = readFileSync(join(root, 'tools', 'installables', 'build-official-installables.mjs'), 'utf8');
    const npmPackages = readFileSync(join(root, 'tools', 'installables', 'build-official-npm-packages.mjs'), 'utf8');
    const catalog = readFileSync(join(root, 'tools', 'installables', 'build-official-catalog.mjs'), 'utf8');
    expect(installables).toContain("import('@moorline/package-kit')");
    expect(npmPackages).toContain("import('@moorline/package-kit')");
    expect(catalog).toContain('github.com/Moorline/packages/releases/download');
    expect(installables).not.toContain("packages', 'package-kit'");
    expect(npmPackages).not.toContain("packages', 'package-kit'");
  });

  it('keeps release automation manual and non-publishing', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).not.toContain('tags:');
    expect(workflow).not.toContain('npm publish');
    expect(workflow).not.toContain('softprops/action-gh-release');
  });

  it('keeps public docs and tooling pointed at the Moorline org', () => {
    const files = [
      'README.md',
      'tools/installables/build-official-catalog.mjs',
      '.github/workflows/release.yml'
    ];
    for (const file of files) {
      expect(readFileSync(join(root, file), 'utf8')).not.toContain(legacyRepoSlug);
    }
  });
});
