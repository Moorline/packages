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
  return {
    id: target.session.sessionId,
    spaceId: target.session.spaceId,
    workspacePath: target.session.workspacePath
  };
}

export default {
  id: manifest.id,
  manifest,
  actions() {
    return [
      discordAction(
        'space.archive',
        'Archive the current Moorline session space',
        'archive',
        'Archive the current Moorline session space',
        undefined,
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'space.delete',
        'Delete the current archived Moorline session space',
        'delete',
        'Delete the current archived Moorline session space',
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
            content: 'This space is not an archivable Moorline session.',
            ephemeral: true
          });
        }
        const target = summarizeArchivedTarget(archived);
        await context.sendMessage(target.spaceId, {
          text: 'Session archived. Use `/delete confirm:delete` to remove the local workspace.',
          blocks: [
            {
              kind: 'fields',
              title: 'Session Archived',
              tone: 'warning',
              fields: [
                { label: 'Session', value: target.id },
                { label: 'Workspace', value: workspaceDisplay(target.id) }
              ]
            }
          ]
        });
        await context.sendStatusUpdate({
          text: `Archived session ${target.id} from ${target.spaceId}.`,
          blocks: [
            {
              kind: 'fields',
              title: 'Session Archived',
              tone: 'warning',
              fields: [
                { label: 'Session', value: target.id },
                { label: 'Space', value: target.spaceId }
              ]
            }
          ]
        });
        context.appendAuditEvent('session.archived', {
          sessionId: target.id,
          spaceId: target.spaceId,
          pluginId: manifest.id
        });
        return await reply(event, {
          content: `Archived session ${target.id}.`,
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
      if (!session) {
        return await reply(event, {
          content: 'This space is not a deletable Moorline session.',
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
          text: `Deleted archived session ${target.id} and removed its local workspace.`,
          blocks: [
            {
              kind: 'fields',
              title: 'Session Deleted',
              tone: 'danger',
              fields: [
                { label: 'Session', value: target.id },
                { label: 'Workspace', value: workspaceDisplay(target.id) }
              ]
            }
          ]
        });
        context.appendAuditEvent('session.deleted', {
          sessionId: target.id,
          spaceId: target.spaceId,
          workspacePath: target.workspacePath,
          pluginId: manifest.id
        });
        return await reply(event, {
          content: `Deleted archived session ${target.id} and removed its local workspace (${workspaceDisplay(target.id)}).`,
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
