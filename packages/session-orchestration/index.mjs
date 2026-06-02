import manifest from './manifest.json' with { type: 'json' };
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const DISCORD_FILE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const VALID_RUNTIME_MODES = new Set(['full-access', 'approval-required']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value) {
  return Array.isArray(value) ? value.map((entry) => trimString(entry)).filter(Boolean) : [];
}

function parseRuntimeMode(value, toolName) {
  const runtimeMode = trimString(value);
  if (!runtimeMode) {
    throw new Error(`${toolName} error: runtime_mode is required.`);
  }
  if (!VALID_RUNTIME_MODES.has(runtimeMode)) {
    throw new Error(
      `${toolName} error: runtime_mode must be one of ${Array.from(VALID_RUNTIME_MODES).join(', ')}.`
    );
  }
  return runtimeMode;
}

function formatSnapshot(snapshot) {
  const { session, receipt, pendingRequests, recentActivities } = snapshot;
  const fields = [
    `sessionId=${session.sessionId}`,
    `transportResourceId=${session.transportResourceId}`,
    `lifecycle=${session.lifecycleStatus}`,
    `mode=${session.runtimeMode}`,
    `provider=${session.providerStatus}`,
    `wait=${receipt?.state ?? 'idle'}`,
    `lastActivityAt=${session.lastActivityAt}`
  ];
  if (session.ownerKind && session.ownerId) fields.push(`owner=${session.ownerKind}:${session.ownerId}`);
  if (session.objective) fields.push(`objective=${session.objective}`);
  if ((session.tags ?? []).length > 0) fields.push(`tags=${session.tags.join(',')}`);
  if (session.summary) fields.push(`summary=${session.summary}`);
  if (session.lastDirectedAt) fields.push(`lastDirectedAt=${session.lastDirectedAt}`);
  if (session.lastDirectedBy) fields.push(`lastDirectedBy=${session.lastDirectedBy}`);
  if (pendingRequests.length > 0) fields.push(`openRequests=${pendingRequests.length}`);
  if (recentActivities.length > 0) {
    const latest = recentActivities[recentActivities.length - 1];
    fields.push(`latestActivity=${latest.kind}:${latest.title}`);
  }
  return `- ${fields.join(' | ')}`;
}

function summarizeReply(reply) {
  const lines = [];
  if (reply.content) lines.push(`Reply: ${reply.content}`);
  if ((reply.files ?? []).length > 0) lines.push(`Files: ${reply.files.length}`);
  if ((reply.embeds ?? []).length > 0) lines.push(`Embeds: ${reply.embeds.length}`);
  return lines.length > 0 ? lines.join('\n') : 'Reply delivered with no text payload.';
}

function resolveWorkspaceFile(workspacePath, inputPath) {
  const requestedPath = trimString(inputPath);
  if (!requestedPath) {
    throw new Error('path is required.');
  }
  const resolvedPath = resolve(workspacePath, requestedPath);
  const stats = statSync(resolvedPath, { throwIfNoEntry: false });
  if (!stats) {
    throw new Error(`Workspace file not found: ${requestedPath}`);
  }
  const canonicalWorkspace = realpathSync(workspacePath);
  const realPath = realpathSync(resolvedPath);
  const relativePath = relative(canonicalWorkspace, realPath);
  const escaped =
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\') ||
    isAbsolute(relativePath);
  if (escaped) {
    throw new Error(`Requested file must stay inside the current workspace: ${requestedPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Workspace path is not a file: ${requestedPath}`);
  }
  if (stats.size > DISCORD_FILE_UPLOAD_MAX_BYTES) {
    throw new Error(`Workspace file exceeds the 8 MiB Discord upload limit: ${requestedPath}`);
  }
  return realPath;
}

function workspaceDisplay(id) {
  return `runtime/workspaces/${id}`;
}

