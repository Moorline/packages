import type { RuntimeModeName } from '@moorline/contracts';
import type {
  AppServerAppSummary,
  AppServerPluginSummary,
  AppServerSkillSummary,
  AppServerThreadSummary
} from './managementTypes.js';

export interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    message?: string;
  };
}

export const APP_SERVER_CAPABILITY_MATRIX = {
  runtimeModes: ['full-access', 'approval-required'],
  supportsInterrupts: true,
  supportsThreadCompaction: true,
  supportsApprovalRequests: true,
  supportsUserInputRequests: true,
  supportsResume: true,
  supportsMcpTools: false,
  supportsThreadInspection: true,
  supportsThreadArchive: true,
  supportsThreadFork: true,
  supportsThreadRollback: true,
  supportsTurnSteering: true,
  supportsPluginManagement: true,
  supportsSkillManagement: true,
  supportsAppListing: true,
  supportsConfigInspection: true,
  supportedMethods: [
    'thread/list',
    'thread/read',
    'thread/archive',
    'thread/unarchive',
    'thread/name/set',
    'thread/fork',
    'thread/rollback',
    'thread/loaded/list',
    'turn/interrupt',
    'turn/steer',
    'thread/compact/start',
    'model/list',
    'skills/list',
    'skills/config/write',
    'plugin/list',
    'plugin/read',
    'plugin/install',
    'plugin/uninstall',
    'app/list',
    'config/read',
    'configRequirements/read'
  ]
} as const;

export function mapRuntimeMode(runtimeMode: RuntimeModeName): {
  approvalPolicy: 'untrusted' | 'never';
  sandbox: 'workspace-write' | 'danger-full-access';
} {
  switch (runtimeMode) {
    case 'approval-required':
      return {
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write'
      };
    case 'full-access':
      return {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access'
      };
    default:
      throw new Error(`Unsupported runtime mode: ${String(runtimeMode)}`);
  }
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string' && error.length > 0) {
    return new Error(error);
  }
  return new Error(fallback);
}

export function normalizeThreadSummary(value: unknown): AppServerThreadSummary | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }
  const id = asString(record.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: asString(record.name) ?? asString(record.preview) ?? null,
    status: asString(record.status) ?? null,
    archived: typeof record.archived === 'boolean' ? record.archived : null,
    path: asString(record.path) ?? null
  };
}

export function normalizeSkillSummary(value: unknown): AppServerSkillSummary | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }
  const name = asString(record.name);
  if (!name) {
    return null;
  }
  return {
    name,
    description: asString(record.description) ?? asString(record.short_description) ?? null,
    path: asString(record.path) ?? null,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : null
  };
}

export function normalizePluginSummary(value: unknown): AppServerPluginSummary | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }
  const id = asString(record.pluginId) ?? asString(record.name) ?? asString(asObject(record.summary)?.name);
  if (!id) {
    return null;
  }
  const apps = asArray(record.apps)
    ?.map((entry) => asString(asObject(entry)?.name) ?? asString(entry))
    .filter((entry): entry is string => Boolean(entry)) ?? [];
  const skills = asArray(record.skills)
    ?.map((entry) => asString(asObject(entry)?.name) ?? asString(entry))
    .filter((entry): entry is string => Boolean(entry)) ?? [];
  return {
    id,
    marketplacePath: asString(record.marketplacePath) ?? null,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : null,
    apps,
    skills
  };
}

export function normalizeAppSummary(value: unknown): AppServerAppSummary | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }
  const name = asString(record.name);
  if (!name) {
    return null;
  }
  return {
    name,
    needsAuth: typeof record.needsAuth === 'boolean' ? record.needsAuth : null
  };
}
