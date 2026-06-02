import { randomUUID } from 'node:crypto';
import manifest from './manifest.json' with { type: 'json' };

const VALID_RUNTIME_MODES = new Set(['full-access', 'approval-required']);
const MISSION_PREFIX = 'missions/';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value) {
  return Array.isArray(value) ? value.map((entry) => trimString(entry)).filter(Boolean) : [];
}

function stringOption(input, key) {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'mission';
}

function missionKey(missionId) {
  return `${MISSION_PREFIX}${missionId}`;
}

function missionJobId(missionId) {
  return `mission:${missionId}`;
}

function defaultRuntimeMode(context, requestedMode) {
  return VALID_RUNTIME_MODES.has(requestedMode) ? requestedMode : context.config?.defaults?.runtimeMode ?? 'approval-required';
}

function discordAction(id, title, commandName, commandDescription, subcommandName, subcommandDescription, options, policy) {
  return {
    id,
    title,
    description: subcommandDescription ?? commandDescription,
    ...(policy ? { policy } : {}),
    metadata: {
      discordCommand: {
        commandName,
        commandDescription,
        ...(subcommandName ? { subcommandName } : {}),
        ...(subcommandDescription ? { subcommandDescription } : {}),
        ...(options ? { options } : {})
      }
    }
  };
}

function toRuntimeReply(payload) {
  const blocks = (payload.embeds ?? []).map((embed) => ({
    kind: 'fields',
    ...(embed.title ? { title: embed.title } : {}),
    ...(embed.fields
      ? {
          fields: embed.fields.map((field) => ({
            label: field.name,
            value: field.value,
            ...(field.inline !== undefined ? { inline: field.inline } : {})
          }))
        }
      : {})
  }));
  return {
    ...(payload.content ? { text: payload.content } : {}),
    ...(blocks.length > 0 ? { blocks } : {})
  };
}

async function reply(event, payload) {
  const native = event.native?.payload;
  if (native && typeof native === 'object' && typeof native.reply === 'function') {
    await native.reply(payload);
    return { handled: true };
  }
  return { handled: true, reply: toRuntimeReply(payload) };
}

function jobForMission(context, missionId) {
  return context.listPackageJobs().find((job) => job.jobId === missionJobId(missionId)) ?? null;
}

function hydrateMission(context, mission) {
  if (!mission) return null;
  const job = jobForMission(context, mission.missionId);
  return {
    ...mission,
    nextRunAt: job?.nextRunAt ?? mission.nextRunAt ?? null
  };
}

