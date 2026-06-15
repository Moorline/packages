import { beforeEach, describe, expect, it } from 'vitest';
import { piCodingAgentMockState as piMockState, resetPiCodingAgentMock } from '../fixtures/pi-coding-agent-mock';

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
  beforeEach(() => {
    resetPiCodingAgentMock();
  });

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
    expect(piMockState.resourceLoaderOptions).toHaveLength(1);
    const resourceLoader = piMockState.resourceLoaderOptions[0];
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
    expect(piMockState.createAgentSessionInputs[0].tools).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'moorline_plugin_rync_persona_edit_soul'
    ]);
    expect(piMockState.customTools[0]).toMatchObject({
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

    const resourceLoader = piMockState.resourceLoaderOptions.at(-1)!;
    expect((resourceLoader.systemPromptOverride as (base: string) => string)('Pi base')).toContain('Moorline ephemeral runtime agent');
    expect(piMockState.createAgentSessionInputs.at(-1)?.tools).toEqual(['moorline_core_moorline_session']);

    await provider.sendTurn('thread-2', {
      text: 'hello from user',
      context: [{
        title: 'Memory context',
        content: 'remember this internally',
        source: 'test'
      }]
    });
    for (let attempt = 0; attempt < 20 && piMockState.prompts.length === 0; attempt++) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    }

    expect(piMockState.customMessages.at(-1)).toEqual({
      message: {
        customType: 'moorline.context',
        content: '<moorline_context title="Memory context" source="test">\nremember this internally\n</moorline_context>',
        display: false
      },
      options: { deliverAs: 'nextTurn' }
    });
    expect(piMockState.prompts.at(-1)).toMatchObject({
      text: 'hello from user'
    });
  });
});
