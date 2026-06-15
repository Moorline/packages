import { describe, expect, it, vi } from 'vitest';

const piMock = vi.hoisted(() => {
  const state = {
    resourceLoaderOptions: [] as Array<Record<string, unknown>>,
    createAgentSessionInputs: [] as Array<Record<string, unknown>>,
    openedSessionFiles: [] as string[],
    customMessages: [] as Array<{ message: Record<string, unknown>; options: Record<string, unknown> }>,
    prompts: [] as Array<{ text: string; options: Record<string, unknown> }>,
    customTools: [] as Array<Record<string, unknown>>
  };
  class DefaultResourceLoader {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      state.resourceLoaderOptions.push(options);
    }
    async reload() {}
  }
  class SessionManager {
    static create(cwd: string, sessionDir: string) {
      return { kind: 'created', cwd, sessionDir };
    }
    static open(sessionFile: string) {
      state.openedSessionFiles.push(sessionFile);
      return { kind: 'opened', sessionFile };
    }
  }
  return {
    state,
    DefaultResourceLoader,
    SessionManager
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: {
    create: () => ({})
  },
  ModelRegistry: {
    inMemory: () => ({
      find: (provider: string, id: string) => ({ provider, id })
    })
  },
  DefaultResourceLoader: piMock.DefaultResourceLoader,
  SessionManager: piMock.SessionManager,
  createSyntheticSourceInfo: (filePath: string, metadata: Record<string, unknown>) => ({ filePath, metadata }),
  defineTool: (tool: Record<string, unknown>) => {
    piMock.state.customTools.push(tool);
    return tool;
  },
  createAgentSession: async (input: Record<string, unknown>) => {
    piMock.state.createAgentSessionInputs.push(input);
    return {
      session: {
        sessionId: `pi-${piMock.state.createAgentSessionInputs.length}`,
        sessionFile: `/tmp/pi-${piMock.state.createAgentSessionInputs.length}.json`,
        model: null,
        subscribe() {
          return () => {};
        },
        async sendCustomMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
          piMock.state.customMessages.push({ message, options });
        },
        async prompt(text: string, options: Record<string, unknown>) {
          piMock.state.prompts.push({ text, options });
        },
        getLastAssistantText() {
          return 'done';
        },
        async setModel() {},
        async compact() {},
        async abort() {},
        dispose() {}
      }
    };
  }
}));

const { PiProviderService } = await import('../../packages/pi/providerService.js');

const defaultToolPolicy = {
  workspace: {
    nativePreset: 'provider-default',
    allowNativeTools: ['read', 'bash', 'edit', 'write']
  },
  ephemeral: {
    nativePreset: 'none',
    grants: ['core.moorline_session']
  }
};

describe('Pi provider-native runtime mapping', () => {
  it('maps workspace sessions to controlled Pi resources, native tools, custom tools, and cursors', async () => {
    const provider = new PiProviderService({ packageId: 'rync/pi' });
    const record = await provider.startOrResumeSession({
      runtimeRoot: '/tmp/moorline-pi-test',
      actor: 'test',
      session: {
        sessionId: 'session-1',
        threadId: 'thread-1',
        transportResourceId: 'transport-1',
        runtimeMode: 'approval-required',
        agentKind: 'workspace',
        workspacePath: '/tmp/workspace',
        providerCwd: '/tmp/workspace',
        resumeCursor: null,
        lifecycleStatus: 'hot',
        toolGrantIds: ['plugin:rync/persona.edit_soul'],
        toolPolicy: defaultToolPolicy
      },
      resources: {
        systemPromptSections: ['Moorline system section'],
        contextFiles: [{ path: 'AGENT.md', content: 'context file', source: 'test' }],
        skills: [{
          name: 'proof',
          description: 'Proof skill',
          filePath: '/tmp/skills/proof/SKILL.md',
          baseDir: '/tmp/skills/proof',
          metadata: { source: 'test' }
        }],
        promptTemplates: []
      },
      tools: [{
        id: 'plugin:rync/persona.edit_soul',
        name: 'edit_soul',
        description: 'Edit SOUL',
        inputSchema: { type: 'object' },
        source: 'plugin',
        ownerPackageId: 'rync/persona'
      }],
      toolExecutor: {
        executeProviderTool: async () => ({ content: 'ok' })
      }
    });

    expect(record.resumeCursor).toBeUndefined();
    expect(piMock.state.resourceLoaderOptions).toHaveLength(1);
    const resourceLoader = piMock.state.resourceLoaderOptions[0];
    expect(resourceLoader).toMatchObject({
      cwd: '/tmp/workspace',
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true
    });
    expect((resourceLoader.systemPromptOverride as (base: string) => string)('Pi base')).toBe('Pi base\n\nMoorline system section');
    expect((resourceLoader.agentsFilesOverride as () => unknown)()).toEqual({
      agentsFiles: [{ path: 'AGENT.md', content: 'context file' }]
    });
    expect((resourceLoader.skillsOverride as () => { skills: Array<Record<string, unknown>> })().skills[0]).toMatchObject({
      name: 'proof',
      filePath: '/tmp/skills/proof/SKILL.md',
      baseDir: '/tmp/skills/proof'
    });
    expect(piMock.state.createAgentSessionInputs[0].tools).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'moorline_plugin_rync_persona_edit_soul'
    ]);
    expect(piMock.state.customTools[0]).toMatchObject({
      name: 'moorline_plugin_rync_persona_edit_soul',
      label: 'edit_soul',
      parameters: { type: 'object' }
    });
  });

  it('maps ephemeral sessions to no Pi native tools and injects per-turn context outside the user prompt', async () => {
    const provider = new PiProviderService({ packageId: 'rync/pi' });
    await provider.startOrResumeSession({
      runtimeRoot: '/tmp/moorline-pi-test',
      actor: 'test',
      session: {
        sessionId: 'session-2',
        threadId: 'thread-2',
        transportResourceId: 'transport-2',
        runtimeMode: 'approval-required',
        agentKind: 'ephemeral',
        workspacePath: null,
        providerCwd: null,
        resumeCursor: null,
        lifecycleStatus: 'hot',
        toolGrantIds: ['core.moorline_session'],
        toolPolicy: defaultToolPolicy
      },
      tools: [{
        id: 'core.moorline_session',
        name: 'moorline_session',
        description: 'Manage sessions',
        inputSchema: { type: 'object' },
        source: 'core'
      }],
      toolExecutor: {
        executeProviderTool: async () => ({ content: 'ok' })
      }
    });

    const resourceLoader = piMock.state.resourceLoaderOptions.at(-1)!;
    expect((resourceLoader.systemPromptOverride as (base: string) => string)('Pi base')).toContain('Moorline ephemeral runtime agent');
    expect(piMock.state.createAgentSessionInputs.at(-1)?.tools).toEqual(['moorline_core_moorline_session']);

    await provider.sendTurn('thread-2', {
      text: 'hello from user',
      context: [{
        title: 'Memory context',
        content: 'remember this internally',
        source: 'test'
      }]
    });
    for (let attempt = 0; attempt < 20 && piMock.state.prompts.length === 0; attempt++) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    }

    expect(piMock.state.customMessages.at(-1)).toEqual({
      message: {
        customType: 'moorline.context',
        content: '<moorline_context title="Memory context" source="test">\nremember this internally\n</moorline_context>',
        display: false
      },
      options: { deliverAs: 'nextTurn' }
    });
    expect(piMock.state.prompts.at(-1)).toMatchObject({
      text: 'hello from user'
    });
  });
});
