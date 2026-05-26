import manifest from './manifest.json' with { type: 'json' };

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

function stringOption(input, key) {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function reply(event, payload) {
  const native = event.native?.payload;
  if (native && typeof native === 'object' && typeof native.reply === 'function') {
    await native.reply(payload);
    return { handled: true };
  }
  return { handled: true, reply: { ...(payload.content ? { text: payload.content } : {}) } };
}

function missionStateLabel(mission) {
  if (mission.archivedAt) return 'archived';
  if (mission.pausedAt) return 'paused';
  return mission.lifecycleStatus;
}

function summarizeMissions(missions) {
  if (missions.length === 0) return 'No missions yet.';
  return missions.map((mission) => `- ${mission.missionId} (${missionStateLabel(mission)}) | ${mission.scheduleText} | ${mission.title}`).join('\n');
}

function pastTense(verb) {
  return verb === 'stop' ? 'stopped' : `${verb}d`;
}

function buildMissionListEmbed(missions) {
  const active = missions.filter((mission) => mission.lifecycleStatus === 'active').length;
  const waiting = missions.filter((mission) => mission.lifecycleStatus === 'waiting_on_user').length;
  const sleeping = missions.filter((mission) => mission.lifecycleStatus === 'sleeping' && !mission.pausedAt && !mission.archivedAt).length;
  const paused = missions.filter((mission) => mission.pausedAt).length;
  const archived = missions.filter((mission) => mission.archivedAt).length;
  return {
    title: 'Moorline Missions',
    color: 0x1abc9c,
    fields: [
      { name: 'Active', value: String(active), inline: true },
      { name: 'Waiting', value: String(waiting), inline: true },
      { name: 'Sleeping', value: String(sleeping), inline: true },
      { name: 'Paused', value: String(paused), inline: true },
      { name: 'Archived', value: String(archived), inline: true },
      { name: 'Mission Summary', value: summarizeMissions(missions).slice(0, 1024) || 'No missions yet.' }
    ],
    timestamp: new Date().toISOString()
  };
}

function buildMissionStatusEmbed(mission, runs) {
  const latestRun = runs[0] ?? null;
  return {
    title: `Mission ${mission.title}`,
    color: mission.lifecycleStatus === 'failed' ? 0xe74c3c : mission.lifecycleStatus === 'active' ? 0x2ecc71 : 0x1abc9c,
    fields: [
      { name: 'Mission ID', value: mission.missionId },
      { name: 'State', value: missionStateLabel(mission), inline: true },
      { name: 'Schedule', value: mission.scheduleText, inline: true },
      { name: 'Start Time', value: mission.scheduleAnchorAt, inline: true },
      { name: 'Next Run', value: mission.nextRunAt ?? 'not scheduled', inline: true },
      { name: 'Archived At', value: mission.archivedAt ?? 'not archived', inline: true },
      { name: 'Goal', value: mission.goal.slice(0, 1024) },
      { name: 'Latest Run', value: latestRun ? `${latestRun.lifecycleStatus} at ${latestRun.startedAt}` : 'No runs yet.' },
      ...(mission.lastError ? [{ name: 'Last Error', value: mission.lastError.slice(0, 1024) }] : [])
    ],
    timestamp: new Date().toISOString()
  };
}

export default {
  id: manifest.id,
  manifest,
  actions() {
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
      ])
    ];
  },
  async onAction(event, context) {
    if (!event.actionId.startsWith('mission.')) {
      return { handled: false };
    }

    if (event.actionId === 'mission.create') {
      const title = stringOption(event.input, 'title');
      const goal = stringOption(event.input, 'goal');
      const schedule = stringOption(event.input, 'schedule');
      const startTime = stringOption(event.input, 'start_time');
      if (!title || !goal || !schedule) {
        return await reply(event, { content: 'title, goal, and schedule are required.', ephemeral: true });
      }
      const requestedMode = stringOption(event.input, 'mode');
      const runtimeMode =
        requestedMode === 'full-access' || requestedMode === 'approval-required'
          ? requestedMode
          : context.config.defaults.runtimeMode;
      try {
        const created = await context.createMission({
          title,
          goal,
          schedule,
          ...(startTime ? { startTime } : {}),
          runtimeMode
        });
        const notificationErrors = [];
        try {
          await context.sendMessage(created.spaceId, {
            text: `Mission ${created.mission.missionId} is scheduled.`,
            blocks: [
              {
                kind: 'fields',
                title: `Mission ${created.mission.title}`,
                tone: 'success',
                fields: buildMissionStatusEmbed(created.mission, []).fields.map((field) => ({
                  label: field.name,
                  value: field.value,
                  ...(field.inline !== undefined ? { inline: field.inline } : {})
                }))
              }
            ]
          });
        } catch (error) {
          notificationErrors.push(error instanceof Error ? error.message : String(error));
        }
        try {
          await context.sendStatusUpdate({
            text: `Created mission ${created.mission.missionId} in ${created.spaceId}.`,
            blocks: [
              {
                kind: 'fields',
                title: `Mission ${created.mission.title}`,
                tone: 'success',
                fields: buildMissionStatusEmbed(created.mission, []).fields.map((field) => ({
                  label: field.name,
                  value: field.value,
                  ...(field.inline !== undefined ? { inline: field.inline } : {})
                }))
              }
            ]
          });
        } catch (error) {
          notificationErrors.push(error instanceof Error ? error.message : String(error));
        }
        context.appendAuditEvent('mission.created', {
          missionId: created.mission.missionId,
          spaceId: created.spaceId,
          pluginId: manifest.id
        });
        if (notificationErrors.length > 0) {
          context.appendAuditEvent('mission.created.notification_failed', {
            missionId: created.mission.missionId,
            spaceId: created.spaceId,
            errors: notificationErrors,
            pluginId: manifest.id
          });
        }
        return await reply(event, {
          content:
            notificationErrors.length === 0
              ? `Created mission ${created.mission.missionId} in <#${created.spaceId}>.`
              : `Created mission ${created.mission.missionId} in <#${created.spaceId}>. Warning: follow-up notifications failed; check runtime status.`,
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
      const requestedMissionId = stringOption(event.input, 'mission_id');
      try {
        const updated =
          event.actionId === 'mission.pause'
            ? await context.pauseMission({ spaceId: event.spaceId ?? '', ...(requestedMissionId ? { missionId: requestedMissionId } : {}) })
            : event.actionId === 'mission.resume'
              ? await context.resumeMission({ spaceId: event.spaceId ?? '', ...(requestedMissionId ? { missionId: requestedMissionId } : {}) })
              : await context.stopMission({ spaceId: event.spaceId ?? '', ...(requestedMissionId ? { missionId: requestedMissionId } : {}) });
        if (!updated) {
          return await reply(event, { content: 'No matching mission found.', ephemeral: true });
        }
        const verb = event.actionId.split('.').at(-1);
        const verbPast = pastTense(verb);
        await context.sendStatusUpdate({
          text: `${verbPast} mission ${updated.missionId}.`,
          blocks: [
            {
              kind: 'fields',
              title: `Mission ${updated.title}`,
              tone: verb === 'stop' ? 'danger' : 'info',
              fields: buildMissionStatusEmbed(updated, context.listMissionRuns(updated.missionId, 5)).fields.map((field) => ({
                label: field.name,
                value: field.value,
                ...(field.inline !== undefined ? { inline: field.inline } : {})
              }))
            }
          ]
        });
        context.appendAuditEvent(`mission.${verbPast}`, { missionId: updated.missionId, pluginId: manifest.id });
        return await reply(event, { content: `${verbPast} mission ${updated.missionId}.`, ephemeral: true });
      } catch (error) {
        return await reply(event, {
          content: error instanceof Error ? error.message : String(error),
          ephemeral: true
        });
      }
    }

    if (event.actionId === 'mission.run-now') {
      try {
        const mission = await context.runMissionNow({
          spaceId: event.spaceId ?? '',
          ...(stringOption(event.input, 'mission_id') ? { missionId: stringOption(event.input, 'mission_id') } : {}),
          requesterActorId: event.actor.actorId
        });
        if (!mission) {
          return await reply(event, { content: 'No matching mission found.', ephemeral: true });
        }
        return await reply(event, {
          content: `Triggered mission ${mission.missionId}.`,
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
      const requestedMissionId = stringOption(event.input, 'mission_id');
      const mission =
        (requestedMissionId ? context.getMissionById(requestedMissionId) : null) ??
        (event.spaceId ? context.getMissionBySpaceId(event.spaceId) : null);
      if (!mission) {
        return await reply(event, { content: 'No matching mission found.', ephemeral: true });
      }
      return await reply(event, {
        content: `Mission ${mission.missionId}`,
        embeds: [buildMissionStatusEmbed(mission, context.listMissionRuns(mission.missionId, 5))],
        ephemeral: true
      });
    }

    if (event.actionId === 'mission.list') {
      return await reply(event, {
        content: 'Current Moorline missions',
        embeds: [buildMissionListEmbed(context.listMissions())],
        ephemeral: true
      });
    }

    return await reply(event, {
      content: `Unsupported mission action: ${event.actionId}`,
      ephemeral: true
    });
  }
};
