import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import type {
  ProviderAccountMetadata,
  ProviderInputImage,
  ProviderApprovalDecision,
  ProviderSessionRecord
} from '@moorline/contracts';
import type {
  AppServerAppSummary,
  AppServerManagementSnapshot,
  AppServerPluginSummary,
  AppServerSkillSummary,
  AppServerThreadSummary
} from './managementTypes.js';
import { buildChildProcessEnv } from './providerRuntimeUtils.js';
import {
  APP_SERVER_CAPABILITY_MATRIX,
  asArray,
  asObject,
  asString,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  mapRuntimeMode,
  normalizeAppSummary,
  normalizePluginSummary,
  normalizeSkillSummary,
  normalizeThreadSummary,
  nowIso,
  toError
} from './codexAppServerProtocol.js';
import { mapAppServerNotification, mapAppServerRequest } from './codexAppServerEventMapping.js';
import {
  CODEX_PROVIDER_PACKAGE_ID,
  CodexAppServerRequestTimeoutError,
  DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS,
  MIN_STARTUP_REQUEST_TIMEOUT_MS,
  toAppServerInputItems,
  type CodexAppServerManagerEvents,
  type CodexAppServerSendTurnInput,
  type CodexAppServerStartSessionInput,
  type SessionContext
} from './codexAppServerTypes.js';

