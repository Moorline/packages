import { randomUUID } from 'node:crypto';
import type {
  CanonicalItemType,
  PendingRuntimeRequestRecord,
  ProviderRuntimeEvent,
  ProviderMessagePhase,
  ProviderSessionRecord,
  ProviderThreadTokenUsage
} from '@moorline/contracts';
import { redactPayloadForLogs } from './providerRuntimeUtils.js';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  nowIso,
  type JsonRpcNotification,
  type JsonRpcRequest
} from './codexAppServerProtocol.js';

const CODEX_PROVIDER_PACKAGE_ID = 'rync/codex';

export interface PendingApproval {
  requestId: string;
  turnId: string | null;
  itemId: string | null;
  jsonRpcId: number;
  requestType: PendingRuntimeRequestRecord['requestType'];
  detail: string | null;
}

export interface PendingUserInput {
  requestId: string;
  turnId: string | null;
  itemId: string | null;
  jsonRpcId: number;
  questions: PendingRuntimeRequestRecord['questionsJson'];
}

type AppServerRequestMapping =
  | {
      kind: 'approval';
      pending: PendingApproval;
      event: ProviderRuntimeEvent;
    }
  | {
      kind: 'user-input';
      pending: PendingUserInput;
      event: ProviderRuntimeEvent;
    };

interface AppServerNotificationMapping {
  event: ProviderRuntimeEvent;
  sessionPatch?: Partial<ProviderSessionRecord>;
}

function providerEventBase(threadId: string): Pick<ProviderRuntimeEvent, 'eventId' | 'providerPackageId' | 'provider' | 'threadId' | 'createdAt'> {
  return {
    eventId: randomUUID(),
    providerPackageId: CODEX_PROVIDER_PACKAGE_ID,
    provider: 'codex',
    threadId,
    createdAt: nowIso()
  };
}

function toCanonicalRequestType(method: string): PendingRuntimeRequestRecord['requestType'] {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return 'command_execution_approval';
    case 'item/fileRead/requestApproval':
      return 'file_read_approval';
    case 'item/fileChange/requestApproval':
      return 'file_change_approval';
    case 'applyPatchApproval':
      return 'apply_patch_approval';
    case 'execCommandApproval':
      return 'exec_command_approval';
    case 'item/tool/requestUserInput':
      return 'tool_user_input';
    case 'item/tool/call':
      return 'dynamic_tool_call';
    case 'account/chatgptAuthTokens/refresh':
      return 'auth_tokens_refresh';
    default:
      return 'unknown';
  }
}

function normalizeItemType(raw: unknown): CanonicalItemType {
  const value = asString(raw)?.toLowerCase() ?? 'unknown';
  if (value.includes('assistant')) return 'assistant_message';
  if (value.includes('reasoning')) return 'reasoning';
  if (value.includes('plan')) return 'plan';
  if (value.includes('command')) return 'command_execution';
  if (value.includes('file')) return 'file_change';
  if (value.includes('web')) return 'web_search';
  if (value.includes('image')) return 'image_view';
  if (value.includes('tool')) return 'dynamic_tool_call';
  if (value.includes('error')) return 'error';
  return 'unknown';
}

function normalizeMessagePhase(raw: unknown): ProviderMessagePhase | undefined {
  const value = asString(raw)?.toLowerCase();
  if (value === 'commentary' || value === 'final_answer') {
    return value;
  }
  return undefined;
}

function extractLocalImagePath(
  itemType: CanonicalItemType,
  item: Record<string, unknown> | undefined,
  params: Record<string, unknown> | undefined
): string | undefined {
  if (itemType === 'image_view') {
    return asString(item?.path) ?? asString(item?.saved_path) ?? asString(params?.path) ?? asString(params?.saved_path);
  }

  return undefined;
}

