import type { ProviderInputImage } from '@moorline/contracts';

export interface AppServerThreadSummary {
  id: string;
  name: string | null;
  status: string | null;
  archived: boolean | null;
  path: string | null;
}

export interface AppServerSkillSummary {
  name: string;
  description: string | null;
  path: string | null;
  enabled: boolean | null;
}

export interface AppServerPluginSummary {
  id: string;
  marketplacePath: string | null;
  enabled: boolean | null;
  apps: string[];
  skills: string[];
}

export interface AppServerAppSummary {
  name: string;
  needsAuth: boolean | null;
}

export interface AppServerManagementSnapshot {
  threads: {
    loadedIds: string[];
    totalKnown: number;
  };
  skills: {
    count: number;
    names: string[];
  };
  plugins: {
    count: number;
    ids: string[];
  };
  apps: {
    count: number;
    names: string[];
  };
  config: {
    keys: string[];
    requirementKeys: string[];
  };
}

export interface CodexProviderManagement {
  listThreads(threadId: string): Promise<AppServerThreadSummary[]>;
  readThread(threadId: string, providerThreadId: string, includeTurns?: boolean): Promise<AppServerThreadSummary | null>;
  archiveThread(threadId: string, providerThreadId?: string): Promise<void>;
  unarchiveThread(threadId: string, providerThreadId: string): Promise<AppServerThreadSummary | null>;
  setThreadName(threadId: string, name: string, providerThreadId?: string): Promise<void>;
  forkThread(threadId: string, providerThreadId?: string, ephemeral?: boolean): Promise<AppServerThreadSummary | null>;
  rollbackThread(threadId: string, turns: number, providerThreadId?: string): Promise<AppServerThreadSummary | null>;
  steerTurn(
    threadId: string,
    input: { text: string; images?: ProviderInputImage[] },
    expectedTurnId?: string
  ): Promise<{ turnId: string }>;
  listSkills(threadId: string, cwd?: string): Promise<AppServerSkillSummary[]>;
  writeSkillConfig(threadId: string, input: { name?: string; path?: string; enabled: boolean }): Promise<void>;
  listPlugins(threadId: string): Promise<AppServerPluginSummary[]>;
  readPlugin(threadId: string, input: { marketplacePath: string; pluginName: string }): Promise<AppServerPluginSummary | null>;
  installPlugin(threadId: string, input: { marketplacePath: string; pluginName: string }): Promise<void>;
  uninstallPlugin(threadId: string, pluginId: string): Promise<void>;
  listApps(threadId: string): Promise<AppServerAppSummary[]>;
  readConfig(threadId: string): Promise<Record<string, unknown>>;
  readConfigRequirements(threadId: string): Promise<Record<string, unknown>>;
  readManagementSnapshot(threadId: string): Promise<AppServerManagementSnapshot>;
}