export { CodexAppServerRequestTimeoutError };

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly terminatedSessions = new Map<string, string>();
  private readonly requestTimeoutMs: number;

  constructor(options: { requestTimeoutMs?: number } = {}) {
    super();
    const configured = options.requestTimeoutMs;
    this.requestTimeoutMs =
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS;
  }

  getCapabilities(): Record<string, unknown> {
    return { ...APP_SERVER_CAPABILITY_MATRIX };
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSessionRecord> {
    if (this.sessions.has(input.threadId)) {
      return { ...this.sessions.get(input.threadId)!.session };
    }
    this.terminatedSessions.delete(input.threadId);

    const child = spawn(input.codexCommand, ['app-server'], {
      cwd: input.cwd,
      env: buildChildProcessEnv({
        explicit: {
          ...(input.codexHomePath ? { CODEX_HOME: input.codexHomePath } : {})
        }
      }),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const output = readline.createInterface({ input: child.stdout });
    const createdAt = nowIso();
    const context: SessionContext = {
      session: {
        providerPackageId: CODEX_PROVIDER_PACKAGE_ID,
        provider: 'codex',
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        status: 'connecting',
        createdAt,
        updatedAt: createdAt
      },
      child,
      output,
      nextRequestId: 1,
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      stopping: false,
      finalized: false
    };

    this.sessions.set(input.threadId, context);
    this.attach(context);
    const startupTimeoutMs = Math.max(this.requestTimeoutMs, MIN_STARTUP_REQUEST_TIMEOUT_MS);

    try {
      await this.sendRequest(context, 'initialize', {
        clientInfo: {
          name: 'moorline',
          title: 'Moorline',
          version: '0.0.1'
        },
        capabilities: {
          experimentalApi: true
        }
      }, { timeoutMs: startupTimeoutMs });
      await this.writeMessage(context, { method: 'initialized' });

      const metadata = await this.readRuntimeMetadataForContext(context);
      this.emit('event', {
        eventId: randomUUID(),
        providerPackageId: CODEX_PROVIDER_PACKAGE_ID,
        provider: 'codex',
        threadId: input.threadId,
        createdAt: nowIso(),
        type: 'provider.metadata.updated',
        payload: metadata
      });

      const sessionOverrides = {
        ...(input.model ? { model: input.model } : {}),
        cwd: input.cwd,
        ...mapRuntimeMode(input.runtimeMode)
      };

      let threadResponse: unknown;
      if (input.resumeCursor?.threadId) {
        try {
          threadResponse = await this.sendRequest(context, 'thread/resume', {
            ...sessionOverrides,
            threadId: input.resumeCursor.threadId
          }, { timeoutMs: startupTimeoutMs });
        } catch (error) {
          if (!this.isContextActive(context)) {
            throw error;
          }
          threadResponse = await this.sendRequest(context, 'thread/start', sessionOverrides, { timeoutMs: startupTimeoutMs });
        }
      } else {
        threadResponse = await this.sendRequest(context, 'thread/start', sessionOverrides, { timeoutMs: startupTimeoutMs });
      }

      const thread = asObject(asObject(threadResponse)?.thread);
      const providerThreadId = asString(thread?.id) ?? asString(asObject(threadResponse)?.threadId);
      const resolvedModel = asString(asObject(threadResponse)?.model) ?? input.model;
      if (!providerThreadId) {
        throw new Error('thread/start did not return a provider thread id');
      }

      context.session = {
        ...context.session,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        status: 'ready',
        resumeCursor: {
          threadId: providerThreadId
        },
        updatedAt: nowIso()
      };

      this.emit('event', {
        eventId: randomUUID(),
        providerPackageId: CODEX_PROVIDER_PACKAGE_ID,
        provider: 'codex',
        threadId: input.threadId,
        createdAt: nowIso(),
        type: 'thread.started',
        payload: {
          providerThreadId
        }
      });

      return { ...context.session };
    } catch (error) {
      if (this.isContextActive(context)) {
        this.teardownSession(context, {
          reason: this.describeError(error, 'Session startup failed'),
          pendingError: 'Session startup failed before request completed.',
          lastError: this.describeError(error)
        });
      }
      throw error;
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<{ turnId: string }> {
    const context = this.requireSession(input.threadId);
    const providerThreadId = context.session.resumeCursor?.threadId;
    if (!providerThreadId) {
      throw new Error('Session is missing a provider thread id');
    }

    const response = await this.sendRequest(context, 'turn/start', {
      threadId: providerThreadId,
      input: toAppServerInputItems(input.input),
      ...(input.model ? { model: input.model } : {})
    });

    const turn = asObject(asObject(response)?.turn);
    const turnId = asString(turn?.id);
    if (!turnId) {
      throw new Error('turn/start did not return a turn id');
    }

    context.session = {
      ...context.session,
      status: 'running',
      activeTurnId: turnId,
      updatedAt: nowIso()
    };

    return { turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const context = this.requireSession(threadId);
    const providerThreadId = context.session.resumeCursor?.threadId;
    const turnId = context.session.activeTurnId;
    if (!providerThreadId || !turnId) {
      throw new Error('No active provider turn to interrupt');
    }

    await this.sendRequest(context, 'turn/interrupt', {
      threadId: providerThreadId,
      turnId
    });
  }

  async compactThread(threadId: string): Promise<void> {
    const context = this.requireSession(threadId);
    const providerThreadId = context.session.resumeCursor?.threadId;
    if (!providerThreadId) {
      throw new Error('Session is missing a provider thread id');
    }

    await this.sendRequest(context, 'thread/compact/start', {
      threadId: providerThreadId
    });
  }

  async listThreads(threadId: string): Promise<AppServerThreadSummary[]> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'thread/list', {});
    const records = asObject(response);
    const threads = asArray(records?.threads) ?? asArray(records?.data) ?? asArray(response) ?? [];
    return threads.map((entry) => normalizeThreadSummary(entry)).filter((entry): entry is AppServerThreadSummary => entry !== null);
  }

  async readThread(threadId: string, providerThreadId: string, includeTurns = false): Promise<AppServerThreadSummary | null> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'thread/read', {
      threadId: providerThreadId,
      includeTurns
    });
    const record = asObject(response);
    return normalizeThreadSummary(record?.thread ?? response);
  }

  async archiveThread(threadId: string, providerThreadId?: string): Promise<void> {
    const context = this.requireSession(threadId);
    await this.sendRequest(context, 'thread/archive', {
      threadId: this.resolveProviderThreadId(context, providerThreadId)
    });
  }

  async unarchiveThread(threadId: string, providerThreadId: string): Promise<AppServerThreadSummary | null> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'thread/unarchive', {
      threadId: providerThreadId
    });
    const record = asObject(response);
    return normalizeThreadSummary(record?.thread ?? response);
  }

  async setThreadName(threadId: string, name: string, providerThreadId?: string): Promise<void> {
    const context = this.requireSession(threadId);
    await this.sendRequest(context, 'thread/name/set', {
      threadId: this.resolveProviderThreadId(context, providerThreadId),
      name
    });
  }

  async forkThread(threadId: string, providerThreadId?: string, ephemeral = false): Promise<AppServerThreadSummary | null> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'thread/fork', {
      threadId: this.resolveProviderThreadId(context, providerThreadId),
      ephemeral
    });
    const record = asObject(response);
    return normalizeThreadSummary(record?.thread ?? response);
  }

  async rollbackThread(threadId: string, turns: number, providerThreadId?: string): Promise<AppServerThreadSummary | null> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'thread/rollback', {
      threadId: this.resolveProviderThreadId(context, providerThreadId),
      turns
    });
    const record = asObject(response);
    return normalizeThreadSummary(record?.thread ?? response);
  }

  async steerTurn(
    threadId: string,
    input: {
      text: string;
      images?: ProviderInputImage[];
    },
    expectedTurnId?: string
  ): Promise<{ turnId: string }> {
    const context = this.requireSession(threadId);
    const providerThreadId = this.resolveProviderThreadId(context);
    const response = await this.sendRequest(context, 'turn/steer', {
      threadId: providerThreadId,
      input: toAppServerInputItems(input),
      ...(expectedTurnId ? { expectedTurnId } : {})
    });
    const record = asObject(response);
    const turnId = asString(record?.turnId) ?? asString(asObject(record?.turn)?.id) ?? expectedTurnId;
    if (!turnId) {
      throw new Error('turn/steer did not return a turn id');
    }
    return { turnId };
  }

  async listLoadedThreads(threadId: string): Promise<string[]> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'thread/loaded/list', {});
    const record = asObject(response);
    const threads = asArray(record?.threadIds) ?? asArray(record?.threads) ?? asArray(response) ?? [];
    return threads
      .map((entry) => asString(asObject(entry)?.id) ?? asString(entry))
      .filter((entry): entry is string => Boolean(entry));
  }

  async listSkills(threadId: string, cwd?: string): Promise<AppServerSkillSummary[]> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'skills/list', {
      cwds: [cwd ?? context.session.cwd]
    });
    const record = asObject(response);
    const skills = asArray(record?.skills) ?? asArray(record?.data) ?? asArray(response) ?? [];
    return skills.map((entry) => normalizeSkillSummary(entry)).filter((entry): entry is AppServerSkillSummary => entry !== null);
  }

  async writeSkillConfig(
    threadId: string,
    input: {
      name?: string;
      path?: string;
      enabled: boolean;
    }
  ): Promise<void> {
    const context = this.requireSession(threadId);
    await this.sendRequest(context, 'skills/config/write', input);
  }

  async listPlugins(threadId: string): Promise<AppServerPluginSummary[]> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'plugin/list', {});
    const record = asObject(response);
    const plugins = asArray(record?.plugins) ?? asArray(record?.data) ?? asArray(response) ?? [];
    return plugins.map((entry) => normalizePluginSummary(entry)).filter((entry): entry is AppServerPluginSummary => entry !== null);
  }

  async readPlugin(
    threadId: string,
    input: {
      marketplacePath: string;
      pluginName: string;
    }
  ): Promise<AppServerPluginSummary | null> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'plugin/read', input);
    return normalizePluginSummary(asObject(response)?.plugin ?? response);
  }

  async installPlugin(
    threadId: string,
    input: {
      marketplacePath: string;
      pluginName: string;
    }
  ): Promise<void> {
    const context = this.requireSession(threadId);
    await this.sendRequest(context, 'plugin/install', input);
  }

  async uninstallPlugin(threadId: string, pluginId: string): Promise<void> {
    const context = this.requireSession(threadId);
    await this.sendRequest(context, 'plugin/uninstall', {
      pluginId
    });
  }

  async listApps(threadId: string): Promise<AppServerAppSummary[]> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'app/list', {});
    const record = asObject(response);
    const apps = asArray(record?.apps) ?? asArray(record?.data) ?? asArray(response) ?? [];
    return apps.map((entry) => normalizeAppSummary(entry)).filter((entry): entry is AppServerAppSummary => entry !== null);
  }

  async readConfig(threadId: string): Promise<Record<string, unknown>> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'config/read', {});
    return asObject(asObject(response)?.config) ?? asObject(response) ?? {};
  }

  async readConfigRequirements(threadId: string): Promise<Record<string, unknown>> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, 'configRequirements/read', {});
    return asObject(asObject(response)?.requirements) ?? asObject(response) ?? {};
  }

  async readManagementSnapshot(threadId: string): Promise<AppServerManagementSnapshot> {
    const [threads, loadedIds, skills, plugins, apps, config, requirements] = await Promise.all([
      this.listThreads(threadId).catch(() => []),
      this.listLoadedThreads(threadId).catch(() => []),
      this.listSkills(threadId).catch(() => []),
      this.listPlugins(threadId).catch(() => []),
      this.listApps(threadId).catch(() => []),
      this.readConfig(threadId).catch(() => ({})),
      this.readConfigRequirements(threadId).catch(() => ({}))
    ]);

    return {
      threads: {
        loadedIds,
        totalKnown: threads.length
      },
      skills: {
        count: skills.length,
        names: skills.map((skill) => skill.name)
      },
      plugins: {
        count: plugins.length,
        ids: plugins.map((plugin) => plugin.id)
      },
      apps: {
        count: apps.length,
        names: apps.map((app) => app.name)
      },
      config: {
        keys: Object.keys(config),
        requirementKeys: Object.keys(requirements)
      }
    };
  }

  async readRuntimeMetadata(threadId: string): Promise<ProviderAccountMetadata> {
    const context = this.requireSession(threadId);
    return await this.readRuntimeMetadataForContext(context);
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: ProviderApprovalDecision
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    await this.writeMessage(context, {
      id: pending.jsonRpcId,
      result: {
        decision
      }
    });
    context.pendingApprovals.delete(requestId);
    this.emit('event', {
      eventId: randomUUID(),
      providerPackageId: CODEX_PROVIDER_PACKAGE_ID,
        provider: 'codex',
      threadId,
      createdAt: nowIso(),
      turnId: pending.turnId ?? undefined,
      itemId: pending.itemId ?? undefined,
      requestId,
      type: 'request.resolved',
      payload: {
        requestType: pending.requestType,
        decision,
        resolution: {
          decision
        }
      }
    });
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    const normalizedAnswers = Object.fromEntries(
      Object.entries(answers).map(([key, value]) => [
        key,
        {
          answers: Array.isArray(value) ? value : [value]
        }
      ])
    );

    await this.writeMessage(context, {
      id: pending.jsonRpcId,
      result: {
        answers: normalizedAnswers
      }
    });
    context.pendingUserInputs.delete(requestId);
    this.emit('event', {
      eventId: randomUUID(),
      providerPackageId: CODEX_PROVIDER_PACKAGE_ID,
        provider: 'codex',
      threadId,
      createdAt: nowIso(),
      turnId: pending.turnId ?? undefined,
      itemId: pending.itemId ?? undefined,
      requestId,
      type: 'user-input.resolved',
      payload: {
        answers
      }
    });
  }

  stopSession(threadId: string): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    this.teardownSession(context, {
      reason: 'Session stopped',
      pendingError: 'Session stopped before request completed.'
    });
  }

  stopAll(): void {
    for (const threadId of [...this.sessions.keys()]) {
      this.stopSession(threadId);
    }
  }

  listSessions(): ProviderSessionRecord[] {
    return [...this.sessions.values()].map(({ session }) => ({ ...session }));
  }

  private requireSession(threadId: string): SessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      const terminationReason = this.terminatedSessions.get(threadId);
      if (terminationReason) {
        this.terminatedSessions.delete(threadId);
        throw new Error(terminationReason);
      }
      throw new Error(`Unknown provider session: ${threadId}`);
    }
    return context;
  }

  private resolveProviderThreadId(context: SessionContext, providerThreadId?: string): string {
    const resolved = providerThreadId ?? context.session.resumeCursor?.threadId;
    if (!resolved) {
      throw new Error('Session is missing a provider thread id');
    }
    return resolved;
  }

  private attach(context: SessionContext): void {
    context.output.on('line', (line) => {
      this.handleStdoutLine(context, line);
    });

    context.child.on('error', (error) => {
      this.handleSessionFailure(
        context,
        `Codex provider child exited unexpectedly for thread "${context.session.threadId}": ${error.message}`,
        true,
        context.session.status !== 'connecting'
      );
    });

    context.child.stdin.on('error', (error) => {
      this.handleSessionFailure(
        context,
        this.formatWriteFailureReason(error),
        true,
        context.session.status !== 'connecting'
      );
    });

    context.child.stderr.on('data', (chunk: Uint8Array | string) => {
      const message = String(chunk).trim();
      if (!message) {
        return;
      }
      this.emit('event', {
        eventId: randomUUID(),
        providerPackageId: CODEX_PROVIDER_PACKAGE_ID,
        provider: 'codex',
        threadId: context.session.threadId,
        createdAt: nowIso(),
        type: 'runtime.warning',
        payload: {
          message
        }
      });
    });

    context.child.on('exit', (code, signal) => {
      if (context.stopping || context.finalized) {
        return;
      }
      this.handleSessionFailure(
        context,
        this.formatExitReason(context, code, signal),
        false,
        context.session.status !== 'connecting'
      );
    });
  }

  private handleStdoutLine(context: SessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.emit('event', {
        eventId: randomUUID(),
        providerPackageId: CODEX_PROVIDER_PACKAGE_ID,
        provider: 'codex',
        threadId: context.session.threadId,
        createdAt: nowIso(),
        type: 'runtime.error',
        payload: {
          message: 'Received invalid JSON from codex app-server',
          detail: 'Invalid JSON payload received from codex app-server output stream.'
        }
      });
      return;
    }

    const response = asObject(parsed);
    if (!response) {
      return;
    }

    if (typeof response.method === 'string' && Object.prototype.hasOwnProperty.call(response, 'id')) {
      this.handleRequest(context, response as unknown as JsonRpcRequest);
      return;
    }

    if (typeof response.id === 'number') {
      this.handleResponse(context, response as unknown as JsonRpcResponse);
      return;
    }

    if (typeof response.method === 'string') {
      this.handleNotification(context, response as unknown as JsonRpcNotification);
    }
  }

  private handleResponse(context: SessionContext, response: JsonRpcResponse): void {
    const pending = context.pending.get(response.id);
    if (!pending) {
      return;
    }
    context.pending.delete(response.id);
    pending.cleanup();
    if (response.error) {
      pending.reject(new Error(response.error.message ?? 'codex app-server request failed'));
      return;
    }
    pending.resolve(response.result);
  }

  private handleRequest(context: SessionContext, request: JsonRpcRequest): void {
    const mapping = mapAppServerRequest(context.session.threadId, request);
    if (mapping.kind === 'user-input') {
      context.pendingUserInputs.set(mapping.pending.requestId, mapping.pending);
      this.emit('event', mapping.event);
      return;
    }

    context.pendingApprovals.set(mapping.pending.requestId, mapping.pending);
    this.emit('event', mapping.event);
  }

  private handleNotification(context: SessionContext, notification: JsonRpcNotification): void {
    const mapping = mapAppServerNotification(context.session.threadId, notification);
    if (!mapping) {
      return;
    }
    if (mapping.sessionPatch) {
      context.session = {
        ...context.session,
        ...mapping.sessionPatch
      };
    }
    this.emit('event', mapping.event);
  }

  private async sendRequest(
    context: SessionContext,
    method: string,
    params: unknown,
    options: { signal?: globalThis.AbortSignal; timeoutMs?: number } = {}
  ): Promise<unknown> {
    this.assertContextActive(context);
    const id = context.nextRequestId++;
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : this.requestTimeoutMs;
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof globalThis.setTimeout> | null = globalThis.setTimeout(() => {
        const pending = context.pending.get(id);
        if (!pending) {
          return;
        }
        context.pending.delete(id);
        pending.cleanup();
        pending.reject(new CodexAppServerRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      const onAbort = () => {
        const pending = context.pending.get(id);
        if (!pending) {
          return;
        }
        context.pending.delete(id);
        pending.cleanup();
        pending.reject(new Error(`codex app-server request "${method}" was aborted.`));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          globalThis.clearTimeout(timeout);
          timeout = null;
        }
        options.signal?.removeEventListener('abort', onAbort);
      };
      context.pending.set(id, {
        method,
        cleanup,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        }
      });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      void this.writeMessage(context, { id, method, params }).catch((error) => {
        const pending = context.pending.get(id);
        if (pending && context.pending.delete(id)) {
          pending.cleanup();
          reject(toError(error, `codex app-server request failed: ${method}`));
        }
      });
    });
  }

  private async writeMessage(
    context: SessionContext,
    payload: JsonRpcRequest | JsonRpcNotification | { id: number; result: unknown }
  ): Promise<void> {
    const message = `${JSON.stringify(payload)}\n`;
    if (context.finalized) {
      throw new Error(context.session.lastError ?? 'codex app-server session is closed');
    }
    if (
      context.child.exitCode !== null ||
      context.child.signalCode !== null ||
      context.child.stdin.destroyed ||
      context.child.stdin.writableEnded
    ) {
      throw this.handleSessionFailure(
        context,
        this.formatProcessUnavailableReason(context),
        false,
        context.session.status !== 'connecting'
      );
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        context.child.stdin.off('error', onStdinError);
        context.child.off('exit', onExit);
        if (error) {
          reject(
            this.handleSessionFailure(
              context,
              this.formatWriteFailureReason(error),
              true,
              context.session.status !== 'connecting'
            )
          );
          return;
        }
        resolve();
      };
      const onStdinError = (error: Error) => {
        settle(error);
      };
      const onExit = (code: number | null, signal: string | null) => {
        settle(new Error(this.formatExitReason(context, code, signal)));
      };

      context.child.stdin.once('error', onStdinError);
      context.child.once('exit', onExit);
      try {
        context.child.stdin.write(message, (error?: Error | null) => {
          settle(error ?? undefined);
        });
      } catch (error) {
        settle(error);
      }
    });
  }

  private formatExitReason(context: SessionContext, code: number | null, signal: string | null): string {
    return `Codex provider child exited unexpectedly for thread "${context.session.threadId}" (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
  }

  private formatProcessUnavailableReason(context: SessionContext): string {
    if (context.child.exitCode !== null || context.child.signalCode !== null) {
      return this.formatExitReason(context, context.child.exitCode, context.child.signalCode);
    }
    return 'codex app-server stdin is not writable';
  }

  private formatWriteFailureReason(error: unknown): string {
    return `codex app-server stdin write failed: ${toError(error, 'Unknown stream failure').message}`;
  }

  private handleSessionFailure(
    context: SessionContext,
    reason: string,
    terminateChild: boolean,
    rememberTerminationReason: boolean
  ): Error {
    const error = new Error(context.session.lastError ?? reason);
    if (context.stopping || context.finalized) {
      return error;
    }

    context.finalized = true;
    context.session = {
      ...context.session,
      status: 'closed',
      activeTurnId: undefined,
      updatedAt: nowIso(),
      lastError: reason
    };

    if (rememberTerminationReason) {
      this.terminatedSessions.set(context.session.threadId, reason);
    }

    const sessionError = new Error(reason);
    for (const pending of context.pending.values()) {
      pending.cleanup();
      pending.reject(new Error(`${reason} Pending request "${pending.method}" was aborted.`));
    }
    context.pending.clear();
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();
    context.output.close();

    if (terminateChild && context.child.exitCode === null && context.child.signalCode === null && !context.child.killed) {
      context.child.kill();
    }

    this.sessions.delete(context.session.threadId);
    this.emit('event', {
      eventId: randomUUID(),
      providerPackageId: CODEX_PROVIDER_PACKAGE_ID,
      provider: 'codex',
      threadId: context.session.threadId,
      createdAt: nowIso(),
      type: 'session.state.changed',
      payload: {
        state: 'closed',
        reason
      }
    });

    return sessionError;
  }

  private async readRuntimeMetadataForContext(context: SessionContext): Promise<ProviderAccountMetadata> {
    const availableModels = await this.readAvailableModels(context);
    const accountLabel = await this.readAccountLabel(context);
    return {
      accountLabel,
      availableModels
    };
  }

  private async readAvailableModels(context: SessionContext): Promise<string[]> {
    try {
      const response = await this.sendRequest(context, 'model/list', {});
      const record = asObject(response);
      const models = asArray(record?.data) ?? asArray(record?.models) ?? asArray(response);
      if (!models) {
        return [];
      }
      return models
        .map((entry) => {
          const record = asObject(entry);
          return asString(record?.id) ?? asString(entry);
        })
        .filter((entry): entry is string => Boolean(entry));
    } catch {
      return [];
    }
  }

  private async readAccountLabel(context: SessionContext): Promise<string | null> {
    try {
      const response = await this.sendRequest(context, 'account/read', {});
      const record = asObject(response);
      return (
        asString(record?.email) ??
        asString(record?.name) ??
        asString(asObject(record?.account)?.email) ??
        asString(asObject(record?.account)?.name) ??
        null
      );
    } catch {
      return null;
    }
  }

  private teardownSession(
    context: SessionContext,
    options: {
      reason: string;
      pendingError: string;
      lastError?: string;
      shouldKillChild?: boolean;
    }
  ): void {
    if (context.stopping || context.finalized) {
      return;
    }

    const threadId = context.session.threadId;
    context.stopping = true;
    context.finalized = true;

    const pendingError = new Error(options.pendingError);
    for (const pending of context.pending.values()) {
      pending.cleanup();
      pending.reject(pendingError);
    }
    context.pending.clear();
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();
    context.output.close();

    if (options.shouldKillChild !== false && !context.child.killed) {
      context.child.kill();
    }

    context.session = {
      ...context.session,
      status: 'closed',
      activeTurnId: undefined,
      updatedAt: nowIso(),
      ...(options.lastError ? { lastError: options.lastError } : {})
    };
    this.sessions.delete(threadId);
    this.emit('event', {
      eventId: randomUUID(),
      providerPackageId: CODEX_PROVIDER_PACKAGE_ID,
      provider: 'codex',
      threadId,
      createdAt: nowIso(),
      type: 'session.state.changed',
      payload: {
        state: 'closed',
        reason: options.reason
      }
    });
  }

  private isContextActive(context: SessionContext): boolean {
    return !context.stopping && !context.finalized && this.sessions.get(context.session.threadId) === context;
  }

  private assertContextActive(context: SessionContext): void {
    if (this.isContextActive(context)) {
      return;
    }

    throw new Error(context.session.lastError ?? 'codex app-server is not running');
  }

  private describeError(error: unknown, fallback = 'Unknown error'): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }

    if (typeof error === 'string' && error.length > 0) {
      return error;
    }

    return fallback;
  }
}
