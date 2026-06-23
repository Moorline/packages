import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { toDiscordSendPayloads } from '../../packages/discord/adapter/discordPayload.js';
import { PiProviderService } from '../../packages/pi/providerService.js';

const root = process.cwd();
const legacyRepoSlug = [`Ryz${'on3'}`, 'Moorline'].join('/');
const ryncPackages = [
  'basic-essentials',
  'discord',
  'discord-default',
  'discord-runtime',
  'memory',
  'persona',
  'pi'
];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function packageJson(name: string): Record<string, unknown> {
  return readJson(join(root, 'packages', name, 'package.json'));
}

function collectFiles(dir: string, extensions: Set<string>): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') {
      return [];
    }
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return collectFiles(path, extensions);
    }
    return extensions.has(entry.slice(entry.lastIndexOf('.'))) ? [path] : [];
  });
}

describe('personal package repository contract', () => {
  it('contains only personal installable packages', () => {
    expect(readdirSync(join(root, 'packages')).sort()).toEqual(ryncPackages);
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
    expect((pkg.devDependencies as Record<string, string>)['@moorline/package-kit']).toBe('0.0.3');
  });

  it('keeps personal package metadata aligned with manifest surfaces', () => {
    const expectedKinds: Record<string, string> = {
      pi: 'provider',
      discord: 'transport',
      'basic-essentials': 'bundle',
      'discord-default': 'bundle'
    };
    for (const name of ryncPackages) {
      const manifest = readJson(join(root, 'packages', name, 'manifest.json')) as { id: string; type: string };
      const expectedKind = expectedKinds[name] ?? 'plugin';
      expect(manifest.id).toBe(`rync/${name}`);
      expect(manifest.type).toBe(expectedKind);
      expect(packageJson(name).license).toBe('MIT');
      expect(packageJson(name).moorline).toMatchObject({
        packageId: manifest.id,
        kind: expectedKind
      });
    }
  });

  it('keeps persona fallback SOUL asset packaged locally and editable', () => {
    const source = readFileSync(join(root, 'packages', 'persona', 'index.mjs'), 'utf8');
    expect(source).toContain("new URL('./SOUL.md', import.meta.url)");
    expect(source).toContain("name: 'edit_soul'");
    expect(existsSync(join(root, 'packages', 'persona', 'SOUL.md'))).toBe(true);
  });

  it('keeps Discord runtime prompt files available to both source and bundled entrypoints', () => {
    const routingPrompt = readFileSync(join(root, 'packages', 'discord-runtime', 'modules', 'routing', 'session.md'), 'utf8');
    const bundledPrompt = readFileSync(join(root, 'packages', 'discord-runtime', 'session.md'), 'utf8');
    const packageFiles = packageJson('discord-runtime').files as string[];
    expect(bundledPrompt).toBe(routingPrompt);
    expect(packageFiles).toContain('session.md');
  });

  it('keeps Discord runtime capabilities aligned with package behavior', () => {
    const manifest = readJson(join(root, 'packages', 'discord-runtime', 'manifest.json')) as { capabilities: string[] };
    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      'transport.message.send',
      'provider.headless.run',
      'net.connect'
    ]));
  });

  it('splits long Discord message content into Discord-sized sends', () => {
    expect(toDiscordSendPayloads({ content: 'a'.repeat(2000) })).toHaveLength(1);

    const split = toDiscordSendPayloads({
      content: `${'a'.repeat(1990)}\n\n${'b'.repeat(50)}`,
      embeds: [{ title: 'Title' }],
      buttons: [{ id: 'ok', label: 'OK', style: 'primary' }]
    });
    expect(split).toHaveLength(2);
    expect(split.every((payload) => (payload.content?.length ?? 0) <= 2000)).toBe(true);
    expect(split[0].embeds).toHaveLength(1);
    expect(split[0].buttons).toHaveLength(1);
    expect(split[1].embeds).toBeUndefined();
    expect(split[1].buttons).toBeUndefined();

    const hardSplit = toDiscordSendPayloads({ content: 'x'.repeat(2001) });
    expect(hardSplit).toHaveLength(2);
    expect(hardSplit.every((payload) => (payload.content?.length ?? 0) <= 2000)).toBe(true);
  });

  it('keeps source-checkout provider and transport entrypoints compatible with built dist output', () => {
    for (const name of ['discord', 'pi']) {
      const source = readFileSync(join(root, 'packages', name, 'index.mjs'), 'utf8');
      expect(source).toContain("join(here, 'dist', 'runtimePackage.js')");
      expect(source).toContain('runtimePackage.ts');
    }
  });

  it('builds archives and npm package artifacts from package-kit without a local kit source tree', () => {
    const installables = readFileSync(join(root, 'tools', 'installables', 'build-personal-installables.mjs'), 'utf8');
    const npmPackages = readFileSync(join(root, 'tools', 'installables', 'build-personal-npm-packages.mjs'), 'utf8');
    expect(installables).toContain("import('@moorline/package-kit')");
    expect(npmPackages).toContain("import('@moorline/package-kit')");
    expect(npmPackages).toContain("const surfaces = ['provider', 'bundle'];");
    expect(npmPackages).toContain('embeddedMemberSourceDirs');
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
      '.github/workflows/release.yml'
    ];
    for (const file of files) {
      expect(readFileSync(join(root, file), 'utf8')).not.toContain(legacyRepoSlug);
    }
  });

  it('keeps package-facing text aligned with operator-controlled runtime language', () => {
    const files = [
      join(root, 'README.md'),
      join(root, 'docs', 'PERSONAL_PACKAGES.md'),
      ...collectFiles(join(root, 'packages'), new Set(['.json', '.md', '.mjs']))
    ].filter((file) => !file.endsWith('docs/TERMINOLOGY.md'));
    const forbidden = [
      'local-first',
      'local first',
      'chat-centered',
      'main chat',
      'main-chat',
      'trusted local runtime',
      'local runtime code',
      'durable local state',
      'live coding sessions',
      'session-channel',
      'transport-specific sessions'
    ];
    for (const file of files) {
      const lower = readFileSync(file, 'utf8').toLowerCase();
      for (const phrase of forbidden) {
        expect(lower, `${file} should not contain "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it('rejects overlapping Pi provider turns for a single thread', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    const threadId = 'thread-overlap';
    let resolvePrompt: (() => void) | null = null;
    const prompt = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    (provider as unknown as {
      sessions: Map<string, unknown>;
    }).sessions.set(threadId, {
      record: {
        providerPackageId: 'rync/pi',
        provider: 'rync/pi',
        providerSessionKind: 'pi-sdk',
        capabilities: {
          embeddedSdk: true
        },
        threadId,
        runtimeMode: 'approval-required',
        cwd: process.cwd(),
        status: 'ready',
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:00.000Z'
      },
      session: {
        sessionId: 'pi-session',
        model: null,
        subscribe() {
          return () => {};
        },
        async prompt() {
          await prompt;
        },
        getLastAssistantText() {
          return 'done';
        },
        async compact() {},
        async abort() {},
        dispose() {}
      },
      unsubscribe: () => {}
    });

    await expect(provider.sendTurn(threadId, {
      text: 'first'
    })).resolves.toMatchObject({
      turnId: expect.stringMatching(/^turn-/u)
    });
    await expect(provider.sendTurn(threadId, {
      text: 'second'
    })).rejects.toThrow(/already has an active turn/u);
    resolvePrompt?.();
  });

  it('applies the requested Pi model before prompting', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    const threadId = 'thread-model';
    let appliedModel: string | null = null;
    let prompted = false;
    (provider as unknown as {
      sessions: Map<string, unknown>;
    }).sessions.set(threadId, {
      record: {
        providerPackageId: 'rync/pi',
        provider: 'rync/pi',
        providerSessionKind: 'pi-sdk',
        capabilities: {
          embeddedSdk: true
        },
        threadId,
        runtimeMode: 'approval-required',
        cwd: process.cwd(),
        status: 'ready',
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:00.000Z'
      },
      session: {
        sessionId: 'pi-session',
        model: null,
        subscribe() {
          return () => {};
        },
        async setModel(model: { provider: string; id: string }) {
          appliedModel = `${model.provider}/${model.id}`;
        },
        async prompt() {
          prompted = true;
        },
        getLastAssistantText() {
          return 'done';
        },
        async compact() {},
        async abort() {},
        dispose() {}
      },
      unsubscribe: () => {}
    });

    await provider.sendTurn(threadId, {
      text: 'use requested model'
    }, 'anthropic/claude-sonnet-4-20250514');
    for (let attempt = 0; attempt < 20 && !prompted; attempt++) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    }

    expect(appliedModel).toBe('anthropic/claude-sonnet-4-20250514');
    expect(prompted).toBe(true);
  });


  it('allows a new Pi provider turn after interrupting a stuck turn', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    const events: Array<{ type: string; turnId?: string }> = [];
    provider.on('providerEvent', (event) => {
      events.push({
        type: event.type,
        turnId: event.turnId
      });
    });
    const threadId = 'thread-interrupt';
    const promptResolvers: Array<() => void> = [];
    (provider as unknown as {
      sessions: Map<string, unknown>;
    }).sessions.set(threadId, {
      record: {
        providerPackageId: 'rync/pi',
        provider: 'rync/pi',
        providerSessionKind: 'pi-sdk',
        capabilities: {
          embeddedSdk: true
        },
        threadId,
        runtimeMode: 'approval-required',
        cwd: process.cwd(),
        status: 'ready',
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:00.000Z'
      },
      session: {
        sessionId: 'pi-session',
        model: null,
        subscribe() {
          return () => {};
        },
        async prompt() {
          await new Promise<void>((resolve) => {
            promptResolvers.push(resolve);
          });
        },
        getLastAssistantText() {
          return 'done';
        },
        async compact() {},
        async abort() {},
        dispose() {}
      },
      unsubscribe: () => {}
    });

    const first = await provider.sendTurn(threadId, {
      text: 'first'
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    await provider.interruptTurn(threadId);
    const second = await provider.sendTurn(threadId, {
      text: 'second'
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    promptResolvers[0]?.();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([]);

    promptResolvers[1]?.();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(events).toEqual(expect.arrayContaining([
      {
        type: 'turn.aborted',
        turnId: first.turnId
      },
      {
        type: 'turn.completed',
        turnId: second.turnId
      }
    ]));
  });

  it('clears Pi active turn state before a slow SDK abort finishes', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    const events: Array<{ type: string; turnId?: string }> = [];
    provider.on('providerEvent', (event) => {
      events.push({
        type: event.type,
        turnId: event.turnId
      });
    });
    const threadId = 'thread-slow-abort';
    const promptResolvers: Array<() => void> = [];
    let resolveAbort: (() => void) | null = null;
    const abort = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    (provider as unknown as {
      sessions: Map<string, unknown>;
    }).sessions.set(threadId, {
      record: {
        providerPackageId: 'rync/pi',
        provider: 'rync/pi',
        providerSessionKind: 'pi-sdk',
        capabilities: {
          embeddedSdk: true
        },
        threadId,
        runtimeMode: 'approval-required',
        cwd: process.cwd(),
        status: 'ready',
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:00.000Z'
      },
      session: {
        sessionId: 'pi-session',
        model: null,
        subscribe() {
          return () => {};
        },
        async prompt() {
          await new Promise<void>((resolve) => {
            promptResolvers.push(resolve);
          });
        },
        getLastAssistantText() {
          return 'done';
        },
        async compact() {},
        async abort() {
          await abort;
        },
        dispose() {}
      },
      unsubscribe: () => {}
    });

    const first = await provider.sendTurn(threadId, {
      text: 'first'
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    const interrupt = provider.interruptTurn(threadId);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    const second = await provider.sendTurn(threadId, {
      text: 'second'
    });

    promptResolvers[0]?.();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([]);

    resolveAbort?.();
    await interrupt;
    promptResolvers[1]?.();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(events).toEqual(expect.arrayContaining([
      {
        type: 'turn.aborted',
        turnId: first.turnId
      },
      {
        type: 'turn.completed',
        turnId: second.turnId
      }
    ]));
  });

  it('rejects Pi thread compaction while a turn is active', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    const threadId = 'thread-compact-running';
    let compacted = false;
    let resolvePrompt: (() => void) | null = null;
    const prompt = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    (provider as unknown as {
      sessions: Map<string, unknown>;
    }).sessions.set(threadId, {
      record: {
        providerPackageId: 'rync/pi',
        provider: 'rync/pi',
        providerSessionKind: 'pi-sdk',
        capabilities: {
          embeddedSdk: true
        },
        threadId,
        runtimeMode: 'approval-required',
        cwd: process.cwd(),
        status: 'ready',
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:00.000Z'
      },
      session: {
        sessionId: 'pi-session',
        model: null,
        subscribe() {
          return () => {};
        },
        async prompt() {
          await prompt;
        },
        getLastAssistantText() {
          return 'done';
        },
        async compact() {
          compacted = true;
        },
        async abort() {},
        dispose() {}
      },
      unsubscribe: () => {}
    });

    await provider.sendTurn(threadId, {
      text: 'first'
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    await expect(provider.compactThread(threadId)).rejects.toThrow(/cannot compact while a turn is active/u);
    expect(compacted).toBe(false);
    resolvePrompt?.();
  });

  it('continues Pi provider session recovery after one session fails', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    const events: Array<{ type: string; threadId: string; message?: string }> = [];
    provider.on('providerEvent', (event) => {
      events.push({
        type: event.type,
        threadId: event.threadId,
        message: 'message' in event.payload ? String(event.payload.message) : undefined
      });
    });
    const attempts: string[] = [];
    (provider as unknown as {
      createPiSession: (input: { session: { threadId: string } }) => Promise<unknown>;
    }).createPiSession = async (input: { session: { threadId: string } }) => {
      const { threadId } = input.session;
      attempts.push(threadId);
      if (threadId === 'thread-bad-recover') {
        throw new Error('simulated SDK recovery failure');
      }
      return {
        sessionId: `pi-session-${threadId}`,
        model: null,
        subscribe() {
          return () => {};
        },
        async prompt() {},
        getLastAssistantText() {
          return 'done';
        },
        async compact() {},
        async abort() {},
        dispose() {}
      };
    };

    await provider.recoverSessions({
      runtimeRoot: process.cwd(),
      sessions: [
        {
          sessionId: 'bad',
          threadId: 'thread-bad-recover',
          transportResourceId: 'transport',
          runtimeMode: 'approval-required',
          agentKind: 'workspace',
          workspacePath: process.cwd(),
          providerCwd: process.cwd(),
          resumeCursor: null,
          lifecycleStatus: 'active',
          toolGrantIds: [],
          toolPolicy: {
            workspace: { nativePreset: 'provider-default' },
            ephemeral: { nativePreset: 'none', grants: ['core.moorline_session'] }
          }
        },
        {
          sessionId: 'good',
          threadId: 'thread-good-recover',
          transportResourceId: 'transport',
          runtimeMode: 'approval-required',
          agentKind: 'workspace',
          workspacePath: process.cwd(),
          providerCwd: process.cwd(),
          resumeCursor: null,
          lifecycleStatus: 'active',
          toolGrantIds: [],
          toolPolicy: {
            workspace: { nativePreset: 'provider-default' },
            ephemeral: { nativePreset: 'none', grants: ['core.moorline_session'] }
          }
        }
      ]
    });

    expect(attempts).toEqual([
      'thread-bad-recover',
      'thread-good-recover'
    ]);
    expect(provider.listSessions().map((session) => session.threadId)).toEqual([
      'thread-good-recover'
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'runtime.error',
      threadId: 'thread-bad-recover',
      message: expect.stringContaining('simulated SDK recovery failure')
    }));
  });

  it('does not expose mutable Pi session or diagnostics state through return values', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    const threadId = 'thread-state-clone';
    (provider as unknown as {
      sessions: Map<string, unknown>;
    }).sessions.set(threadId, {
      record: {
        providerPackageId: 'rync/pi',
        provider: 'rync/pi',
        providerSessionKind: 'pi-sdk',
        capabilities: {
          embeddedSdk: true
        },
        threadId,
        runtimeMode: 'approval-required',
        cwd: process.cwd(),
        status: 'ready',
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:00.000Z'
      },
      session: {
        sessionId: 'pi-session',
        model: null,
        subscribe() {
          return () => {};
        },
        async prompt() {},
        getLastAssistantText() {
          return 'done';
        },
        async compact() {},
        async abort() {},
        dispose() {}
      },
      unsubscribe: () => {}
    });

    const [session] = provider.listSessions();
    if (!session) {
      throw new Error('expected a Pi session');
    }
    session.status = 'error';
    session.capabilities.embeddedSdk = false;

    expect(provider.listSessions()[0]).toMatchObject({
      status: 'ready',
      capabilities: {
        embeddedSdk: true
      }
    });

    const diagnostics = provider.getDiagnostics();
    diagnostics.availableModels.push('mutated/model');
    diagnostics.statusCounts.ready = 999;
    diagnostics.capabilityMetadata.supportsEmbeddedSdk = false;

    expect(provider.getDiagnostics()).toMatchObject({
      availableModels: [],
      statusCounts: {
        ready: 1
      },
      capabilityMetadata: {
        supportsEmbeddedSdk: true
      }
    });
  });

  it('reports attempted Pi test turns when the SDK turn fails', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    (provider as unknown as {
      createPiSession: (input: { session: { threadId: string } }) => Promise<unknown>;
    }).createPiSession = async (input: { session: { threadId: string } }) => ({
      sessionId: `pi-session-${input.session.threadId}`,
      model: null,
      subscribe() {
        return () => {};
      },
      async prompt() {
        throw new Error('simulated Pi prompt failure');
      },
      getLastAssistantText() {
        return undefined;
      },
      async compact() {},
      async abort() {},
      dispose() {}
    });

    await expect(provider.testConnection({
      runtimeRoot: process.cwd(),
      actor: 'contract',
      sendTurn: true,
      prompt: 'fail please'
    })).resolves.toMatchObject({
      ok: false,
      sentTurn: true,
      error: expect.stringContaining('simulated Pi prompt failure')
    });
  });

  it('ignores stale Pi prompt completion after the session is stopped', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    const events: Array<{ type: string; turnId?: string; state?: string }> = [];
    provider.on('providerEvent', (event) => {
      events.push({
        type: event.type,
        turnId: event.turnId,
        state: 'state' in event.payload ? String(event.payload.state) : undefined
      });
    });
    const threadId = 'thread-stop-stale';
    let resolvePrompt: (() => void) | null = null;
    const prompt = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    (provider as unknown as {
      sessions: Map<string, unknown>;
    }).sessions.set(threadId, {
      record: {
        providerPackageId: 'rync/pi',
        provider: 'rync/pi',
        providerSessionKind: 'pi-sdk',
        capabilities: {
          embeddedSdk: true
        },
        threadId,
        runtimeMode: 'approval-required',
        cwd: process.cwd(),
        status: 'ready',
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:00.000Z'
      },
      session: {
        sessionId: 'pi-session',
        model: null,
        subscribe() {
          return () => {};
        },
        async prompt() {
          await prompt;
        },
        getLastAssistantText() {
          return 'stale done';
        },
        async compact() {},
        async abort() {},
        dispose() {}
      },
      unsubscribe: () => {}
    });

    const turn = await provider.sendTurn(threadId, {
      text: 'stop me'
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    provider.stopSession(threadId);
    resolvePrompt?.();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(events).toEqual(expect.arrayContaining([
      {
        type: 'turn.aborted',
        turnId: turn.turnId,
        state: undefined
      }
    ]));
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([]);
    expect(events.filter((event) => event.type === 'item.completed')).toEqual([]);
    expect(provider.listSessions()).toEqual([]);
  });

  it('passes Moorline image attachments through to Pi prompt options', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    const threadId = 'thread-images';
    const tempRoot = mkdtempSync(join(tmpdir(), 'moorline-pi-images-'));
    const pngBytes = Buffer.from('iVBORw0KGgo=', 'base64');
    const localImagePath = join(tempRoot, 'tiny.png');
    writeFileSync(localImagePath, pngBytes);
    let promptOptions: { images?: Array<{ type: string; mimeType: string; data: string }> } | null = null;
    (provider as unknown as {
      sessions: Map<string, unknown>;
    }).sessions.set(threadId, {
      record: {
        providerPackageId: 'rync/pi',
        provider: 'rync/pi',
        providerSessionKind: 'pi-sdk',
        capabilities: {
          embeddedSdk: true
        },
        threadId,
        runtimeMode: 'approval-required',
        cwd: process.cwd(),
        status: 'ready',
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:00.000Z'
      },
      session: {
        sessionId: 'pi-session',
        model: null,
        subscribe() {
          return () => {};
        },
        async prompt(_text: string, options: { images?: Array<{ type: string; mimeType: string; data: string }> }) {
          promptOptions = options;
        },
        getLastAssistantText() {
          return 'done';
        },
        async compact() {},
        async abort() {},
        dispose() {}
      },
      unsubscribe: () => {}
    });

    await provider.sendTurn(threadId, {
      text: 'describe',
      images: [
        {
          localPath: localImagePath
        },
        {
          url: `data:image/png;base64,${pngBytes.toString('base64')}`
        }
      ]
    });
    for (let attempt = 0; attempt < 20 && !promptOptions; attempt++) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    }

    expect(promptOptions?.images).toEqual([
      {
        type: 'image',
        mimeType: 'image/png',
        data: pngBytes.toString('base64')
      },
      {
        type: 'image',
        mimeType: 'image/png',
        data: pngBytes.toString('base64')
      }
    ]);
  });

  it('fails Pi turns with unsupported image attachments before prompting the SDK', async () => {
    const buildProvider = (threadId: string) => {
      const provider = new PiProviderService({
        packageId: 'rync/pi'
      });
      const events: Array<{ type: string; state?: string; message?: string }> = [];
      provider.on('providerEvent', (event) => {
        events.push({
          type: event.type,
          state: 'state' in event.payload ? String(event.payload.state) : undefined,
          message: 'message' in event.payload ? String(event.payload.message) : 'errorMessage' in event.payload ? String(event.payload.errorMessage) : undefined
        });
      });
      let prompted = false;
      (provider as unknown as {
        sessions: Map<string, unknown>;
      }).sessions.set(threadId, {
        record: {
          providerPackageId: 'rync/pi',
          provider: 'rync/pi',
          providerSessionKind: 'pi-sdk',
          capabilities: {
            embeddedSdk: true
          },
          threadId,
          runtimeMode: 'approval-required',
          cwd: process.cwd(),
          status: 'ready',
          createdAt: '2026-06-07T00:00:00.000Z',
          updatedAt: '2026-06-07T00:00:00.000Z'
        },
        session: {
          sessionId: 'pi-session',
          model: null,
          subscribe() {
            return () => {};
          },
          async prompt() {
            prompted = true;
          },
          getLastAssistantText() {
            return 'done';
          },
          async compact() {},
          async abort() {},
          dispose() {}
        },
        unsubscribe: () => {}
      });
      return {
        provider,
        events,
        prompted: () => prompted
      };
    };

    const tempRoot = mkdtempSync(join(tmpdir(), 'moorline-pi-bad-image-'));
    const localImagePath = join(tempRoot, 'not-image.txt');
    writeFileSync(localImagePath, 'not an image');
    const localFailure = buildProvider('thread-bad-local-image');

    await localFailure.provider.sendTurn('thread-bad-local-image', {
      text: 'describe',
      images: [{
        localPath: localImagePath
      }]
    });
    for (let attempt = 0; attempt < 20 && !localFailure.events.some((event) => event.type === 'turn.completed'); attempt++) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    }

    expect(localFailure.prompted()).toBe(false);
    expect(localFailure.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'runtime.error',
        message: expect.stringContaining('Unsupported image attachment type')
      }),
      expect.objectContaining({
        type: 'turn.completed',
        state: 'failed',
        message: expect.stringContaining('Unsupported image attachment type')
      })
    ]));

    const dataUrlFailure = buildProvider('thread-bad-data-image');
    await dataUrlFailure.provider.sendTurn('thread-bad-data-image', {
      text: 'describe',
      images: [{
        url: 'data:image/png;base64,bm90IGFuIGltYWdl'
      }]
    });
    for (let attempt = 0; attempt < 20 && !dataUrlFailure.events.some((event) => event.type === 'turn.completed'); attempt++) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    }

    expect(dataUrlFailure.prompted()).toBe(false);
    expect(dataUrlFailure.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'turn.completed',
        state: 'failed',
        message: expect.stringContaining('Unsupported image attachment type')
      })
    ]));

    const tooManyFailure = buildProvider('thread-too-many-images');
    await tooManyFailure.provider.sendTurn('thread-too-many-images', {
      text: 'describe',
      images: Array.from({ length: 9 }, () => ({
        url: 'data:image/png;base64,iVBORw0KGgo='
      }))
    });
    for (let attempt = 0; attempt < 20 && !tooManyFailure.events.some((event) => event.type === 'turn.completed'); attempt++) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    }

    expect(tooManyFailure.prompted()).toBe(false);
    expect(tooManyFailure.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'turn.completed',
        state: 'failed',
        message: expect.stringContaining('Maximum supported image count is 8')
      })
    ]));

    const oversizedServer = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'image/png'
      });
      res.write(Buffer.from('iVBORw0KGgo=', 'base64'));
      res.end(Buffer.alloc((8 * 1024 * 1024) + 1));
    });
    await new Promise<void>((resolve, reject) => {
      oversizedServer.once('error', reject);
      oversizedServer.listen(0, '127.0.0.1', () => resolve());
    });
    const oversizedAddress = oversizedServer.address();
    if (!oversizedAddress || typeof oversizedAddress === 'string') {
      throw new Error('Unable to reserve a local test port.');
    }
    try {
      const oversizedFailure = buildProvider('thread-oversized-remote-image');
      await oversizedFailure.provider.sendTurn('thread-oversized-remote-image', {
        text: 'describe',
        images: [{
          url: `http://127.0.0.1:${oversizedAddress.port}/image.png`
        }]
      });
      for (let attempt = 0; attempt < 50 && !oversizedFailure.events.some((event) => event.type === 'turn.completed'); attempt++) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
      }

      expect(oversizedFailure.prompted()).toBe(false);
      expect(oversizedFailure.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'turn.completed',
          state: 'failed',
          message: expect.stringContaining('per-image limit')
        })
      ]));
    } finally {
      await new Promise<void>((resolve, reject) => {
        oversizedServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('does not emit stale Pi completion events after stopping a running session', async () => {
    const provider = new PiProviderService({
      packageId: 'rync/pi'
    });
    const events: Array<{ type: string; turnId?: string }> = [];
    provider.on('providerEvent', (event) => {
      events.push({
        type: event.type,
        turnId: event.turnId
      });
    });
    const threadId = 'thread-stop-running';
    let resolvePrompt: (() => void) | null = null;
    const prompt = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    (provider as unknown as {
      sessions: Map<string, unknown>;
    }).sessions.set(threadId, {
      record: {
        providerPackageId: 'rync/pi',
        provider: 'rync/pi',
        providerSessionKind: 'pi-sdk',
        capabilities: {
          embeddedSdk: true
        },
        threadId,
        runtimeMode: 'approval-required',
        cwd: process.cwd(),
        status: 'ready',
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:00.000Z'
      },
      session: {
        sessionId: 'pi-session',
        model: null,
        subscribe() {
          return () => {};
        },
        async prompt() {
          await prompt;
        },
        getLastAssistantText() {
          return 'done';
        },
        async compact() {},
        async abort() {},
        dispose() {}
      },
      unsubscribe: () => {}
    });

    const turn = await provider.sendTurn(threadId, {
      text: 'first'
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    provider.stopSession(threadId);
    resolvePrompt?.();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(events).toContainEqual({
      type: 'turn.aborted',
      turnId: turn.turnId
    });
    expect(events.filter((event) => event.type === 'item.completed' || event.type === 'turn.completed')).toEqual([]);
  });
});
