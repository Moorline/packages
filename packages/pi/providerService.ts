import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createSyntheticSourceInfo,
  createAgentSession,
  AuthStorage,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type PromptOptions
} from '@earendil-works/pi-coding-agent';
import type {
  ProviderInputImage,
  ProviderResourceBundle,
  ProviderRuntimeEvent,
  ProviderSessionRecord,
  ProviderToolDefinition,
  ProviderToolExecutor,
  ProviderToolPolicyProfileConfig,
  ProviderTurnInput,
  RuntimeProviderDiagnostics,
  RuntimeProviderSessionInput,
  RuntimeProviderTestResult
} from '@moorline/contracts';

interface PiProviderServiceEvents {
  providerEvent: [event: ProviderRuntimeEvent];
}

interface PiProviderServiceOptions {
  packageId: string;
  agentDir?: string;
}

interface PiSessionContext {
  record: ProviderSessionRecord;
  session: AgentSession;
  activeTurnId?: string;
  unsubscribe: () => void;
}

interface PiSessionCreationInput {
  session: RuntimeProviderSessionInput;
  runtimeRoot: string;
  resources?: ProviderResourceBundle;
  tools?: ProviderToolDefinition[];
  toolExecutor?: ProviderToolExecutor;
}

function nowIso(): string {
  return new Date().toISOString();
}

function textFromEvent(event: AgentSessionEvent): string | null {
  if (event.type !== 'message_update' || event.assistantMessageEvent.type !== 'text_delta') {
    return null;
  }
  return event.assistantMessageEvent.delta;
}

function lastAssistantText(session: AgentSession): string | undefined {
  return session.getLastAssistantText();
}

function unsupported(name: string): never {
  throw new Error(`Pi provider does not support ${name} yet.`);
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function jwtExpiresAtMs(token: string): number | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) {
      return null;
    }
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

function codexCredentialFromAuth(): Record<string, unknown> | null {
  const codexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME.trim()
    : join(homedir(), '.codex');
  const auth = readJsonObject(join(codexHome, 'auth.json'));
  const tokens = auth?.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    return null;
  }
  const record = tokens as Record<string, unknown>;
  const refresh = typeof record.refresh_token === 'string' ? record.refresh_token : '';
  const access = typeof record.access_token === 'string' ? record.access_token : '';
  const accountId = typeof record.account_id === 'string' ? record.account_id : '';
  if (!refresh || !access) {
    return null;
  }
  return {
    type: 'oauth',
    refresh,
    access,
    expires: jwtExpiresAtMs(access) ?? Date.now() + 45 * 60 * 1000,
    ...(accountId ? { accountId } : {})
  };
}

