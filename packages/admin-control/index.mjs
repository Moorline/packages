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

function toRuntimeReply(payload) {
  const blocks = (payload.embeds ?? []).map((embed) => ({
    kind: 'fields',
    ...(embed.title ? { title: embed.title } : {}),
    ...(embed.description ? { text: embed.description } : {}),
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

function currentThreadIdOrNull(context, spaceId) {
  return context.getSessionBySpaceId(spaceId)?.threadId ?? null;
}

export default {
  id: manifest.id,
  manifest,
  actions() {
    return [
      discordAction(
        'runtime.admin.status',
        'Admin status',
        'admin',
        'Administrative runtime controls',
        'status',
        'Show runtime control state',
        undefined,
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'runtime.admin.reload',
        'Reload runtime',
        'admin',
        'Administrative runtime controls',
        'reload',
        'Reload the runtime worker',
        [
          {
            type: 'string',
            name: 'mode',
            description: 'Reload mode',
            required: true,
            choices: [
              { name: 'graceful', value: 'graceful' },
              { name: 'force', value: 'force' }
            ]
          }
        ],
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'runtime.admin.provider-stop',
        'Stop provider sessions',
        'admin',
        'Administrative runtime controls',
        'provider-stop',
        'Stop provider sessions',
        [
          {
            type: 'string',
            name: 'scope',
            description: 'Whether to stop all sessions or only the current session',
            required: true,
            choices: [
              { name: 'all', value: 'all' },
              { name: 'current', value: 'current' }
            ]
          }
        ],
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'runtime.admin.provider-start',
        'Recover provider sessions',
        'admin',
        'Administrative runtime controls',
        'provider-start',
        'Recover provider sessions',
        [
          {
            type: 'string',
            name: 'scope',
            description: 'Whether to recover all sessions or only the current session',
            required: true,
            choices: [
              { name: 'all', value: 'all' },
              { name: 'current', value: 'current' }
            ]
          }
        ],
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'runtime.admin.accepting',
        'Toggle accepting work',
        'admin',
        'Administrative runtime controls',
        'accepting',
        'Enable or disable acceptance of new work',
        [
          {
            type: 'string',
            name: 'value',
            description: 'Whether the runtime should accept new work',
            required: true,
            choices: [
              { name: 'true', value: 'true' },
              { name: 'false', value: 'false' }
            ]
          }
        ],
        { allowedWhileDraining: true, bypassQueue: true }
      )
    ];
  },
  async onAction(event, context) {
    if (!event.actionId.startsWith('runtime.admin.')) {
      return { handled: false };
    }

    const requestedBy = event.actor;
    if (!context.isAdminActor(requestedBy)) {
      context.appendAuditEvent('runtime.admin.denied', {
        actionId: event.actionId,
        requestedBy: requestedBy.actorId,
        accessGroupIds: requestedBy.accessGroupIds ?? [],
        isSurfaceAdmin: requestedBy.isSurfaceAdmin === true
      });
      return await reply(event, {
        content: 'This command is restricted to Moorline admins.',
        ephemeral: true
      });
    }

    if (event.actionId === 'runtime.admin.status') {
      const control = context.getRuntimeControlStatus();
      const runtime = context.getRuntimeStatus();
      return await reply(event, {
        content: 'Moorline admin status',
        embeds: [
          {
            title: 'Runtime Control',
            color: 0x3498db,
            fields: [
              { name: 'Supervised', value: control.supervised ? 'yes' : 'no', inline: true },
              { name: 'Accepting Work', value: control.acceptingNewWork ? 'yes' : 'no', inline: true },
              { name: 'Running Sessions', value: String(runtime.runningSessions), inline: true },
              { name: 'Waiting Sessions', value: String(runtime.waitingSessions), inline: true }
            ],
            timestamp: context.nowIso()
          }
        ],
        ephemeral: true
      });
    }

    if (event.actionId === 'runtime.admin.reload') {
      const mode = stringOption(event.input, 'mode') === 'force' ? 'force' : 'graceful';
      const result = await context.requestRuntimeReload({
        mode,
        reason: `Discord admin request from ${requestedBy.actorId}`,
        requestedBy
      });
      context.appendAuditEvent('runtime.reload.requested.by-admin', {
        requestedBy: requestedBy.actorId,
        mode
      });
      return await reply(event, {
        content: result.detail,
        ephemeral: true
      });
    }

    if (event.actionId === 'runtime.admin.provider-stop') {
      const threadId = stringOption(event.input, 'scope') === 'current' && event.spaceId ? currentThreadIdOrNull(context, event.spaceId) : null;
      if (stringOption(event.input, 'scope') === 'current' && !threadId) {
        return await reply(event, {
          content: 'This space does not map to an active Moorline session.',
          ephemeral: true
        });
      }
      await context.stopProvider({
        ...(threadId ? { threadId } : {}),
        reason: `Discord admin request from ${requestedBy.actorId}`,
        requestedBy
      });
      return await reply(event, {
        content: threadId ? `Stopped provider session ${threadId}.` : 'Stopped all provider sessions.',
        ephemeral: true
      });
    }

    if (event.actionId === 'runtime.admin.provider-start') {
      const threadId = stringOption(event.input, 'scope') === 'current' && event.spaceId ? currentThreadIdOrNull(context, event.spaceId) : null;
      if (stringOption(event.input, 'scope') === 'current' && !threadId) {
        return await reply(event, {
          content: 'This space does not map to an active Moorline session.',
          ephemeral: true
        });
      }
      await context.startProvider({
        ...(threadId ? { threadId } : {}),
        reason: `Discord admin request from ${requestedBy.actorId}`,
        requestedBy
      });
      return await reply(event, {
        content: threadId ? `Recovered provider session ${threadId}.` : 'Recovered all provider sessions.',
        ephemeral: true
      });
    }

    if (event.actionId === 'runtime.admin.accepting') {
      const accepting = stringOption(event.input, 'value') === 'true';
      await context.setRuntimeAcceptingNewWork({
        accepting,
        reason: `Discord admin request from ${requestedBy.actorId}`,
        requestedBy
      });
      return await reply(event, {
        content: accepting ? 'Runtime is now accepting new work.' : 'Runtime is no longer accepting new work.',
        ephemeral: true
      });
    }

    return await reply(event, {
      content: `Unsupported admin action: ${event.actionId}`,
      ephemeral: true
    });
  }
};
