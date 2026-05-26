import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAppServerManager } from './codexAppServerManager.js';
import { CodexAdapter } from './codexAdapter.js';
import type {
  ProviderInputImage,
  ProviderRuntimeEvent,
  ProviderSessionRecord,
  RuntimeProviderDiagnostics,
  RuntimeProviderTestResult,
  RuntimeProviderSessionInput
} from '@moorline/contracts';
import { KeyedDrainableWorker } from './providerRuntimeUtils.js';
import type { AppServerManagementSnapshot, CodexProviderManagement } from './managementTypes.js';

interface ProviderServiceEvents {
  providerEvent: [event: ProviderRuntimeEvent];
}

export class ProviderService extends EventEmitter<ProviderServiceEvents> implements CodexProviderManagement {
  private readonly worker = new KeyedDrainableWorker('provider.events');
  private readonly baseCapabilities: Record<string, unknown>;
  private diagnostics: RuntimeProviderDiagnostics = {
    accountLabel: null,
    availableModels: [],
    connectedSessions: 0,
    statusCounts: {},
    capabilityMetadata: {}
  };

  constructor(
    private readonly manager: CodexAppServerManager,
    private readonly adapter: CodexAdapter,
    private readonly codexCommand = 'codex'
  ) {
    super();
    this.baseCapabilities = this.manager.getCapabilities();
    this.diagnostics = {
      accountLabel: null,
      availableModels: [],
      connectedSessions: 0,
      statusCounts: {},
      capabilityMetadata: { ...this.baseCapabilities }
    };
    this.manager.on('event', (event) => {
      void this.worker.push(event.threadId, async () => {
        await this.handleProviderEvent(this.adapter.normalize(event));
      });
    });
  }

  listSessions(): ProviderSessionRecord[] {
    return this.manager.listSessions();
  }

  getDiagnostics(): RuntimeProviderDiagnostics {
    const sessions = this.manager.listSessions();
    const statusCounts = sessions.reduce<Record<string, number>>((counts, session) => {
      counts[session.status] = (counts[session.status] ?? 0) + 1;
      return counts;
    }, {});
    return {
      accountLabel: this.diagnostics.accountLabel,
      availableModels: [...this.diagnostics.availableModels],
      connectedSessions: sessions.length,
      statusCounts,
      capabilityMetadata: { ...this.diagnostics.capabilityMetadata }
    };
  }

  async startOrResumeSession(input: {
    session: RuntimeProviderSessionInput;
    runtimeRoot: string;
    actor: string;
    model?: string;
  }): Promise<ProviderSessionRecord> {
    const existing = this.manager.listSessions().find((entry) => entry.threadId === input.session.threadId);
    if (existing) {
      return existing;
    }

    const resumeThreadId = input.session.resumeThreadId;
    const providerSession = await this.manager.startSession({
      threadId: input.session.threadId,
      runtimeMode: input.session.runtimeMode,
      cwd: input.session.workspacePath,
      codexCommand: this.codexCommand,
      runtimeRoot: input.runtimeRoot,
      spaceId: input.session.spaceId,
      surface: input.session.sessionId.startsWith('chat-') ? 'main_chat' : 'session',
      ...(input.model ? { model: input.model } : {}),
      ...(resumeThreadId ? { resumeCursor: { threadId: resumeThreadId } } : {})
    });

    const metadata = await this.manager.readRuntimeMetadata(input.session.threadId);
    const managementSnapshot = await this.manager.readManagementSnapshot(input.session.threadId).catch(() => null);
    const nextDiagnostics = this.mergeDiagnostics(metadata, managementSnapshot);
    this.diagnostics = nextDiagnostics;
    this.emit('providerEvent', {
      eventId: randomUUID(),
      providerPackageId: providerSession.providerPackageId ?? providerSession.provider ?? 'official/codex',
      provider: providerSession.providerPackageId ?? providerSession.provider ?? 'official/codex',
      threadId: providerSession.threadId,
      createdAt: new Date().toISOString(),
      type: 'session.state.changed',
      payload: {
        state: providerSession.status,
        ...(providerSession.lastError ? { reason: providerSession.lastError } : {})
      }
    });
    this.emit('providerEvent', {
      eventId: randomUUID(),
      providerPackageId: providerSession.providerPackageId ?? providerSession.provider ?? 'official/codex',
      provider: providerSession.providerPackageId ?? providerSession.provider ?? 'official/codex',
      threadId: providerSession.threadId,
      createdAt: new Date().toISOString(),
      type: 'provider.metadata.updated',
      payload: {
        accountLabel: nextDiagnostics.accountLabel,
        availableModels: nextDiagnostics.availableModels
      }
    });
    return providerSession;
  }