function listMissions(context) {
  return context
    .listPackageState(MISSION_PREFIX)
    .map((record) => record.value)
    .filter((value) => value && typeof value === 'object')
    .map((mission) => hydrateMission(context, mission))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function getMissionById(context, missionId) {
  const id = trimString(missionId);
  return id ? hydrateMission(context, context.getPackageState(missionKey(id))) : null;
}

function getMissionBySpaceId(context, transportResourceId) {
  const id = trimString(transportResourceId);
  return id ? listMissions(context).find((mission) => mission.transportResourceId === id) ?? null : null;
}

function resolveMission(context, input, fallbackSpaceId) {
  return getMissionById(context, input?.missionId ?? input?.mission_id) ?? getMissionBySpaceId(context, input?.transportResourceId ?? input?.transport_resource_id ?? fallbackSpaceId);
}

async function saveMission(context, mission) {
  await context.putPackageState(missionKey(mission.missionId), {
    ...mission,
    updatedAt: context.nowIso()
  });
}

function buildRunInstruction(mission, trigger) {
  return [
    `Mission: ${mission.title}`,
    '',
    `Goal: ${mission.goal}`,
    '',
    `Schedule: ${mission.scheduleText}`,
    `Trigger: ${trigger}`,
    '',
    'Run one focused pass toward the mission goal. Report what changed, what remains, and whether the next scheduled pass needs adjustment.'
  ].join('\n');
}

async function runMission(context, mission, trigger) {
  if (!mission) return null;
  if (mission.status !== 'active') return mission;
  const session = context.getSessionById(mission.sessionId);
  if (!session || session.lifecycleStatus === 'archived') {
    await context.cancelPackageJob(missionJobId(mission.missionId));
    const archived = {
      ...mission,
      status: 'archived',
      lastError: session ? 'Mission session is archived.' : 'Mission session no longer exists.'
    };
    await saveMission(context, archived);
    return archived;
  }
  try {
    await context.directSession({
      sessionId: mission.sessionId,
      instruction: buildRunInstruction(mission, trigger),
      reason: `Mission ${trigger}`
    });
    const updated = {
      ...mission,
      status: 'active',
      lastRunAt: context.nowIso(),
      lastError: null
    };
    await saveMission(context, updated);
    context.appendAuditEvent('mission.run', {
      missionId: mission.missionId,
      sessionId: mission.sessionId,
      trigger,
      pluginId: manifest.id
    });
    return hydrateMission(context, updated);
  } catch (error) {
    const failed = {
      ...mission,
      lastError: error instanceof Error ? error.message : String(error)
    };
    await saveMission(context, failed);
    throw error;
  }
}

async function createMission(context, input) {
  const title = trimString(input.title);
  const goal = trimString(input.goal);
  const schedule = trimString(input.schedule);
  if (!title || !goal || !schedule) {
    throw new Error('title, goal, and schedule are required.');
  }
  const runtimeMode = defaultRuntimeMode(context, trimString(input.runtimeMode ?? input.runtime_mode));
  const missionId = `mission-${slugify(title)}-${randomUUID().slice(0, 8)}`;
  const createdAt = context.nowIso();
  const job = await context.schedulePackageJob({
    jobId: missionJobId(missionId),
    actionId: 'mission.run-scheduled',
    schedule,
    startTime: trimString(input.startTime ?? input.start_time) || undefined,
    payload: { missionId }
  });
  try {
    const created = await context.createSession({
      requestedName: title,
      runtimeMode,
      objective: goal,
      owner: { kind: 'package:official/missions.mission', id: missionId, label: title },
      tags: ['mission']
    });
    const mission = {
      missionId,
      title,
      goal,
      scheduleText: job.schedule,
      scheduleAnchorAt: job.scheduleAnchorAt,
      nextRunAt: job.nextRunAt,
      runtimeMode,
      sessionId: created.session.sessionId,
      transportResourceId: created.transportResourceId,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
      lastRunAt: null,
      lastError: null
    };
    await saveMission(context, mission);
    context.appendAuditEvent('mission.created', {
      missionId,
      sessionId: created.session.sessionId,
      transportResourceId: created.transportResourceId,
      pluginId: manifest.id
    });
    return { mission: hydrateMission(context, mission), transportResourceId: created.transportResourceId };
  } catch (error) {
    await context.cancelPackageJob(missionJobId(missionId));
    throw error;
  }
}

async function pauseMission(context, mission) {
  if (!mission) return null;
  await context.cancelPackageJob(missionJobId(mission.missionId));
  const updated = { ...mission, status: 'paused', pausedAt: context.nowIso(), nextRunAt: null };
  await saveMission(context, updated);
  return updated;
}

async function resumeMission(context, mission) {
  if (!mission) return null;
  const job = await context.schedulePackageJob({
    jobId: missionJobId(mission.missionId),
    actionId: 'mission.run-scheduled',
    schedule: mission.scheduleText,
    startTime: mission.scheduleAnchorAt,
    payload: { missionId: mission.missionId }
  });
  const updated = { ...mission, status: 'active', pausedAt: null, stoppedAt: null, nextRunAt: job.nextRunAt };
  await saveMission(context, updated);
  return updated;
}

async function stopMission(context, mission) {
  if (!mission) return null;
  await context.cancelPackageJob(missionJobId(mission.missionId));
  const updated = { ...mission, status: 'stopped', stoppedAt: context.nowIso(), nextRunAt: null };
  await saveMission(context, updated);
  return updated;
}

function missionStateLabel(mission) {
  return mission.status;
}

function summarizeMissions(missions) {
  if (missions.length === 0) return 'No missions yet.';
  return missions.map((mission) => `- ${mission.missionId} (${missionStateLabel(mission)}) | ${mission.scheduleText} | ${mission.title}`).join('\n');
}

function formatMission(mission) {
  const fields = [
    `missionId=${mission.missionId}`,
    `sessionId=${mission.sessionId}`,
    `transportResourceId=${mission.transportResourceId}`,
    `state=${missionStateLabel(mission)}`,
    `mode=${mission.runtimeMode}`,
    `schedule=${mission.scheduleText}`,
    `nextRunAt=${mission.nextRunAt ?? 'none'}`
  ];
  if (mission.goal) fields.push(`goal=${mission.goal}`);
  if (mission.lastRunAt) fields.push(`lastRunAt=${mission.lastRunAt}`);
  if (mission.lastError) fields.push(`lastError=${mission.lastError}`);
  return `- ${fields.join(' | ')}`;
}

function buildMissionListEmbed(missions) {
  const active = missions.filter((mission) => mission.status === 'active').length;
  const paused = missions.filter((mission) => mission.status === 'paused').length;
  const stopped = missions.filter((mission) => mission.status === 'stopped').length;
  const archived = missions.filter((mission) => mission.status === 'archived').length;
  return {
    title: 'Moorline Missions',
    color: 0x1abc9c,
    fields: [
      { name: 'Active', value: String(active), inline: true },
      { name: 'Paused', value: String(paused), inline: true },
      { name: 'Stopped', value: String(stopped), inline: true },
      { name: 'Archived', value: String(archived), inline: true },
      { name: 'Mission Summary', value: summarizeMissions(missions).slice(0, 1024) || 'No missions yet.' }
    ],
    timestamp: new Date().toISOString()
  };
}

function buildMissionStatusEmbed(mission) {
  return {
    title: `Mission ${mission.title}`,
    color: mission.status === 'active' ? 0x2ecc71 : mission.status === 'stopped' ? 0xe74c3c : 0x1abc9c,
    fields: [
      { name: 'Mission ID', value: mission.missionId },
      { name: 'Session ID', value: mission.sessionId, inline: true },
      { name: 'State', value: missionStateLabel(mission), inline: true },
      { name: 'Schedule', value: mission.scheduleText, inline: true },
      { name: 'Start Time', value: mission.scheduleAnchorAt, inline: true },
      { name: 'Next Run', value: mission.nextRunAt ?? 'not scheduled', inline: true },
      { name: 'Last Run', value: mission.lastRunAt ?? 'no runs yet', inline: true },
      { name: 'Goal', value: mission.goal.slice(0, 1024) },
      ...(mission.lastError ? [{ name: 'Last Error', value: mission.lastError.slice(0, 1024) }] : [])
    ],
    timestamp: new Date().toISOString()
  };
}

function actionDefinitions() {
  return [
    discordAction(
      'mission.create',
      'Create a scheduled mission',
      'mission',
      'Manage Moorline missions',
      'create',
      'Create a scheduled mission',
      [
        { type: 'string', name: 'title', description: 'Short mission title', required: true },
        { type: 'string', name: 'goal', description: 'Mission goal and expected work', required: true },
        {
          type: 'string',
          name: 'schedule',
          description: 'Schedule like every hour, every 2 hours, every 15 minutes, or daily',
          required: true
        },
        { type: 'string', name: 'start_time', description: 'Optional start time or anchor' },
        {
          type: 'string',
          name: 'mode',
          description: 'Runtime mode',
          choices: [
            { name: 'full-access', value: 'full-access' },
            { name: 'approval-required', value: 'approval-required' }
          ]
        }
      ]
    ),
    discordAction('mission.pause', 'Pause a mission', 'mission', 'Manage Moorline missions', 'pause', 'Pause a mission', [
      { type: 'string', name: 'mission_id', description: 'Pause a specific mission id' }
    ]),
    discordAction('mission.resume', 'Resume a mission', 'mission', 'Manage Moorline missions', 'resume', 'Resume a paused mission', [
      { type: 'string', name: 'mission_id', description: 'Resume a specific mission id' }
    ]),
    discordAction(
      'mission.stop',
      'Stop a mission',
      'mission',
      'Manage Moorline missions',
      'stop',
      'Stop a mission permanently',
      [{ type: 'string', name: 'mission_id', description: 'Stop a specific mission id' }],
      { allowedWhileDraining: true, bypassQueue: true }
    ),
    discordAction('mission.status', 'Show mission status', 'mission', 'Manage Moorline missions', 'status', 'Show mission status', [
      { type: 'string', name: 'mission_id', description: 'Show a specific mission id' }
    ]),
    discordAction('mission.list', 'List missions', 'mission', 'Manage Moorline missions', 'list', 'List all missions'),
    discordAction('mission.run-now', 'Run a mission now', 'mission', 'Manage Moorline missions', 'run-now', 'Trigger a mission immediately', [
      { type: 'string', name: 'mission_id', description: 'Run a specific mission id' }
    ]),
    {
      id: 'mission.run-scheduled',
      title: 'Run scheduled mission',
      description: 'Internal package job action for scheduled mission execution.',
      policy: { allowedWhileDraining: true, bypassQueue: true }
    }
  ];
}

export default {
  id: manifest.id,
  manifest,
  actions: actionDefinitions,
  tools(context) {
    return [
      {
        name: 'query_missions',
        description:
          'List long-lived missions. Missions are package-owned scheduled objectives implemented as durable sessions.',
        inputSchema: {
          type: 'object',
          properties: {
            statuses: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional mission state filter such as active, paused, stopped, or archived.'
            },
            limit: { type: 'number', description: 'Maximum number of missions to return.' }
          },
          additionalProperties: false
        },
        requiredCapability: 'package.state.read',
        execute: async (input) => {
          const statuses = new Set(stringList(input.statuses));
          const limit = typeof input.limit === 'number' ? input.limit : undefined;
          const missions = listMissions(context)
            .filter((mission) => statuses.size === 0 || statuses.has(mission.status))
            .slice(0, limit ?? Number.MAX_SAFE_INTEGER);
          if (missions.length === 0) {
            return { content: 'No missions matched the requested filters.' };
          }
          return { content: ['Missions:', ...missions.map(formatMission)].join('\n') };
        }
      },
      {
        name: 'create_mission',
        description:
          'Create a scheduled long-lived mission. Use this for recurring or durable objectives that should wake up on a cadence.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short mission title.' },
            goal: { type: 'string', description: 'Long-lived objective and expected behavior across repeated runs.' },
            schedule: { type: 'string', description: 'Cadence like every hour, every 2 hours, every 15 minutes, or daily.' },
            start_time: {
              type: 'string',
              description: 'Optional anchor like 09:00, 2026-03-25 09:00, or 2026-03-25T09:00:00-04:00.'
            },
            runtime_mode: { type: 'string', description: 'Runtime mode for the mission session.' },
            run_immediately: { type: 'boolean', description: 'When true, trigger the first mission pass now.' }
          },
          required: ['title', 'goal', 'schedule'],
          additionalProperties: false
        },
        requiredCapability: 'package.job.manage',
        execute: async (input) => {
          try {
            const created = await createMission(context, input);
            const lines = [
              `Created mission ${created.mission.missionId}.`,
              `Session: ${created.mission.sessionId}`,
              `Resource: ${created.transportResourceId}`,
              `Mode: ${created.mission.runtimeMode}`,
              `Schedule: ${created.mission.scheduleText}`,
              `Goal: ${created.mission.goal}`
            ];
            if (input.run_immediately === true) {
              const launched = await runMission(context, created.mission, 'manual');
              lines.push(launched ? `Triggered mission ${launched.missionId} immediately.` : 'Mission was created but could not be triggered immediately.');
            }
            return { content: lines.join('\n') };
          } catch (error) {
            return { content: `create_mission error: ${error instanceof Error ? error.message : String(error)}` };
          }
        }
      },
      {
        name: 'control_mission',
        description: 'Pause, resume, stop, or manually trigger a mission.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'Required mission action: pause, resume, stop, or run_now.' },
            mission_id: { type: 'string', description: 'Preferred unique target mission id.' },
            transport_resource_id: { type: 'string', description: 'Alternate target by mission session transport resource id.' }
          },
          required: ['action'],
          additionalProperties: false
        },
        requiredCapability: 'package.job.manage',
        execute: async (input) => {
          const action = trimString(input.action);
          const mission = resolveMission(context, input);
          if (!mission) {
            return { content: 'No matching mission found.' };
          }
          const updated =
            action === 'pause'
              ? await pauseMission(context, mission)
              : action === 'resume'
                ? await resumeMission(context, mission)
                : action === 'stop'
                  ? await stopMission(context, mission)
                  : action === 'run_now'
                    ? await runMission(context, mission, 'manual')
                    : null;
          if (!updated) {
            return { content: 'control_mission error: action must be one of pause, resume, stop, or run_now.' };
          }
          return { content: `${action} applied to mission ${updated.missionId}.` };
        }
      }
    ];
  },
  async beforeAgentPrompt() {
    return [
      'You can manage missions with package tools when the operator asks for recurring, scheduled, or ongoing objectives.',
      'A mission is a package-owned durable session that wakes on a cadence and receives a focused follow-up instruction each run.',
      'Use create_mission for recurring or durable work; use query_missions before creating duplicates; use control_mission to pause, resume, stop, or manually run a mission.',
      'For one-time parallel work, prefer managed session tools from the session orchestration package instead of missions.'
    ];
  },
  async onAction(event, context) {
    if (!event.actionId.startsWith('mission.')) {
      return { handled: false };
    }

    if (event.actionId === 'mission.run-scheduled') {
      const mission = getMissionById(context, stringOption(event.input, 'missionId'));
      await runMission(context, mission, 'scheduled');
      return { handled: true };
    }

    if (event.actionId === 'mission.create') {
      try {
        const created = await createMission(context, {
          title: stringOption(event.input, 'title'),
          goal: stringOption(event.input, 'goal'),
          schedule: stringOption(event.input, 'schedule'),
          startTime: stringOption(event.input, 'start_time'),
          runtimeMode: stringOption(event.input, 'mode')
        });
        await context.sendMessage(created.transportResourceId, {
          text: `Mission ${created.mission.missionId} is scheduled.`,
          blocks: [
            {
              kind: 'fields',
              title: `Mission ${created.mission.title}`,
              tone: 'success',
              fields: buildMissionStatusEmbed(created.mission).fields.map((field) => ({
                label: field.name,
                value: field.value,
                ...(field.inline !== undefined ? { inline: field.inline } : {})
              }))
            }
          ]
        });
        return await reply(event, {
          content: `Created mission ${created.mission.missionId} in <#${created.transportResourceId}>.`,
          ephemeral: true
        });
      } catch (error) {
        return await reply(event, {
          content: error instanceof Error ? error.message : String(error),
          ephemeral: true
        });
      }
    }

    if (event.actionId === 'mission.pause' || event.actionId === 'mission.resume' || event.actionId === 'mission.stop') {
      const mission = resolveMission(context, { mission_id: stringOption(event.input, 'mission_id') }, event.transportResourceId);
      const verb = event.actionId.split('.').at(-1);
      const updated =
        verb === 'pause'
          ? await pauseMission(context, mission)
          : verb === 'resume'
            ? await resumeMission(context, mission)
            : await stopMission(context, mission);
      if (!updated) {
        return await reply(event, { content: 'No matching mission found.', ephemeral: true });
      }
      return await reply(event, { content: `${verb} applied to mission ${updated.missionId}.`, ephemeral: true });
    }

    if (event.actionId === 'mission.run-now') {
      try {
        const mission = resolveMission(context, { mission_id: stringOption(event.input, 'mission_id') }, event.transportResourceId);
        const updated = await runMission(context, mission, 'manual');
        return await reply(event, {
          content: updated ? `Triggered mission ${updated.missionId}.` : 'No matching mission found.',
          ephemeral: true
        });
      } catch (error) {
        return await reply(event, {
          content: error instanceof Error ? error.message : String(error),
          ephemeral: true
        });
      }
    }

    if (event.actionId === 'mission.status') {
      const mission = resolveMission(context, { mission_id: stringOption(event.input, 'mission_id') }, event.transportResourceId);
      if (!mission) {
        return await reply(event, { content: 'No matching mission found.', ephemeral: true });
      }
      return await reply(event, {
        content: `Mission ${mission.missionId}`,
        embeds: [buildMissionStatusEmbed(mission)],
        ephemeral: true
      });
    }

    if (event.actionId === 'mission.list') {
      return await reply(event, {
        content: 'Current Moorline missions',
        embeds: [buildMissionListEmbed(listMissions(context))],
        ephemeral: true
      });
    }

    return await reply(event, {
      content: `Unsupported mission action: ${event.actionId}`,
      ephemeral: true
    });
  }
};
