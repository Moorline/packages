import manifest from '../../manifest.json' with { type: 'json' };
import { defer, discordAction, isMissingPermissions, reply, stringOption, workspaceDisplay } from '../shared.mjs';

function summarizeSessions(sessions) {
  if (sessions.length === 0) return 'No sessions yet.';
  return sessions
    .map((session) =>
      `${`- ${session.sessionId} (${session.lifecycleStatus}, ${session.runtimeMode})`}${session.summary ? ` | ${session.summary}` : ''}`
    )
    .join('\n');
}

function buildSessionListEmbed(sessions) {
  const openSessions = sessions.filter((session) => session.lifecycleStatus !== 'archived');
  const coolSessions = sessions.filter((session) => session.lifecycleStatus === 'cool');
  const archivedSessions = sessions.filter((session) => session.lifecycleStatus === 'archived');
  return {
    title: 'Moorline Sessions',
    color: 0x3498db,
    fields: [
      { name: 'Open', value: String(openSessions.length), inline: true },
      { name: 'Cool', value: String(coolSessions.length), inline: true },
      { name: 'Archived', value: String(archivedSessions.length), inline: true },
      { name: 'Session Summary', value: summarizeSessions(sessions).slice(0, 1024) || 'No sessions yet.' }
    ],
    timestamp: new Date().toISOString()
  };
}

function sessionOwnerFromEvent(event) {
  const actorId = typeof event?.actor?.actorId === 'string' ? event.actor.actorId.trim() : '';
  if (!actorId) {
    return undefined;
  }
  const actorLabel = typeof event?.actor?.displayName === 'string' ? event.actor.displayName.trim() : '';
  return {
    kind: 'run',
    id: actorId,
    ...(actorLabel ? { label: actorLabel } : {})
  };
}