function ensureCodexAuthBridge(agentDir: string): void {
  const credential = codexCredentialFromAuth();
  if (!credential) {
    return;
  }
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const authPath = join(agentDir, 'auth.json');
  const current = readJsonObject(authPath) ?? {};
  if (current['openai-codex']) {
    return;
  }
  writeFileSync(authPath, `${JSON.stringify({ ...current, 'openai-codex': credential }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  chmodSync(authPath, 0o600);
}

function piToolName(tool: ProviderToolDefinition): string {
  const suffix = tool.id
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
  return `moorline_${suffix || 'tool'}`;
}

function nativeToolsForProfile(profile: ProviderToolPolicyProfileConfig | undefined, agentKind: RuntimeProviderSessionInput['agentKind']): string[] {
  if (profile?.nativePreset === 'none' || agentKind === 'ephemeral') {
    return [];
  }
  const base = profile?.nativePreset === 'provider-default' || !profile?.nativePreset
    ? ['read', 'bash', 'edit', 'write']
    : [];
  const allowed = profile?.allowNativeTools ? new Set(profile.allowNativeTools) : null;
  const denied = new Set(profile?.denyNativeTools ?? []);
  return base.filter((tool) => (!allowed || allowed.has(tool)) && !denied.has(tool));
}

function cloneSessionRecord(record: ProviderSessionRecord): ProviderSessionRecord {
  return {
    ...record,
    capabilities: {
      ...record.capabilities
    }
  };
}

function cloneDiagnostics(diagnostics: RuntimeProviderDiagnostics): RuntimeProviderDiagnostics {
  return {
    ...diagnostics,
    availableModels: [...diagnostics.availableModels],
    statusCounts: {
      ...diagnostics.statusCounts
    },
    capabilityMetadata: {
      ...diagnostics.capabilityMetadata
    }
  };
}

type PiPromptImage = NonNullable<PromptOptions['images']>[number];

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
]);
const MAX_PROMPT_IMAGE_COUNT = 8;
const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024;

function detectImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function assertImageByteLimits(buffer: Buffer, label: string, totalBytes: { value: number }): void {
  if (buffer.byteLength > MAX_PROMPT_IMAGE_BYTES) {
    throw new Error(`Image attachment ${label} exceeds the per-image limit of ${MAX_PROMPT_IMAGE_BYTES} bytes.`);
  }
  if (totalBytes.value + buffer.byteLength > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
    throw new Error(`Image attachments exceed the total limit of ${MAX_PROMPT_IMAGE_TOTAL_BYTES} bytes.`);
  }
  totalBytes.value += buffer.byteLength;
}

function imageFromBuffer(buffer: Buffer, label: string, totalBytes: { value: number }, hintedMimeType?: string): PiPromptImage {
  assertImageByteLimits(buffer, label, totalBytes);
  const mimeType = detectImageMimeType(buffer);
  if (!mimeType) {
    throw new Error(`Unsupported image attachment type for ${label}. Supported image types are JPEG, PNG, GIF, and WebP.`);
  }
  if (hintedMimeType && SUPPORTED_IMAGE_MIME_TYPES.has(hintedMimeType) && hintedMimeType !== mimeType) {
    throw new Error(`Image attachment type mismatch for ${label}: declared ${hintedMimeType}, detected ${mimeType}.`);
  }
  return {
    type: 'image',
    mimeType,
    data: buffer.toString('base64')
  };
}

function imageFromDataUrl(url: string, totalBytes: { value: number }): PiPromptImage | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/iu.exec(url);
  if (!match) {
    return null;
  }
  const mimeType = match[1]?.toLowerCase();
  const data = match[2]?.replace(/\s+/gu, '');
  if (!mimeType || !data || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error('Unsupported image data URL type. Supported image types are JPEG, PNG, GIF, and WebP.');
  }
  return imageFromBuffer(Buffer.from(data, 'base64'), 'data URL', totalBytes, mimeType);
}

async function readRemoteImageBody(
  response: Awaited<ReturnType<typeof fetch>>,
  label: string,
  totalBytes: { value: number }
): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let imageBytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      imageBytes += chunk.byteLength;
      if (imageBytes > MAX_PROMPT_IMAGE_BYTES) {
        throw new Error(`Image attachment ${label} exceeds the per-image limit of ${MAX_PROMPT_IMAGE_BYTES} bytes.`);
      }
      if (totalBytes.value + imageBytes > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
        throw new Error(`Image attachments exceed the total limit of ${MAX_PROMPT_IMAGE_TOTAL_BYTES} bytes.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export class PiProviderService extends EventEmitter<PiProviderServiceEvents> {
  private readonly sessions = new Map<string, PiSessionContext>();
  private readonly options: PiProviderServiceOptions;
  private diagnostics: RuntimeProviderDiagnostics = {
    accountLabel: null,
    availableModels: [],
    connectedSessions: 0,
    statusCounts: {},
    capabilityMetadata: {
      sdk: '@earendil-works/pi-coding-agent',
      sessionRuntime: 'embedded'
    }
  };

  constructor(options: PiProviderServiceOptions) {
    super();
    this.options = options;
  }

  listSessions(): ProviderSessionRecord[] {
    return [...this.sessions.values()].map((context) => cloneSessionRecord(context.record));
  }

  getDiagnostics(): RuntimeProviderDiagnostics {
    const statusCounts = this.listSessions().reduce<Record<string, number>>((counts, session) => {
      counts[session.status] = (counts[session.status] ?? 0) + 1;
      return counts;
    }, {});
    return cloneDiagnostics({
      ...this.diagnostics,
      connectedSessions: this.sessions.size,
      statusCounts,
      capabilityMetadata: {
        ...this.diagnostics.capabilityMetadata,
        supportsEmbeddedSdk: true,
        supportsManagementExtras: false
      }
    });
  }

  async startOrResumeSession(input: {
    session: RuntimeProviderSessionInput;
    runtimeRoot: string;
    actor: string;
    model?: string;
    resources?: ProviderResourceBundle;
    tools?: ProviderToolDefinition[];
    toolExecutor?: ProviderToolExecutor;
  }): Promise<ProviderSessionRecord> {
    const existing = this.sessions.get(input.session.threadId);
    if (existing) {
      return cloneSessionRecord(existing.record);
    }

    const createdAt = nowIso();
    const record: ProviderSessionRecord = {
      providerPackageId: this.options.packageId,
      provider: this.options.packageId,
      providerSessionKind: 'pi-sdk',
      capabilities: {
        embeddedSdk: true
      },
      threadId: input.session.threadId,
      runtimeMode: input.session.runtimeMode,
      agentKind: input.session.agentKind ?? 'workspace',
      cwd: input.session.providerCwd ?? input.session.workspacePath ?? join(input.runtimeRoot, 'providers', 'pi', 'ephemeral', input.session.threadId.replace(/[^a-z0-9_.-]/gi, '-')),
      ...(input.model ? { model: input.model } : {}),
      status: 'connecting',
      createdAt,
      updatedAt: createdAt
    };
    const context: PiSessionContext = {
      record,
      session: await this.createPiSession({
        session: input.session,
        runtimeRoot: input.runtimeRoot,
        resources: input.resources,
        tools: input.tools,
        toolExecutor: input.toolExecutor
      }),
      unsubscribe: () => {}
    };
    context.unsubscribe = context.session.subscribe((event) => this.handlePiEvent(context, event));
    this.sessions.set(record.threadId, context);

    this.updateSessionState(context, 'ready');
    this.emitProviderEvent(record.threadId, 'thread.started', {
      providerThreadId: context.session.sessionId,
      resumeCursor: {
        provider: this.options.packageId,
        value: {
          sessionFile: context.session.sessionFile ?? null,
          sessionId: context.session.sessionId
        }
      }
    });
    this.emitProviderEvent(record.threadId, 'provider.metadata.updated', {
      accountLabel: 'Pi SDK',
      availableModels: context.session.model ? [`${context.session.model.provider}/${context.session.model.id}`] : []
    });
    this.diagnostics = {
      ...this.getDiagnostics(),
      accountLabel: 'Pi SDK',
      availableModels: context.session.model ? [`${context.session.model.provider}/${context.session.model.id}`] : []
    };
    return cloneSessionRecord(context.record);
  }

  async recoverSessions(input: {
    sessions: RuntimeProviderSessionInput[];
    runtimeRoot: string;
    model?: string;
  }): Promise<void> {
    for (const session of input.sessions) {
      if (session.lifecycleStatus === 'archived' || session.providerAutoStartEnabled === false) {
        continue;
      }
      try {
        await this.startOrResumeSession({
          session,
          runtimeRoot: input.runtimeRoot,
          actor: 'runtime:provider/recover',
          ...(input.model ? { model: input.model } : {})
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitProviderEvent(session.threadId, 'runtime.error', {
          message: `Failed to recover Pi provider session ${session.threadId}: ${message}`,
          class: 'pi.provider.recover'
        });
      }
    }
  }

  async testConnection(input: {
    runtimeRoot: string;
    actor: string;
    model?: string;
    sendTurn?: boolean;
    prompt?: string;
  }): Promise<RuntimeProviderTestResult> {
    const threadId = `provider-test-${randomUUID()}`;
    const workspacePath = join(input.runtimeRoot, 'workspaces', '.provider-test-pi');
    let sentTurn = false;
    mkdirSync(workspacePath, { recursive: true });
    const sessionInput: RuntimeProviderSessionInput = {
      sessionId: threadId,
      threadId,
      transportResourceId: 'provider-test',
      runtimeMode: 'approval-required',
      agentKind: 'workspace',
      workspacePath,
      providerCwd: workspacePath,
      resumeCursor: null,
      lifecycleStatus: 'active',
      toolGrantIds: [],
      toolPolicy: {
        workspace: {
          nativePreset: 'provider-default'
        },
        ephemeral: {
          nativePreset: 'none',
          grants: ['core.moorline_session']
        }
      }
    };
    try {
      await this.startOrResumeSession({
        session: sessionInput,
        runtimeRoot: input.runtimeRoot,
        actor: input.actor,
        ...(input.model ? { model: input.model } : {})
      });
      if (input.sendTurn === true) {
        const { turnId } = await this.sendTurn(threadId, {
          text: input.prompt?.trim() || 'Reply with exactly: Moorline Pi provider online.'
        }, input.model);
        sentTurn = true;
        await this.waitForTurn(threadId, turnId, 90_000);
      }
      const diagnostics = this.getDiagnostics();
      return {
        ok: true,
        message: sentTurn ? 'Pi provider startup test completed, including a test turn.' : 'Pi provider startup test completed.',
        accountLabel: diagnostics.accountLabel,
        availableModels: diagnostics.availableModels,
        sentTurn
      };
    } catch (error) {
      return {
        ok: false,
        message: 'Pi provider startup test failed.',
        remediation: 'Install/configure Pi auth and verify @earendil-works/pi-coding-agent can create an SDK session.',
        accountLabel: null,
        availableModels: [],
        sentTurn,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this.stopSession(threadId);
    }
  }

  async sendTurn(threadId: string, input: ProviderTurnInput, model?: string): Promise<{ turnId: string }> {
    const context = this.requireSession(threadId);
    if (context.activeTurnId) {
      throw new Error(`Pi provider session ${threadId} already has an active turn.`);
    }
    if (model) {
      await this.applyModel(context, model);
    }
    const turnId = `turn-${randomUUID()}`;
    context.activeTurnId = turnId;
    context.record = {
      ...context.record,
      activeTurnId: turnId,
      status: 'running',
      updatedAt: nowIso()
    };
    this.emitProviderEvent(threadId, 'turn.started', {});
    globalThis.setTimeout(() => {
      void this.runPiPrompt(context, input);
    }, 0);
    return { turnId };
  }

  private async applyModel(context: PiSessionContext, model: string): Promise<void> {
    const [provider, ...modelParts] = model.split('/');
    const modelId = modelParts.join('/');
    if (!provider || !modelId) {
      throw new Error(`Pi model must use provider/model format: ${model}`);
    }
    const registry = ModelRegistry.inMemory(AuthStorage.create());
    const resolved = registry.find(provider, modelId);
    if (!resolved) {
      throw new Error(`Pi model not found: ${model}`);
    }
    if (context.session.model?.provider === resolved.provider && context.session.model.id === resolved.id) {
      return;
    }
    await context.session.setModel(resolved);
    context.record = {
      ...context.record,
      model,
      updatedAt: nowIso()
    };
  }

  private async runPiPrompt(context: PiSessionContext, input: ProviderTurnInput): Promise<void> {
    const threadId = context.record.threadId;
    const turnId = context.activeTurnId;
    if (!turnId) {
      return;
    }
    try {
      const images = await this.convertPromptImages(input.images ?? []);
      for (const item of input.context ?? []) {
        await context.session.sendCustomMessage(
          {
            customType: 'moorline.context',
            content: `<moorline_context title="${item.title}" source="${item.source}">\n${item.content}\n</moorline_context>`,
            display: false
          },
          { deliverAs: 'nextTurn' }
        );
      }
      await context.session.prompt(input.text, {
        expandPromptTemplates: true,
        source: 'extension',
        ...(images.length > 0 ? { images } : {})
      });
      if (context.activeTurnId !== turnId) {
        return;
      }
      const finalText = lastAssistantText(context.session);
      if (finalText) {
        this.emitProviderEvent(threadId, 'item.completed', {
          itemType: 'assistant_message',
          detail: finalText,
          phase: 'final_answer'
        }, { itemId: `${turnId}:assistant` });
      }
      this.emitProviderEvent(threadId, 'turn.completed', {
        state: 'completed',
        stopReason: 'stop'
      });
      this.updateSessionState(context, 'ready');
    } catch (error) {
      if (context.activeTurnId !== turnId) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.emitProviderEvent(threadId, 'runtime.error', {
        message,
        class: 'pi.provider'
      });
      this.emitProviderEvent(threadId, 'turn.completed', {
        state: 'failed',
        errorMessage: message
      });
      this.updateSessionState(context, 'error', message);
    } finally {
      if (context.activeTurnId === turnId) {
        delete context.activeTurnId;
        context.record = {
          ...context.record,
          activeTurnId: undefined,
          updatedAt: nowIso()
        };
      }
    }
  }

  async compactThread(threadId: string): Promise<void> {
    const context = this.requireSession(threadId);
    if (context.activeTurnId) {
      throw new Error(`Pi provider session ${threadId} cannot compact while a turn is active.`);
    }
    await context.session.compact();
    this.emitProviderEvent(threadId, 'thread.state.changed', {
      state: 'compacted'
    });
  }

  async respondToRequest(): Promise<void> {
    unsupported('runtime approvals');
  }

  async respondToUserInput(): Promise<void> {
    unsupported('provider user-input requests');
  }

  async interruptTurn(threadId: string): Promise<void> {
    const context = this.requireSession(threadId);
    const turnId = context.activeTurnId;
    if (turnId && context.activeTurnId === turnId) {
      this.emitProviderEvent(threadId, 'turn.aborted', {
        reason: 'Interrupted by Moorline.'
      });
      delete context.activeTurnId;
      context.record = {
        ...context.record,
        activeTurnId: undefined,
        updatedAt: nowIso()
      };
      this.updateSessionState(context, 'ready');
    }
    await context.session.abort();
  }

  async drain(): Promise<void> {}

  stopSession(threadId: string): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }
    if (context.activeTurnId) {
      const turnId = context.activeTurnId;
      this.emitProviderEvent(threadId, 'turn.aborted', {
        reason: 'Provider session stopped.'
      });
      delete context.activeTurnId;
      context.record = {
        ...context.record,
        activeTurnId: undefined,
        updatedAt: nowIso()
      };
      void context.session.abort().catch((error: unknown) => {
        this.emit('providerEvent', {
          eventId: randomUUID(),
          providerPackageId: this.options.packageId,
          provider: this.options.packageId,
          providerSessionKind: 'pi-sdk',
          threadId,
          turnId,
          createdAt: nowIso(),
          type: 'runtime.error',
          payload: {
            message: error instanceof Error ? error.message : String(error),
            class: 'pi.provider'
          }
        } as ProviderRuntimeEvent);
      });
    }
    context.unsubscribe();
    context.session.dispose();
    this.updateSessionState(context, 'closed');
    this.sessions.delete(threadId);
  }

  stopAll(): void {
    for (const threadId of [...this.sessions.keys()]) {
      this.stopSession(threadId);
    }
  }

  private async createPiSession(input: PiSessionCreationInput): Promise<AgentSession> {
    const cwd = input.session.providerCwd ?? input.session.workspacePath ?? join(input.runtimeRoot, 'providers', 'pi', 'ephemeral', input.session.threadId.replace(/[^a-z0-9_.-]/gi, '-'));
    const agentDir = this.options.agentDir ?? join(input.runtimeRoot, 'providers', 'pi', 'agent');
    const sessionDir = join(input.runtimeRoot, 'providers', 'pi', 'sessions');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    ensureCodexAuthBridge(agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: (base) => {
        const sections = input.resources?.systemPromptSections ?? [];
        if (sections.length === 0) {
          return input.session.agentKind === 'ephemeral'
            ? 'You are a Moorline ephemeral runtime agent. Use only the tools explicitly available in this session.'
            : base;
        }
        if (input.session.agentKind === 'workspace') {
          return [base, ...sections].filter(Boolean).join('\n\n');
        }
        return sections.join('\n\n');
      },
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: () => ({
        agentsFiles: (input.resources?.contextFiles ?? []).map((file) => ({
          path: file.path,
          content: file.content
        }))
      }),
      skillsOverride: () => ({
        skills: (input.resources?.skills ?? []).map((skill) => ({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
          sourceInfo: createSyntheticSourceInfo(skill.filePath, { source: 'moorline' }),
          disableModelInvocation: false
        })),
        diagnostics: []
      })
    });
    await resourceLoader.reload();
    const resumeValue = input.session.resumeCursor?.provider === this.options.packageId && input.session.resumeCursor.value && typeof input.session.resumeCursor.value === 'object'
      ? input.session.resumeCursor.value as { sessionFile?: unknown }
      : null;
    const sessionFile = typeof resumeValue?.sessionFile === 'string' && existsSync(resumeValue.sessionFile) ? resumeValue.sessionFile : null;
    const sessionManager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd, sessionDir);
    const customTools = (input.tools ?? []).map((tool) =>
      defineTool({
        name: piToolName(tool),
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as never,
        execute: async (_toolCallId, params) => {
          if (!input.toolExecutor) {
            return {
              content: [{ type: 'text', text: `Tool ${tool.name} is unavailable because Moorline did not provide an executor.` }],
              details: { toolId: tool.id }
            };
          }
          try {
            const result = await input.toolExecutor.executeProviderTool({
              threadId: input.session.threadId,
              toolId: tool.id,
              arguments: params as Record<string, unknown>,
              actor: `provider:${this.options.packageId}`
            });
            return {
              content: [{ type: 'text', text: result.content }],
              details: { toolId: tool.id }
            };
          } catch (error) {
            return {
              content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
              error: true,
              details: { toolId: tool.id }
            };
          }
        }
      })
    );
    const customToolNames = (input.tools ?? []).map((tool) => piToolName(tool));
    const nativeToolNames = nativeToolsForProfile(
      input.session.agentKind === 'ephemeral' ? input.session.toolPolicy?.ephemeral : input.session.toolPolicy?.workspace,
      input.session.agentKind
    );
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager,
      customTools,
      tools: [...nativeToolNames, ...customToolNames],
      sessionStartEvent: {
        type: 'session_start',
        reason: 'startup'
      }
    });
    return session;
  }

  private async convertPromptImages(images: ProviderInputImage[]): Promise<PiPromptImage[]> {
    if (images.length > MAX_PROMPT_IMAGE_COUNT) {
      throw new Error(`Too many image attachments. Maximum supported image count is ${MAX_PROMPT_IMAGE_COUNT}.`);
    }
    const converted: PiPromptImage[] = [];
    const totalBytes = { value: 0 };
    for (const image of images) {
      if ('localPath' in image) {
        const fileStats = await stat(image.localPath);
        if (!fileStats.isFile()) {
          throw new Error(`Image attachment path is not a readable file: ${image.localPath}.`);
        }
        if (fileStats.size > MAX_PROMPT_IMAGE_BYTES) {
          throw new Error(`Image attachment ${image.localPath} exceeds the per-image limit of ${MAX_PROMPT_IMAGE_BYTES} bytes.`);
        }
        if (totalBytes.value + fileStats.size > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
          throw new Error(`Image attachments exceed the total limit of ${MAX_PROMPT_IMAGE_TOTAL_BYTES} bytes.`);
        }
        converted.push(imageFromBuffer(await readFile(image.localPath), image.localPath, totalBytes));
        continue;
      }
      const dataImage = imageFromDataUrl(image.url, totalBytes);
      if (dataImage) {
        converted.push(dataImage);
        continue;
      }
      const parsedUrl = new URL(image.url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`Unsupported image URL protocol for ${image.url}. Only http, https, and data image URLs are supported.`);
      }
      const response = await fetch(image.url);
      if (!response.ok) {
        throw new Error(`Unable to fetch image attachment ${image.url}: HTTP ${response.status}.`);
      }
      const declaredLength = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_PROMPT_IMAGE_BYTES) {
        throw new Error(`Image attachment ${image.url} exceeds the per-image limit of ${MAX_PROMPT_IMAGE_BYTES} bytes.`);
      }
      if (Number.isFinite(declaredLength) && totalBytes.value + declaredLength > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
        throw new Error(`Image attachments exceed the total limit of ${MAX_PROMPT_IMAGE_TOTAL_BYTES} bytes.`);
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      converted.push(imageFromBuffer(await readRemoteImageBody(response, image.url, totalBytes), image.url, totalBytes, contentType));
    }
    return converted;
  }

  private handlePiEvent(context: PiSessionContext, event: AgentSessionEvent): void {
    const delta = textFromEvent(event);
    if (delta && context.activeTurnId) {
      this.emitProviderEvent(context.record.threadId, 'content.delta', {
        streamKind: 'assistant_text',
        delta
      }, {
        itemId: `${context.activeTurnId}:assistant`
      });
    }
  }

  private async waitForTurn(threadId: string, turnId: string, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onEvent = (event: ProviderRuntimeEvent): void => {
        if (event.threadId !== threadId || event.turnId !== turnId || event.type !== 'turn.completed') {
          return;
        }
        globalThis.clearTimeout(timer);
        this.off('providerEvent', onEvent);
        if (event.payload.state === 'completed') {
          resolve();
          return;
        }
        reject(new Error(event.payload.errorMessage ?? `Pi provider turn ${event.payload.state}.`));
      };
      const timer = globalThis.setTimeout(() => {
        this.off('providerEvent', onEvent);
        reject(new Error(`Pi provider turn timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.on('providerEvent', onEvent);
    });
  }

  private requireSession(threadId: string): PiSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown Pi provider session: ${threadId}`);
    }
    return context;
  }

  private updateSessionState(context: PiSessionContext, state: ProviderSessionRecord['status'], reason?: string): void {
    context.record = {
      ...context.record,
      status: state,
      ...(reason ? { lastError: reason } : state === 'ready' || state === 'running' ? { lastError: undefined } : {}),
      updatedAt: nowIso()
    };
    this.emitProviderEvent(context.record.threadId, 'session.state.changed', {
      state,
      ...(reason ? { reason } : {})
    });
  }

  private emitProviderEvent(
    threadId: string,
    type: ProviderRuntimeEvent['type'],
    payload: ProviderRuntimeEvent['payload'],
    extra: { itemId?: string } = {}
  ): void {
    const context = this.sessions.get(threadId);
    this.emit('providerEvent', {
      eventId: randomUUID(),
      providerPackageId: this.options.packageId,
      provider: this.options.packageId,
      providerSessionKind: 'pi-sdk',
      threadId,
      createdAt: nowIso(),
      ...(context?.activeTurnId ? { turnId: context.activeTurnId } : {}),
      ...(extra.itemId ? { itemId: extra.itemId } : {}),
      type,
      payload
    } as ProviderRuntimeEvent);
  }
}