export default {
  id: manifest.id,
  manifest,
  tools(context) {
    return [
      {
        name: 'query_sessions',
        description:
          'List managed worker sessions. Sessions are bounded worker threads with their own workspace, mode, owner link, and optional kickoff objective.',
        inputSchema: {
          type: 'object',
          properties: {
            lifecycle_statuses: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional session lifecycle filter such as hot, cool, or archived.'
            },
            runtime_modes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional runtime mode filter such as full-access or approval-required.'
            },
            owner_kind: {
              type: 'string',
              description: 'Optional owner kind filter such as run, parent_session, or orchestrator.'
            },
            owner_id: {
              type: 'string',
              description: 'Optional exact owner id to pair with owner_kind.'
            },
            tag: { type: 'string', description: 'Optional single tag to match.' },
            objective_text: { type: 'string', description: 'Optional substring match against the session objective.' },
            wait_states: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional wait-state filter such as running, waiting_for_approval, or waiting_for_input.'
            },
            include_archived: { type: 'boolean', description: 'Include archived sessions when true.' },
            limit: { type: 'number', description: 'Maximum number of sessions to return.' }
          },
          additionalProperties: false
        },
        requiredCapability: 'session.inspect',
        execute: async (input) => {
          const sessions = context.querySessions({
            scope: 'managed_workers',
            lifecycleStatuses: stringList(input.lifecycle_statuses),
            runtimeModes: stringList(input.runtime_modes),
            ownerKind: trimString(input.owner_kind) || undefined,
            ownerId: trimString(input.owner_id) || undefined,
            tag: trimString(input.tag) || undefined,
            objectiveText: trimString(input.objective_text) || undefined,
            waitStates: stringList(input.wait_states),
            includeArchived: input.include_archived === true,
            limit: typeof input.limit === 'number' ? input.limit : undefined
          });
          if (sessions.length === 0) {
            return { content: 'No sessions matched the requested filters.' };
          }
          return { content: ['Managed sessions:', ...sessions.map((snapshot) => formatSnapshot(snapshot))].join('\n') };
        }
      },
      {
        name: 'create_managed_session',
        description:
          'Create a bounded worker session. Use this for one-off delegated work, parallel implementation threads, or supervised follow-up inside a dedicated workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            requested_name: {
              type: 'string',
              description: 'Short human name for the worker. Used to derive the session resource name.'
            },
            runtime_mode: {
              type: 'string',
              description: 'Runtime mode for the worker, usually full-access or approval-required.'
            },
            initial_instruction: {
              type: 'string',
              description: 'Optional kickoff instruction to run immediately after the session is created.'
            },
            objective: {
              type: 'string',
              description: 'Optional durable objective for supervision and querying.'
            },
            owner_kind: {
              type: 'string',
              description: 'Optional owner kind override. Use run, parent_session, or orchestrator when you need an explicit owner link.'
            },
            owner_id: {
              type: 'string',
              description: 'Optional owner id to pair with owner_kind.'
            },
            owner_label: {
              type: 'string',
              description: 'Optional display label for the owner link.'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional short tags for later querying, such as issue-40 or reviewer.'
            }
          },
          required: ['requested_name', 'runtime_mode'],
          additionalProperties: false
        },
        requiredCapability: 'session.create',
        execute: async (input) => {
          const requestedName = trimString(input.requested_name);
          if (!requestedName) {
            return { content: 'create_managed_session error: requested_name is required.' };
          }
          let runtimeMode;
          try {
            runtimeMode = parseRuntimeMode(input.runtime_mode, 'create_managed_session');
          } catch (error) {
            return { content: error instanceof Error ? error.message : String(error) };
          }
          const ownerKind = trimString(input.owner_kind);
          const ownerId = trimString(input.owner_id);
          const created = await context.createSession({
            requestedName,
            runtimeMode,
            initialInstruction: trimString(input.initial_instruction) || undefined,
            objective: trimString(input.objective) || undefined,
            owner: ownerKind && ownerId ? { kind: ownerKind, id: ownerId, label: trimString(input.owner_label) || undefined } : undefined,
            tags: stringList(input.tags)
          });
          context.appendAuditEvent('api.session.created', {
            action: 'create_managed_session',
            target: created.session.sessionId,
            transportResourceId: created.transportResourceId
          });
          return {
            content: [
              `Created managed session ${created.session.sessionId}.`,
              `Resource: ${created.transportResourceId}`,
              `Mode: ${created.session.runtimeMode}`,
              `Owner: ${created.session.ownerKind ?? 'none'}:${created.session.ownerId ?? 'none'}`,
              `Objective: ${created.session.objective ?? '(none)'}`,
              `Tags: ${(created.session.tags ?? []).join(', ') || '(none)'}`
            ].join('\n')
          };
        }
      },
      {
        name: 'direct_session',
        description:
          'Send a follow-up instruction into an existing managed session. Use this to refine, redirect, or request another bounded pass from a worker.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Preferred unique target session id.' },
            transport_resource_id: { type: 'string', description: 'Alternate target by session transport resource id.' },
            instruction: { type: 'string', description: 'Required follow-up instruction for the worker.' },
            reason: { type: 'string', description: 'Optional short supervisory reason, such as review feedback or retry after failure.' }
          },
          required: ['instruction'],
          additionalProperties: false
        },
        requiredCapability: 'session.direct',
        execute: async (input) => {
          const instruction = trimString(input.instruction);
          if (!instruction) {
            return { content: 'direct_session error: instruction is required.' };
          }
          const result = await context.directSession({
            sessionId: trimString(input.session_id) || undefined,
            transportResourceId: trimString(input.transport_resource_id) || undefined,
            instruction,
            reason: trimString(input.reason) || undefined
          });
          context.appendAuditEvent('api.session.directed', {
            action: 'direct_session',
            target: result.session.sessionId,
            transportResourceId: result.session.transportResourceId
          });
          return {
            content: [
              `Directed session ${result.session.sessionId}.`,
              summarizeReply(result.reply)
            ].join('\n')
          };
        }
      },
      {
        name: 'send_workspace_file',
        description:
          'Send an existing file from the current workspace as a real Discord attachment. Use this when the operator wants a report, markdown file, screenshot, or other artifact delivered as a file instead of pasted inline.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Required file path inside the current workspace. Relative paths are resolved from the active workspace.'
            },
            caption: {
              type: 'string',
              description: 'Optional message text to send with the attachment.'
            },
            name: {
              type: 'string',
              description: 'Optional override for the uploaded filename.'
            },
            description: {
              type: 'string',
              description: 'Optional attachment description.'
            },
            transport_resource_id: {
              type: 'string',
              description: 'Optional alternate transport resource target. Defaults to the current resource.'
            }
          },
          required: ['path'],
          additionalProperties: false
        },
        requiredCapability: 'transport.message.send',
        execute: async (input) => {
          const realPath = resolveWorkspaceFile(context.getCurrentWorkspacePath(), input.path);
          const transportResourceId = trimString(input.transport_resource_id) || context.getCurrentTransportResourceId();
          await context.sendMessage(transportResourceId, {
            ...(trimString(input.caption) ? { text: trimString(input.caption) } : {}),
            attachments: [
              {
                kind: 'file',
                path: realPath,
                name: trimString(input.name) || basename(realPath),
                ...(trimString(input.description) ? { description: trimString(input.description) } : {})
              }
            ]
          });
          context.appendAuditEvent('api.message.sent', {
            action: 'send_workspace_file',
            target: transportResourceId,
            file: basename(realPath)
          });
          return {
            content: [
              `Attached workspace file ${basename(realPath)} to the current surface.`,
              `Resource: ${transportResourceId}`,
              `Path: ${trimString(input.path) || basename(realPath)}`
            ].join('\n')
          };
        }
      },
      {
        name: 'archive_managed_session',
        description: 'Archive a managed session when its work is done or the worker should no longer accept new directions.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Preferred unique target session id.' },
            transport_resource_id: { type: 'string', description: 'Alternate target by session transport resource id.' }
          },
          additionalProperties: false
        },
        requiredCapability: 'session.archive',
        execute: async (input) => {
          const transportResourceId = trimString(input.transport_resource_id) || context.getSessionById(trimString(input.session_id) || '')?.transportResourceId;
          if (!transportResourceId) {
            return { content: 'archive_managed_session error: session_id or transport_resource_id is required.' };
          }
          const archived = await context.archiveSession({
            transportResourceId,
            sessionId: trimString(input.session_id) || undefined
          });
          if (archived) {
            context.appendAuditEvent('api.session.archived', {
              action: 'archive_managed_session',
              target: archived.sessionId,
              transportResourceId: archived.transportResourceId
            });
          }
          return { content: archived ? `Archived session ${archived.sessionId}.` : 'No matching session found.' };
        }
      },
      {
        name: 'delete_managed_session',
        description: 'Delete an archived managed session and remove its workspace. Only use this for cleanup after archival.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Preferred unique target session id.' },
            transport_resource_id: { type: 'string', description: 'Alternate target by session transport resource id.' }
          },
          additionalProperties: false
        },
        requiredCapability: 'session.delete',
        execute: async (input) => {
          const transportResourceId = trimString(input.transport_resource_id) || context.getSessionById(trimString(input.session_id) || '')?.transportResourceId;
          if (!transportResourceId) {
            return { content: 'delete_managed_session error: session_id or transport_resource_id is required.' };
          }
          const deleted = await context.deleteArchivedSession({
            transportResourceId,
            sessionId: trimString(input.session_id) || undefined
          });
          if (deleted) {
            context.appendAuditEvent('api.session.deleted', {
              action: 'delete_managed_session',
              target: deleted.sessionId,
              transportResourceId: deleted.transportResourceId
            });
          }
          return deleted
            ? { content: `Deleted archived session ${deleted.sessionId} and removed its local workspace (${workspaceDisplay(deleted.sessionId)}).` }
            : { content: 'No matching archived session found.' };
        }
      }
    ];
  },
  async beforeAgentPrompt() {
    return [
      'You can manage bounded worker sessions with tools.',
      'A managed session is a bounded worker thread with its own workspace. Use it for one-off delegated implementation, review, investigation, or follow-up work.',
      'When the operator asks for a one-time parallel worker or focused child thread, prefer create_managed_session.',
      'For managed sessions, requested_name sets the session label, runtime_mode controls execution permissions, initial_instruction can kick off the first turn immediately, and objective is durable supervision metadata.',
      'Use query_sessions to inspect current state before creating duplicates or when you need to supervise or redirect ongoing work.',
      'When the operator wants a real Discord attachment for an existing workspace artifact, use send_workspace_file instead of pasting the file contents inline.'
    ];
  }
};
