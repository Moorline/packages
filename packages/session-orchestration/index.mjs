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

function missionStateLabel(mission) {
  if (mission.archivedAt) return 'archived';
  return mission.pausedAt ? 'paused' : mission.lifecycleStatus;
}

function formatSnapshot(snapshot) {
  const { session, receipt, pendingRequests, recentActivities } = snapshot;
  const fields = [
    `sessionId=${session.sessionId}`,
    `spaceId=${session.spaceId}`,
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

function formatMission(mission, latestRun) {
  const fields = [
    `missionId=${mission.missionId}`,
    `spaceId=${mission.spaceId}`,
    `state=${missionStateLabel(mission)}`,
    `mode=${mission.runtimeMode}`,
    `schedule=${mission.scheduleText}`,
    `nextRunAt=${mission.nextRunAt ?? 'none'}`
  ];
  if (mission.goal) fields.push(`goal=${mission.goal}`);
  if (mission.lastError) fields.push(`lastError=${mission.lastError}`);
  if (latestRun) fields.push(`latestRun=${latestRun.lifecycleStatus}@${latestRun.startedAt}`);
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
          'List managed worker sessions. Sessions are bounded coding threads with their own workspace, mode, owner link, and optional kickoff objective.',
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
              description: 'Optional owner kind filter: mission, run, parent_session, or orchestrator.'
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
              description: 'Short human name for the worker. Used to derive the session space name.'
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
              description: 'Optional durable objective for supervision and querying. If omitted for mission-owned workers, the mission goal is inherited.'
            },
            owner_kind: {
              type: 'string',
              description: 'Optional owner kind override. Use mission, run, parent_session, or orchestrator when you need an explicit owner link.'
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
            spaceId: created.spaceId
          });
          return {
            content: [
              `Created managed session ${created.session.sessionId}.`,
              `Space: ${created.spaceId}`,
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
            space_id: { type: 'string', description: 'Alternate target by session space id.' },
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
            spaceId: trimString(input.space_id) || undefined,
            instruction,
            reason: trimString(input.reason) || undefined
          });
          context.appendAuditEvent('api.session.directed', {
            action: 'direct_session',
            target: result.session.sessionId,
            spaceId: result.session.spaceId
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
            space_id: {
              type: 'string',
              description: 'Optional alternate transport space target. Defaults to the current space.'
            }
          },
          required: ['path'],
          additionalProperties: false
        },
        requiredCapability: 'transport.message.send',
        execute: async (input) => {
          const realPath = resolveWorkspaceFile(context.getCurrentWorkspacePath(), input.path);
          const spaceId = trimString(input.space_id) || context.getCurrentSpaceId();
          await context.sendMessage(spaceId, {
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
            target: spaceId,
            file: basename(realPath)
          });
          return {
            content: [
              `Attached workspace file ${basename(realPath)} to the current surface.`,
              `Space: ${spaceId}`,
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
            space_id: { type: 'string', description: 'Alternate target by session space id.' }
          },
          additionalProperties: false
        },
        requiredCapability: 'session.archive',
        execute: async (input) => {
          const spaceId = trimString(input.space_id) || context.getSessionById(trimString(input.session_id) || '')?.spaceId;
          if (!spaceId) {
            return { content: 'archive_managed_session error: session_id or space_id is required.' };
          }
          const archived = await context.archiveSession({
            spaceId,
            sessionId: trimString(input.session_id) || undefined
          });
          if (archived) {
            context.appendAuditEvent('api.session.archived', {
              action: 'archive_managed_session',
              target: archived.sessionId,
              spaceId: archived.spaceId
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
            space_id: { type: 'string', description: 'Alternate target by session space id.' }
          },
          additionalProperties: false
        },
        requiredCapability: 'session.delete',
        execute: async (input) => {
          const spaceId = trimString(input.space_id) || context.getSessionById(trimString(input.session_id) || '')?.spaceId;
          if (!spaceId) {
            return { content: 'delete_managed_session error: session_id or space_id is required.' };
          }
          const deleted = await context.deleteArchivedSession({
            spaceId,
            sessionId: trimString(input.session_id) || undefined
          });
          if (deleted) {
            context.appendAuditEvent('api.session.deleted', {
              action: 'delete_managed_session',
              target: deleted.sessionId,
              spaceId: deleted.spaceId
            });
          }
          return deleted
            ? { content: `Deleted archived session ${deleted.sessionId} and removed its local workspace (${workspaceDisplay(deleted.sessionId)}).` }
            : { content: 'No matching archived session found.' };
        }
      },
      {
        name: 'query_missions',
        description:
          'List long-lived missions. Missions are scheduled objectives that wake up on a cadence and can spawn or direct worker sessions over time.',
        inputSchema: {
          type: 'object',
          properties: {
            lifecycle_statuses: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional mission state filter such as active, sleeping, waiting_on_user, failed, stopped, paused, or archived.'
            },
            limit: { type: 'number', description: 'Maximum number of missions to return.' }
          },
          additionalProperties: false
        },
        requiredCapability: 'mission.inspect',
        execute: async (input) => {
          const lifecycleStatuses = new Set(stringList(input.lifecycle_statuses));
          const limit = typeof input.limit === 'number' ? input.limit : undefined;
          const missions = context
            .listMissions()
            .filter((mission) =>
              lifecycleStatuses.size === 0 ||
              lifecycleStatuses.has(missionStateLabel(mission))
            )
            .slice(0, limit ?? Number.MAX_SAFE_INTEGER);
          if (missions.length === 0) {
            return { content: 'No missions matched the requested filters.' };
          }
          return {
            content: [
              'Missions:',
              ...missions.map((mission) => formatMission(mission, context.listMissionRuns(mission.missionId, 1)[0]))
            ].join('\n')
          };
        }
      },
      {
        name: 'create_mission',
        description:
          'Create a scheduled long-lived mission. Use this for recurring or durable objectives, not one-off delegated coding passes. Set run_immediately to kick off the first mission pass now.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short mission title.' },
            goal: { type: 'string', description: 'Long-lived objective and expected behavior across repeated runs.' },
            schedule: {
              type: 'string',
              description: 'Cadence like every hour, every 2 hours, every 15 minutes, or daily.'
            },
            start_time: {
              type: 'string',
              description: 'Optional anchor like 09:00, 2026-03-25 09:00, or 2026-03-25T09:00:00-04:00.'
            },
            runtime_mode: {
              type: 'string',
              description: 'Runtime mode for mission runs, usually full-access or approval-required.'
            },
            run_immediately: {
              type: 'boolean',
              description: 'When true, trigger the first mission run immediately after creation.'
            }
          },
          required: ['title', 'goal', 'schedule', 'runtime_mode'],
          additionalProperties: false
        },
        requiredCapability: 'mission.create',
        execute: async (input) => {
          const title = trimString(input.title);
          const goal = trimString(input.goal);
          const schedule = trimString(input.schedule);
          if (!title || !goal || !schedule) {
            return { content: 'create_mission error: title, goal, schedule, and runtime_mode are required.' };
          }
          let runtimeMode;
          try {
            runtimeMode = parseRuntimeMode(input.runtime_mode, 'create_mission');
          } catch (error) {
            return { content: error instanceof Error ? error.message : String(error) };
          }
          const created = await context.createMission({
            title,
            goal,
            schedule,
            startTime: trimString(input.start_time) || undefined,
            runtimeMode
          });
          context.appendAuditEvent('api.mission.created', {
            action: 'create_mission',
            target: created.mission.missionId,
            spaceId: created.spaceId
          });
          const lines = [
            `Created mission ${created.mission.missionId}.`,
            `Space: ${created.spaceId}`,
            `Mode: ${created.mission.runtimeMode}`,
            `Schedule: ${created.mission.scheduleText}`,
            `Goal: ${created.mission.goal}`
          ];
          if (input.run_immediately === true) {
            const launched = await context.runMissionNow({
              spaceId: created.spaceId,
              missionId: created.mission.missionId
            });
            if (launched) {
              context.appendAuditEvent('api.mission.run_now', {
                action: 'create_mission',
                target: launched.missionId,
                spaceId: created.spaceId
              });
            }
            lines.push(launched ? `Triggered mission ${launched.missionId} immediately.` : 'Mission was created but could not be triggered immediately.');
          }
          return { content: lines.join('\n') };
        }
      },
      {
        name: 'control_mission',
        description: 'Pause, resume, stop, or manually trigger a mission.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'Required mission action: pause, resume, stop, or run_now.'
            },
            mission_id: { type: 'string', description: 'Preferred unique target mission id.' },
            space_id: { type: 'string', description: 'Alternate target by mission space id.' }
          },
          required: ['action'],
          additionalProperties: false
        },
        requiredCapability: 'mission.control',
        execute: async (input) => {
          const action = trimString(input.action);
          const spaceId = trimString(input.space_id) || context.getMissionById(trimString(input.mission_id) || '')?.spaceId;
          if (!spaceId) {
            return { content: 'control_mission error: mission_id or space_id is required.' };
          }
          const missionId = trimString(input.mission_id) || undefined;
          const mission =
            action === 'pause'
              ? await context.pauseMission({ spaceId, missionId })
              : action === 'resume'
                ? await context.resumeMission({ spaceId, missionId })
                : action === 'stop'
                  ? await context.stopMission({ spaceId, missionId })
                  : action === 'run_now'
                    ? await context.runMissionNow({ spaceId, missionId })
                    : null;
          if (!mission && !['pause', 'resume', 'stop', 'run_now'].includes(action)) {
            return { content: 'control_mission error: action must be one of pause, resume, stop, or run_now.' };
          }
          if (mission) {
            context.appendAuditEvent('api.mission.controlled', {
              action: 'control_mission',
              target: mission.missionId,
              control: action,
              spaceId
            });
          }
          return { content: mission ? `${action} applied to mission ${mission.missionId}.` : 'No matching mission found.' };
        }
      }
    ];
  },
  async beforeAgentPrompt() {
    return [
      'You can manage two different orchestration primitives with tools: managed sessions and missions.',
      'A managed session is a bounded worker thread with its own workspace. Use it for one-off delegated implementation, review, investigation, or follow-up work.',
      'A mission is a long-lived scheduled objective. Use it for recurring or durable work that should wake up on a cadence, such as periodic triage, monitoring, or repeated review passes.',
      'When the operator asks for a recurring, scheduled, or ongoing objective, prefer create_mission. When they ask for a one-time parallel worker or focused child thread, prefer create_managed_session.',
      'For managed sessions, requested_name sets the session label, runtime_mode controls execution permissions, initial_instruction can kick off the first turn immediately, and objective is durable supervision metadata.',
      'For missions, title is the short label, goal is the durable long-lived objective, schedule is the cadence text, start_time optionally anchors the schedule, runtime_mode controls mission-run permissions, and run_immediately starts the first pass now.',
      'Mission-owned worker sessions automatically inherit mission ownership and, by default, the mission goal as their objective when you create them from a mission context.',
      'Use query_sessions and query_missions to inspect current state before creating duplicates or when you need to supervise or redirect ongoing work.',
      'When the operator wants a real Discord attachment for an existing workspace artifact, use send_workspace_file instead of pasting the file contents inline.'
    ];
  }
};