  async recoverSessions(input: {
    sessions: RuntimeProviderSessionInput[];
    runtimeRoot: string;
    model?: string;
  }): Promise<void> {
    const failures: Array<{ threadId: string; error: string }> = [];
    for (const session of input.sessions) {
      if (
        session.lifecycleStatus === 'archived' ||
        session.sessionId.startsWith('chat-') ||
        session.providerAutoStartEnabled === false
      ) {
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
        failures.push({ threadId: session.threadId, error: message });
        const occurredAt = new Date().toISOString();
        this.emit('providerEvent', {
          eventId: randomUUID(),
          providerPackageId: 'official/codex',
          provider: 'official/codex',
          threadId: session.threadId,
          createdAt: occurredAt,
          type: 'session.state.changed',
          payload: {
            state: 'error',
            reason: message
          }
        });
        this.emit('providerEvent', {
          eventId: randomUUID(),
          providerPackageId: 'official/codex',
          provider: 'official/codex',
          threadId: session.threadId,
          createdAt: occurredAt,
          type: 'runtime.error',
          payload: {
            message,
            class: 'provider.recovery'
          }
        });
      }
    }
    void failures;
  }

  async testConnection(input: {
    runtimeRoot: string;
    actor: string;
    model?: string;
    sendTurn?: boolean;
    prompt?: string;
  }): Promise<RuntimeProviderTestResult> {
    const threadId = `provider-test-${randomUUID()}`;
    const workspacePath = join(input.runtimeRoot, 'workspaces', '.provider-test');
    mkdirSync(workspacePath, { recursive: true });
    try {
      const providerSession = await this.manager.startSession({
        threadId,
        runtimeMode: 'approval-required',
        cwd: workspacePath,
        codexCommand: this.codexCommand,
        runtimeRoot: input.runtimeRoot,
        spaceId: 'provider-test',
        surface: 'session',
        ...(input.model ? { model: input.model } : {})
      });
      const metadata = await this.manager.readRuntimeMetadata(threadId);
      const managementSnapshot = await this.manager.readManagementSnapshot(threadId).catch(() => null);
      this.diagnostics = this.mergeDiagnostics(metadata, managementSnapshot);
      let sentTurn = false;
      if (input.sendTurn === true) {
        const { turnId } = await this.manager.sendTurn({
          threadId,
          input: { text: input.prompt?.trim() || 'Hello Moorline. This is a provider startup test.' },
          ...(input.model ? { model: input.model } : {})
        });
        sentTurn = true;
        await this.waitForTestTurn(threadId, turnId, 45_000);
      }
      return {
        ok: true,
        message: sentTurn
          ? 'Provider startup test completed, including a test turn.'
          : 'Provider startup test completed.',
        accountLabel: metadata.accountLabel,
        availableModels: metadata.availableModels,
        sentTurn,
        ...(providerSession.lastError ? { error: providerSession.lastError } : {})
      };
    } catch (error) {
      return {
        ok: false,
        message: 'Provider startup test failed.',
        remediation: 'Check the selected provider command, authentication, and diagnostics output.',
        accountLabel: null,
        availableModels: [],
        sentTurn: false,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this.manager.stopSession(threadId);
    }
  }

  async sendTurn(threadId: string, input: { text: string; images?: ProviderInputImage[] }, model?: string): Promise<{ turnId: string }> {
    return await this.manager.sendTurn({ threadId, input, ...(model ? { model } : {}) });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.manager.compactThread(threadId);
  }

  async listThreads(threadId: string) {
    return await this.manager.listThreads(threadId);
  }

  async readThread(threadId: string, providerThreadId: string, includeTurns = false) {
    return await this.manager.readThread(threadId, providerThreadId, includeTurns);
  }

  async archiveThread(threadId: string, providerThreadId?: string): Promise<void> {
    await this.manager.archiveThread(threadId, providerThreadId);
  }

  async unarchiveThread(threadId: string, providerThreadId: string) {
    return await this.manager.unarchiveThread(threadId, providerThreadId);
  }

  async setThreadName(threadId: string, name: string, providerThreadId?: string): Promise<void> {
    await this.manager.setThreadName(threadId, name, providerThreadId);
  }

  async forkThread(threadId: string, providerThreadId?: string, ephemeral = false) {
    return await this.manager.forkThread(threadId, providerThreadId, ephemeral);
  }

  async rollbackThread(threadId: string, turns: number, providerThreadId?: string) {
    return await this.manager.rollbackThread(threadId, turns, providerThreadId);
  }

  async steerTurn(threadId: string, input: { text: string; images?: ProviderInputImage[] }, expectedTurnId?: string) {
    return await this.manager.steerTurn(threadId, input, expectedTurnId);
  }

  async listSkills(threadId: string, cwd?: string) {
    return await this.manager.listSkills(threadId, cwd);
  }

  async writeSkillConfig(threadId: string, input: { name?: string; path?: string; enabled: boolean }): Promise<void> {
    await this.manager.writeSkillConfig(threadId, input);
  }

  async listPlugins(threadId: string) {
    return await this.manager.listPlugins(threadId);
  }

  async readPlugin(threadId: string, input: { marketplacePath: string; pluginName: string }) {
    return await this.manager.readPlugin(threadId, input);
  }

  async installPlugin(threadId: string, input: { marketplacePath: string; pluginName: string }): Promise<void> {
    await this.manager.installPlugin(threadId, input);
  }

  async uninstallPlugin(threadId: string, pluginId: string): Promise<void> {
    await this.manager.uninstallPlugin(threadId, pluginId);
  }

  async listApps(threadId: string) {
    return await this.manager.listApps(threadId);
  }

  async readConfig(threadId: string) {
    return await this.manager.readConfig(threadId);
  }

  async readConfigRequirements(threadId: string) {
    return await this.manager.readConfigRequirements(threadId);
  }

  async readManagementSnapshot(threadId: string) {
    return await this.manager.readManagementSnapshot(threadId);
  }

  async respondToRequest(threadId: string, requestId: string, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): Promise<void> {
    await this.manager.respondToRequest(threadId, requestId, decision);
  }

  async respondToUserInput(threadId: string, requestId: string, answers: Record<string, string | string[]>): Promise<void> {
    await this.manager.respondToUserInput(threadId, requestId, answers);
  }

  async interruptTurn(threadId: string): Promise<void> {
    await this.manager.interruptTurn(threadId);
  }

  async drain(): Promise<void> {
    await this.worker.drain();
  }

  stopSession(threadId: string): void {
    this.manager.stopSession(threadId);
  }

  stopAll(): void {
    this.manager.stopAll();
  }

  private async handleProviderEvent(event: ProviderRuntimeEvent): Promise<void> {
    this.emit('providerEvent', event);
  }

  private async waitForTestTurn(threadId: string, turnId: string, timeoutMs: number): Promise<void> {
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
        reject(new Error(event.payload.errorMessage ?? `Provider test turn ${event.payload.state}.`));
      };
      const timer = globalThis.setTimeout(() => {
        this.off('providerEvent', onEvent);
        reject(new Error(`Provider test turn timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.on('providerEvent', onEvent);
    });
  }

  private mergeDiagnostics(
    metadata: {
      accountLabel: string | null;
      availableModels: string[];
    },
    managementSnapshot: AppServerManagementSnapshot | null
  ): RuntimeProviderDiagnostics {
    const accountLabel =
      typeof metadata.accountLabel === 'string' && metadata.accountLabel.trim().length > 0
        ? metadata.accountLabel
        : this.diagnostics.accountLabel;
    const availableModels =
      metadata.availableModels.length > 0 ? [...metadata.availableModels] : [...this.diagnostics.availableModels];

    return {
      accountLabel,
      availableModels,
      connectedSessions: this.manager.listSessions().length,
      statusCounts: this.getDiagnostics().statusCounts,
      capabilityMetadata: {
        ...this.manager.getCapabilities(),
        ...(managementSnapshot ? { managementSnapshot } : {})
      }
    };
  }

}