function extractQuestions(params: Record<string, unknown> | undefined): PendingRuntimeRequestRecord['questionsJson'] {
  const questions = asArray(params?.questions);
  if (!questions) {
    return null;
  }

  const normalized = questions
    .map((entry) => {
      const question = asObject(entry);
      if (!question) return null;
      const id = asString(question.id);
      const header = asString(question.header);
      const prompt = asString(question.question);
      const options = asArray(question.options)
        ?.map((option) => {
          const record = asObject(option);
          if (!record) return null;
          const label = asString(record.label);
          const description = asString(record.description);
          if (!label || !description) return null;
          return { label, description };
        })
        .filter((option): option is { label: string; description: string } => option !== null);
      if (!id || !header || !prompt || !options || options.length === 0) {
        return null;
      }
      return { id, header, question: prompt, options };
    })
    .filter(
      (
        question
      ): question is {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
      } => question !== null
    );

  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function parseQuestions(questionsJson: PendingRuntimeRequestRecord['questionsJson']): Array<{
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
}> {
  return questionsJson
    ? (JSON.parse(questionsJson) as Array<{
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
      }>)
    : [];
}

function redactedParamsSummary(params: unknown): Record<string, unknown> {
  const redacted = redactPayloadForLogs(params, {
    maxDepth: 2,
    maxArrayLength: 8,
    maxObjectKeys: 12,
    maxStringLength: 120,
    redactedKeyPatterns: [
      /token/i,
      /secret/i,
      /password/i,
      /authorization/i,
      /cookie/i,
      /api[_-]?key/i,
      /args?/i,
      /command/i,
      /prompt/i,
      /path/i,
      /cwd/i
    ]
  });
  if (redacted && typeof redacted === 'object') {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}

function approvalDetailSummary(requestType: PendingRuntimeRequestRecord['requestType']): string | null {
  switch (requestType) {
    case 'command_execution_approval':
    case 'exec_command_approval':
      return 'Command execution approval requested.';
    case 'file_read_approval':
      return 'File read approval requested.';
    case 'file_change_approval':
    case 'apply_patch_approval':
      return 'File change approval requested.';
    case 'dynamic_tool_call':
      return 'Tool call approval requested.';
    default:
      return null;
  }
}

function extractTokenUsage(params: Record<string, unknown> | undefined): ProviderThreadTokenUsage | null {
  const usage = asObject(params?.tokenUsage) ?? params;
  const totalTokens = asNumber(usage?.total) ?? asNumber(usage?.totalTokens);
  if (totalTokens === undefined) {
    return null;
  }

  return {
    totalTokens,
    lastTurnTokens: asNumber(usage?.last) ?? asNumber(usage?.lastTurnTokens) ?? null,
    modelContextWindow: asNumber(usage?.modelContextWindow) ?? null
  };
}

export function mapAppServerRequest(threadId: string, request: JsonRpcRequest): AppServerRequestMapping {
  const params = asObject(request.params);
  const routeTurnId = asString(asObject(params?.turn)?.id) ?? asString(params?.turnId) ?? null;
  const itemId = asString(asObject(params?.item)?.id) ?? asString(params?.itemId) ?? null;
  const requestId = asString(params?.requestId) ?? randomUUID();
  const requestType = toCanonicalRequestType(request.method);

  if (requestType === 'tool_user_input') {
    const questionsJson = extractQuestions(params);
    const pending = {
      requestId,
      turnId: routeTurnId,
      itemId,
      jsonRpcId: request.id,
      questions: questionsJson
    };
    return {
      kind: 'user-input',
      pending,
      event: {
        ...providerEventBase(threadId),
        turnId: routeTurnId ?? undefined,
        itemId: itemId ?? undefined,
        requestId,
        type: 'user-input.requested',
        payload: {
          questions: parseQuestions(questionsJson)
        }
      }
    };
  }

  const detail = approvalDetailSummary(requestType);
  const pending = {
    requestId,
    turnId: routeTurnId,
    itemId,
    jsonRpcId: request.id,
    requestType,
    detail
  };

  return {
    kind: 'approval',
    pending,
    event: {
      ...providerEventBase(threadId),
      turnId: routeTurnId ?? undefined,
      itemId: itemId ?? undefined,
      requestId,
      type: 'request.opened',
      payload: {
        requestType,
        ...(detail ? { detail } : {}),
        parameterKeys: Object.keys(params ?? {}).slice(0, 16),
        parameterSummary: redactedParamsSummary(request.params)
      }
    }
  };
}

export function mapAppServerNotification(threadId: string, notification: JsonRpcNotification): AppServerNotificationMapping | null {
  const params = asObject(notification.params);
  const turn = asObject(params?.turn);
  const turnId = asString(turn?.id) ?? asString(params?.turnId);
  const item = asObject(params?.item);
  const itemId = asString(item?.id) ?? asString(params?.itemId);

  switch (notification.method) {
    case 'thread/tokenUsage/updated': {
      const tokenUsage = extractTokenUsage(params);
      if (!tokenUsage) {
        return null;
      }
      return {
        event: {
          ...providerEventBase(threadId),
          turnId,
          type: 'thread.token-usage.updated',
          payload: tokenUsage
        }
      };
    }
    case 'thread/started': {
      const providerThreadId = asString(asObject(params?.thread)?.id) ?? asString(params?.threadId);
      if (!providerThreadId) {
        return null;
      }
      return {
        sessionPatch: {
          resumeCursor: { threadId: providerThreadId },
          updatedAt: nowIso()
        },
        event: {
          ...providerEventBase(threadId),
          type: 'thread.started',
          payload: { providerThreadId }
        }
      };
    }
    case 'turn/started': {
      return {
        sessionPatch: {
          status: 'running',
          activeTurnId: turnId,
          updatedAt: nowIso()
        },
        event: {
          ...providerEventBase(threadId),
          turnId,
          type: 'turn.started',
          payload: {
            ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
            ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {})
          }
        }
      };
    }
    case 'turn/completed': {
      const status = asString(turn?.status);
      const errorMessage = asString(asObject(turn?.error)?.message);
      return {
        sessionPatch: {
          status: status === 'failed' ? 'error' : 'ready',
          activeTurnId: undefined,
          updatedAt: nowIso(),
          ...(errorMessage ? { lastError: errorMessage } : {})
        },
        event: {
          ...providerEventBase(threadId),
          turnId,
          type: 'turn.completed',
          payload: {
            state:
              status === 'failed'
                ? 'failed'
                : status === 'interrupted'
                  ? 'interrupted'
                  : status === 'cancelled'
                    ? 'cancelled'
                    : 'completed',
            ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
            ...(errorMessage ? { errorMessage } : {})
          }
        }
      };
    }
    case 'item/agentMessage/delta': {
      const delta = asString(params?.delta);
      if (!delta) {
        return null;
      }
      return {
        event: {
          ...providerEventBase(threadId),
          turnId,
          itemId,
          type: 'content.delta',
          payload: {
            streamKind: 'assistant_text',
            delta
          }
        }
      };
    }
    case 'item/started':
    case 'item/completed': {
      const itemType = normalizeItemType(item?.type ?? params?.itemType);
      const localPath = extractLocalImagePath(itemType, item, params);
      const phase = normalizeMessagePhase(item?.phase ?? params?.phase);
      const detail =
        itemType === 'assistant_message'
          ? asString(item?.message) ?? asString(item?.text) ?? asString(item?.summary) ?? asString(params?.message)
          : asString(item?.summary);
      return {
        event: {
          ...providerEventBase(threadId),
          turnId,
          itemId,
          type: notification.method === 'item/started' ? 'item.started' : 'item.completed',
          payload: {
            itemType,
            ...(asString(item?.title) ? { title: asString(item?.title) } : {}),
            ...(detail ? { detail } : {}),
            ...(asString(item?.status) ? { status: asString(item?.status) } : {}),
            ...(localPath ? { localPath } : {}),
            ...(phase ? { phase } : {})
          }
        }
      };
    }
    case 'thread/archived':
    case 'thread/closed':
    case 'thread/compacted': {
      return {
        event: {
          ...providerEventBase(threadId),
          type: 'thread.state.changed',
          payload: {
            state:
              notification.method === 'thread/archived'
                ? 'archived'
                : notification.method === 'thread/closed'
                  ? 'closed'
                  : 'compacted',
            detail: {
              method: notification.method,
              parameterKeys: Object.keys(params ?? {}).slice(0, 16)
            }
          }
        }
      };
    }
    case 'error': {
      const message = asString(asObject(params?.error)?.message) ?? 'codex runtime error';
      return {
        event: {
          ...providerEventBase(threadId),
          turnId,
          itemId,
          type: 'runtime.error',
          payload: {
            message,
            detail: {
              method: notification.method,
              parameterKeys: Object.keys(params ?? {}).slice(0, 16),
              summary: redactedParamsSummary(notification.params)
            }
          }
        }
      };
    }
    default:
      return null;
  }
}
