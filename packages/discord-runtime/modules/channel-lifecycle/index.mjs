import manifest from '../../manifest.json' with { type: 'json' };
import { defer, discordAction, isMissingPermissions, reply, stringOption, workspaceDisplay } from '../shared.mjs';

function summarizeArchivedTarget(target) {
  return {
    id: target.session.sessionId,
    transportResourceId: target.session.transportResourceId,
    workspacePath: target.session.workspacePath
  };
}

export default {
  id: manifest.id,
  manifest,
  actions() {
    return [
      discordAction(
        'resource.archive',
        'Archive the current Moorline session resource',
        'archive',
        'Archive the current Moorline session resource',
        undefined,
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'resource.delete',
        'Delete the current archived Moorline session resource',
        'delete',
        'Delete the current archived Moorline session resource',
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
    if (event.actionId === 'resource.archive') {
      if (!event.transportResourceId) {
        return await reply(event, { content: 'This action requires a target resource.', ephemeral: true });
      }
      try {
        const archived = await context.archiveTransportResourceTarget({ transportResourceId: event.transportResourceId });
        if (!archived) {
          return await reply(event, {
            content: 'This resource is not an archivable Moorline session.',
            ephemeral: true
          });
        }
        const target = summarizeArchivedTarget(archived);
        await context.sendMessage(target.transportResourceId, {
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
          text: `Archived session ${target.id} from ${target.transportResourceId}.`,
          blocks: [
            {
              kind: 'fields',
              title: 'Session Archived',
              tone: 'warning',
              fields: [
                { label: 'Session', value: target.id },
                { label: 'Resource', value: target.transportResourceId }
              ]
            }
          ]
        });
        context.appendAuditEvent('session.archived', {
          sessionId: target.id,
          transportResourceId: target.transportResourceId,
          pluginId: manifest.id
        });
        return await reply(event, {
          content: `Archived session ${target.id}.`,
          ephemeral: true
        });
      } catch (error) {
        if (!isMissingPermissions(error)) throw error;
        return await reply(event, {
          content: 'Archive failed: Moorline needs permission to update the current resource and archive area.',
          ephemeral: true
        });
      }
    }

    if (event.actionId === 'resource.delete') {
      if (!event.transportResourceId) {
        return await reply(event, { content: 'This action requires a target resource.', ephemeral: true });
      }
      if (stringOption(event.input, 'confirm') !== 'delete') {
        return await reply(event, {
          content: 'Deletion cancelled: pass confirm:delete to remove the archived resource.',
          ephemeral: true
        });
      }

      const session = context.getSessionByTransportResourceId(event.transportResourceId);
      if (session && session.lifecycleStatus !== 'archived') {
        return await reply(event, {
          content: `Session ${session.sessionId} must be archived before deletion.`,
          ephemeral: true
        });
      }
      if (!session) {
        return await reply(event, {
          content: 'This resource is not a deletable Moorline session.',
          ephemeral: true
        });
      }

      await defer(event, { ephemeral: true });
      try {
        const deleted = await context.deleteArchivedTransportResourceTarget({ transportResourceId: event.transportResourceId });
        if (!deleted) {
          return await reply(event, {
            content: 'This archived resource could not be deleted.',
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
          transportResourceId: target.transportResourceId,
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
          content: 'Delete failed: Moorline needs permission to delete the archived resource.',
          ephemeral: true
        });
      }
    }

    return { handled: false };
  }
};
