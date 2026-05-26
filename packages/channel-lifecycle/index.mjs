import manifest from './manifest.json' with { type: 'json' };

function discordAction(id, title, commandName, commandDescription, options, policy) {
  return {
    id,
    title,
    description: title,
    ...(policy ? { policy } : {}),
    metadata: {
      discordCommand: {
        commandName,
        commandDescription,
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

async function defer(event, payload) {
  const native = event.native?.payload;
  if (native && typeof native === 'object' && typeof native.defer === 'function') {
    await native.defer(payload);
  }
}

function isMissingPermissions(error) {
  return !!error && typeof error === 'object' && error.code === 50013;
}

function workspaceDisplay(id) {
  return `runtime/workspaces/${id}`;
}

function summarizeArchivedTarget(target) {
  if (target.kind === 'session') {
    return {
      noun: 'session',
      id: target.session.sessionId,
      spaceId: target.session.spaceId,
      workspacePath: target.session.workspacePath
    };
  }
  return {
    noun: 'mission',
    id: target.mission.missionId,
    spaceId: target.mission.spaceId,
    workspacePath: target.mission.workspacePath
  };
}

export default {
  id: manifest.id,
  manifest,
  actions() {
    return [
      discordAction(
        'space.archive',
        'Archive the current Moorline session or mission space',
        'archive',
        'Archive the current Moorline session or mission space',
        undefined,
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'space.delete',
        'Delete the current archived Moorline session or mission space',
        'delete',
        'Delete the current archived Moorline session or mission space',
        [
          {
            type: 'string',
            name: 'confirm',
            description: 'Type delete to confirm destructive removal',
            required: true,
            choices: [{ name: 'delete', value: 'delete' }]
          }
        ],
        { allowedWhileDraining: true, bypassQueue: true }
      )
    ];
  },
  async onAction(event, context) {
    if (event.actionId === 'space.archive') {
      if (!event.spaceId) {
        return await reply(event, { content: 'This action requires a target space.', ephemeral: true });
      }
      try {
        const archived = await context.archiveSpaceTarget({ spaceId: event.spaceId });
        if (!archived) {
          return await reply(event, {
            content: 'This space is not an archivable Moorline session or mission.',
            ephemeral: true
          });
        }
        const target = summarizeArchivedTarget(archived);
        await context.sendMessage(target.spaceId, {
          text: `${target.noun === 'session' ? 'Session' : 'Mission'} archived. Use \`/delete confirm:delete\` to remove the local workspace.`,
          blocks: [
            {
              kind: 'fields',
              title: `${target.noun === 'session' ? 'Session' : 'Mission'} Archived`,
              tone: 'warning',
              fields: [
                { label: target.noun === 'session' ? 'Session' : 'Mission', value: target.id },
                { label: 'Workspace', value: workspaceDisplay(target.id) }
              ]
            }
          ]
        });
        await context.sendStatusUpdate({
          text: `Archived ${target.noun} ${target.id} from ${target.spaceId}.`,
          blocks: [
            {
              kind: 'fields',
              title: `${target.noun === 'session' ? 'Session' : 'Mission'} Archived`,
              tone: 'warning',
              fields: [
                { label: target.noun === 'session' ? 'Session' : 'Mission', value: target.id },
                { label: 'Space', value: target.spaceId }
              ]
            }
          ]
        });
        context.appendAuditEvent(`${target.noun}.archived`, {
          [`${target.noun}Id`]: target.id,
          spaceId: target.spaceId,
          pluginId: manifest.id
        });
        return await reply(event, {
          content: `Archived ${target.noun} ${target.id}.`,
          ephemeral: true
        });
      } catch (error) {
        if (!isMissingPermissions(error)) throw error;
        return await reply(event, {
          content: 'Archive failed: Moorline needs permission to update the current space and archive area.',
          ephemeral: true
        });
      }
    }

    if (event.actionId === 'space.delete') {
      if (!event.spaceId) {
        return await reply(event, { content: 'This action requires a target space.', ephemeral: true });
      }
      if (stringOption(event.input, 'confirm') !== 'delete') {
        return await reply(event, {
          content: 'Deletion cancelled: pass confirm:delete to remove the archived space.',
          ephemeral: true
        });
      }

      const session = context.getSessionBySpaceId(event.spaceId);
      if (session && session.lifecycleStatus !== 'archived') {
        return await reply(event, {
          content: `Session ${session.sessionId} must be archived before deletion.`,
          ephemeral: true
        });
      }
      const mission = context.getMissionBySpaceId(event.spaceId);
      if (mission && !mission.archivedAt) {
        return await reply(event, {
          content: `Mission ${mission.missionId} must be archived before deletion.`,
          ephemeral: true
        });
      }
      if (!session && !mission) {
        return await reply(event, {
          content: 'This space is not a deletable Moorline session or mission.',
          ephemeral: true
        });
      }

      await defer(event, { ephemeral: true });
      try {
        const deleted = await context.deleteArchivedSpaceTarget({ spaceId: event.spaceId });
        if (!deleted) {
          return await reply(event, {
            content: 'This archived space could not be deleted.',
            ephemeral: true
          });
        }
        const target = summarizeArchivedTarget(deleted);
        await context.sendStatusUpdate({
          text: `Deleted archived ${target.noun} ${target.id} and removed its local workspace.`,
          blocks: [
            {
              kind: 'fields',
              title: `${target.noun === 'session' ? 'Session' : 'Mission'} Deleted`,
              tone: 'danger',
              fields: [
                { label: target.noun === 'session' ? 'Session' : 'Mission', value: target.id },
                { label: 'Workspace', value: workspaceDisplay(target.id) }
              ]
            }
          ]
        });
        context.appendAuditEvent(`${target.noun}.deleted`, {
          [`${target.noun}Id`]: target.id,
          spaceId: target.spaceId,
          workspacePath: target.workspacePath,
          pluginId: manifest.id
        });
        return await reply(event, {
          content: `Deleted archived ${target.noun} ${target.id} and removed its local workspace (${workspaceDisplay(target.id)}).`,
          ephemeral: true
        });
      } catch (error) {
        if (!isMissingPermissions(error)) throw error;
        return await reply(event, {
          content: 'Delete failed: Moorline needs permission to delete the archived space.',
          ephemeral: true
        });
      }
    }

    return { handled: false };
  }
};