export default {
  id: manifest.id,
  manifest,
  actions() {
    return [
      discordAction(
        'session.create',
        'Create a new worker session',
        'session',
        'Manage Moorline worker sessions',
        'create',
        'Create a new worker session',
        [
          { type: 'string', name: 'name', description: 'Short session name', required: true },
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
      discordAction(
        'session.archive',
        'Archive a session',
        'session',
        'Manage Moorline worker sessions',
        'archive',
        'Archive a session resource',
        [{ type: 'string', name: 'session_id', description: 'Archive a specific session id' }],
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'session.delete',
        'Delete an archived session',
        'session',
        'Manage Moorline worker sessions',
        'delete',
        'Delete an archived session and its local workspace',
        [
          {
            type: 'string',
            name: 'confirm',
            description: 'Type delete to confirm destructive removal',
            required: true,
            choices: [{ name: 'delete', value: 'delete' }]
          },
          { type: 'string', name: 'session_id', description: 'Delete a specific archived session id' }
        ],
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'session.list',
        'List sessions',
        'session',
        'Manage Moorline worker sessions',
        'list',
        'List active and archived sessions'
      )
    ];
  },
  async onAction(event, context) {
    if (!event.actionId.startsWith('session.')) {
      return { handled: false };
    }

    if (event.actionId === 'session.create') {
      const requestedName = stringOption(event.input, 'name');
      if (!requestedName) {
        return await reply(event, { content: 'name is required', ephemeral: true });
      }
      const requestedMode = stringOption(event.input, 'mode');
      const runtimeMode =
        requestedMode === 'full-access' || requestedMode === 'approval-required'
          ? requestedMode
          : context.config.defaults.runtimeMode;
      const created = await context.createSession({
        requestedName,
        runtimeMode,
        owner: sessionOwnerFromEvent(event)
      });
      const notificationErrors = [];
      try {
        await context.sendMessage(created.transportResourceId, {
          text: `Session ready: ${created.session.sessionId}. Start by sharing your first task.`
        });
      } catch (error) {
        notificationErrors.push(error instanceof Error ? error.message : String(error));
      }
      context.appendAuditEvent('session.created', {
        sessionId: created.session.sessionId,
        transportResourceId: created.transportResourceId,
        runtimeMode,
        pluginId: manifest.id
      });
      if (notificationErrors.length > 0) {
        context.appendAuditEvent('session.created.notification_failed', {
          sessionId: created.session.sessionId,
          transportResourceId: created.transportResourceId,
          runtimeMode,
          errors: notificationErrors,
          pluginId: manifest.id
        });
      }
      return await reply(event, {
        content:
          notificationErrors.length === 0
            ? `Created session ${created.session.sessionId} in <#${created.transportResourceId}>.`
            : `Created session ${created.session.sessionId} in <#${created.transportResourceId}>. Warning: follow-up notifications failed; check runtime status.`,
        ephemeral: true
      });
    }

    if (event.actionId === 'session.archive') {
      if (!event.transportResourceId && !stringOption(event.input, 'session_id')) {
        return await reply(event, {
          content: 'Run this in a session resource or pass session_id.',
          ephemeral: true
        });
      }
      try {
        const session = await context.archiveSession({
          transportResourceId: event.transportResourceId ?? '',
          ...(stringOption(event.input, 'session_id') ? { sessionId: stringOption(event.input, 'session_id') } : {})
        });
        if (!session) {
          return await reply(event, { content: 'No matching session found.', ephemeral: true });
        }
        context.appendAuditEvent('session.archived', {
          sessionId: session.sessionId,
          transportResourceId: session.transportResourceId,
          pluginId: manifest.id
        });
        return await reply(event, {
          content: `Archived session ${session.sessionId}.`,
          ephemeral: true
        });
      } catch (error) {
        if (!isMissingPermissions(error)) throw error;
        return await reply(event, {
          content: 'Archive failed: Moorline needs permission to update the session resource and archive area.',
          ephemeral: true
        });
      }
    }

    if (event.actionId === 'session.delete') {
      if (!event.transportResourceId && !stringOption(event.input, 'session_id')) {
        return await reply(event, {
          content: 'Run this in a session resource or pass session_id.',
          ephemeral: true
        });
      }
      const requestedSessionId = stringOption(event.input, 'session_id');
      const target =
        (requestedSessionId ? context.getSessionById(requestedSessionId) : null) ??
        (event.transportResourceId ? context.getSessionByTransportResourceId(event.transportResourceId) : null);
      if (!target) {
        return await reply(event, { content: 'No matching session found.', ephemeral: true });
      }
      if (target.lifecycleStatus !== 'archived') {
        return await reply(event, {
          content: `Session ${target.sessionId} must be archived before deletion.`,
          ephemeral: true
        });
      }
      if (stringOption(event.input, 'confirm') !== 'delete') {
        return await reply(event, {
          content: 'Deletion cancelled: pass confirm:delete to remove the archived session.',
          ephemeral: true
        });
      }
      if (event.transportResourceId && target.transportResourceId === event.transportResourceId) {
        await defer(event, { ephemeral: true });
      }
      try {
        const deleted = await context.deleteArchivedSession({
          transportResourceId: event.transportResourceId ?? target.transportResourceId,
          ...(requestedSessionId ? { sessionId: requestedSessionId } : {})
        });
        if (!deleted) {
          return await reply(event, { content: 'No matching session found.', ephemeral: true });
        }
        context.appendAuditEvent('session.deleted', {
          sessionId: deleted.sessionId,
          transportResourceId: deleted.transportResourceId,
          workspacePath: deleted.workspacePath,
          pluginId: manifest.id
        });
        return await reply(event, {
          content: `Deleted archived session ${deleted.sessionId} and removed its local workspace (${workspaceDisplay(deleted.sessionId)}).`,
          ephemeral: true
        });
      } catch (error) {
        if (!isMissingPermissions(error)) throw error;
        return await reply(event, {
          content: 'Delete failed: Moorline needs permission to delete the archived session resource.',
          ephemeral: true
        });
      }
    }

    if (event.actionId === 'session.list') {
      return await reply(event, {
        content: 'Current Moorline sessions',
        embeds: [buildSessionListEmbed(context.listSessions())],
        ephemeral: true
      });
    }

    return await reply(event, {
      content: `Unsupported session action: ${event.actionId}`,
      ephemeral: true
    });
  }
};
