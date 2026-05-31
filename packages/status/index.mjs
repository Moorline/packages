import manifest from './manifest.json' with { type: 'json' };

const MAX_EMBED_FIELD_VALUE = 1024;

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

function buildHealthEmbed(input) {
  return {
    title: 'Moorline Health',
    color: input.dbOk && input.environmentOk ? 0x2ecc71 : 0xe74c3c,
    fields: [
      { name: 'Uptime', value: `${input.uptimeSeconds}s`, inline: true },
      { name: 'Database', value: input.dbDetail ?? (input.dbOk ? 'OK' : 'Error'), inline: true },
      { name: 'Environment', value: input.environmentDetail ?? (input.environmentOk ? 'OK' : 'Error'), inline: true },
      { name: 'Open Sessions', value: String(input.activeSessions), inline: true },
      { name: 'Cool Sessions', value: String(input.coolSessions), inline: true },
      { name: 'Archived Sessions', value: String(input.archivedSessions), inline: true }
    ],
    timestamp: new Date().toISOString()
  };
}

function parseAnswers(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { answer: raw };
    const result = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') result[key] = value;
      else if (Array.isArray(value)) {
        const normalized = value.filter((entry) => typeof entry === 'string');
        if (normalized.length > 0) result[key] = normalized;
      }
    }
    return Object.keys(result).length > 0 ? result : { answer: raw };
  } catch {
    return { answer: raw };
  }
}

function toBlock(title, tone, fields) {
  return {
    kind: 'fields',
    title,
    tone,
    fields: fields.map((field) => ({
      label: field.name,
      value: field.value,
      ...(field.inline !== undefined ? { inline: field.inline } : {})
    }))
  };
}

function truncateEmbedValue(value, maxLength = MAX_EMBED_FIELD_VALUE) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return 'None';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 14))}...(truncated)`;
}

function summarizeRuntimeIssue(event) {
  if (event.type === 'turn.failed') {
    return 'A turn failed. Check local runtime audit logs for detailed diagnostics.';
  }
  if (event.type === 'provider.closed') {
    return 'A provider session closed unexpectedly. Check local runtime audit logs for details.';
  }
  return 'A runtime error occurred. Check local runtime audit logs for details.';
}

export default {
  id: manifest.id,
  manifest,
  actions() {
    return [
      discordAction(
        'runtime.status',
        'Show runtime status',
        'status',
        'Show Moorline namespace and runtime status',
        undefined,
        undefined,
        undefined,
        { allowedWhileDraining: true }
      ),
      discordAction(
        'runtime.turn.stop',
        'Stop the active turn',
        'turn',
        'Control the active provider turn in this session',
        'stop',
        'Interrupt the active turn for this session',
        undefined,
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'runtime.request.cancel',
        'Cancel a pending runtime request',
        'request',
        'Respond to a pending runtime user-input request',
        'cancel',
        'Cancel a pending runtime request',
        [{ type: 'string', name: 'request_id', description: 'Pending request id', required: true }],
        { allowedWhileDraining: true, bypassQueue: true }
      ),
      discordAction(
        'runtime.request.answer',
        'Answer a pending runtime request',
        'request',
        'Respond to a pending runtime user-input request',
        'answer',
        'Answer a pending runtime user-input request',
        [
          { type: 'string', name: 'request_id', description: 'Pending request id', required: true },
          {
            type: 'string',
            name: 'answers',
            description: 'Plain text answer or JSON object keyed by question id',
            required: true
          }
        ],
        { allowedWhileDraining: true, bypassQueue: true }
      )
    ];
  },
  async onDomainEvent(event, context) {
    if (event.spaceId === null) return;
    if (event.type === 'turn.waiting_for_approval' || event.type === 'turn.waiting_for_input') {
      await context.sendStatusUpdate({
        text: `Session ${event.sessionId ?? event.threadId} is waiting.`,
        blocks: [
          toBlock('Turn Waiting', 'warning', [
            { name: 'Session', value: event.sessionId ?? event.threadId },
            { name: 'State', value: event.type.replace('turn.', '').replace(/_/g, ' ') }
          ])
        ]
      });
    }
    if (event.type === 'turn.failed' || event.type === 'runtime.error' || event.type === 'provider.closed') {
      const detail = summarizeRuntimeIssue(event);
      await context.sendStatusUpdate({
        text: `Session ${event.sessionId ?? event.threadId} hit a runtime problem.`,
        blocks: [
          toBlock('Runtime Issue', 'danger', [
            { name: 'Session', value: event.sessionId ?? event.threadId },
            { name: 'Detail', value: detail }
          ])
        ]
      });
    }
  },
  async onAction(event, context) {
    if (event.actionId === 'runtime.turn.stop') {
      if (!event.spaceId) {
        return await reply(event, { content: 'This action requires a target session space.', ephemeral: true });
      }
      const session = context.getSessionBySpaceId(event.spaceId);
      if (!session) {
        return await reply(event, {
          content: 'This space does not have an active Moorline session.',
          ephemeral: true
        });
      }
      await context.interruptTurn({ threadId: session.threadId });
      return await reply(event, {
        content: `Interrupt sent for ${session.sessionId}.`,
        ephemeral: true
      });
    }

    if (event.actionId === 'runtime.request.cancel' || event.actionId === 'runtime.request.answer') {
      if (!event.spaceId) {
        return await reply(event, { content: 'This action requires a target space.', ephemeral: true });
      }
      const requestId = stringOption(event.input, 'request_id');
      if (!requestId) {
        return await reply(event, { content: 'request_id is required.', ephemeral: true });
      }
      const request = context.listPendingRequests(event.spaceId).find((entry) => entry.requestId === requestId);
      if (!request) {
        return await reply(event, {
          content: `No pending request ${requestId} was found in this space.`,
          ephemeral: true
        });
      }
      if (event.actionId === 'runtime.request.cancel') {
        try {
          await context.cancelRuntimeRequest({
            threadId: request.threadId,
            requestId,
            requestType: request.requestType,
            requesterActor: event.actor
          });
        } catch (error) {
          return await reply(event, {
            content: error instanceof Error ? error.message : String(error),
            ephemeral: true
          });
        }
        return await reply(event, {
          content: `Cancelled request ${requestId}.`,
          ephemeral: true
        });
      }
      if (request.requestType !== 'tool_user_input') {
        return await reply(event, {
          content: `Request ${requestId} is approval-driven. Use the request actions instead.`,
          ephemeral: true
        });
      }
      try {
        await context.respondToRuntimeUserInput({
          threadId: request.threadId,
          requestId,
          answers: parseAnswers(stringOption(event.input, 'answers')),
          requesterActor: event.actor
        });
      } catch (error) {
        return await reply(event, {
          content: error instanceof Error ? error.message : String(error),
          ephemeral: true
        });
      }
      return await reply(event, {
        content: `Answered request ${requestId}.`,
        ephemeral: true
      });
    }

    if (event.actionId !== 'runtime.status') {
      return { handled: false };
    }

    const namespace = context.getNamespaceState();
    const runtimeStatus = context.getRuntimeStatus();
    const providerDiagnostics = context.getProviderDiagnostics();
    const overview = context.getRuntimeOverview();
    const receipts = overview.receipts;
    const activities = overview.sessions.flatMap((session) => session.recentActivities).slice(-5);
    const projectionStates = overview.projectionStates;
    const projectionFailures = projectionStates.filter((entry) => entry.failure !== null);
    const providerErrorCount = Number(providerDiagnostics.statusCounts.error ?? 0);
    const dbOk = projectionFailures.length === 0;
    const environmentOk = providerErrorCount === 0;
    const dbDetail =
      projectionFailures.length === 0 ? 'OK' : `Error (${projectionFailures.length} projection failure${projectionFailures.length === 1 ? '' : 's'})`;
    const environmentDetail = providerErrorCount === 0 ? 'OK' : `Error (${providerErrorCount} provider session${providerErrorCount === 1 ? '' : 's'})`;

    return await reply(event, {
      content: 'Moorline runtime status',
      embeds: [
        buildHealthEmbed({
          uptimeSeconds: runtimeStatus.uptimeSeconds,
          dbOk,
          environmentOk,
          dbDetail,
          environmentDetail,
          activeSessions: runtimeStatus.openSessions,
          coolSessions: runtimeStatus.coolSessions,
          archivedSessions: runtimeStatus.archivedSessions
        }),
        {
          title: 'Runtime Activity',
          color: 0x1abc9c,
          fields: [
            { name: 'Running Sessions', value: String(runtimeStatus.runningSessions), inline: true },
            { name: 'Waiting Sessions', value: String(runtimeStatus.waitingSessions), inline: true },
            {
              name: 'Pending Receipts',
              value: truncateEmbedValue(
                receipts.length === 0 ? 'None' : receipts.slice(-5).map((receipt) => `${receipt.threadId}: ${receipt.state}`).join('\n')
              )
            },
            {
              name: 'Recent Activity',
              value: truncateEmbedValue(
                activities.length === 0
                  ? 'None'
                  : activities
                      .map((activity) => `${activity.title}${activity.detail ? ` - ${activity.detail}` : ''}`)
                      .join('\n')
              )
            }
          ],
          timestamp: context.nowIso()
        },
        {
          title: 'Provider Diagnostics',
          color: 0x9b59b6,
          fields: [
            { name: 'Account', value: providerDiagnostics.accountLabel ?? 'unknown', inline: true },
            { name: 'Default Model', value: context.getDefaultModel(), inline: true },
            { name: 'Connected Sessions', value: String(providerDiagnostics.connectedSessions), inline: true },
            {
              name: 'Models',
              value: truncateEmbedValue(providerDiagnostics.availableModels.join(', ') || 'Unknown'),
              inline: true
            },
            {
              name: 'Provider Statuses',
              value: truncateEmbedValue(
                Object.entries(providerDiagnostics.statusCounts)
                  .map(([status, count]) => `${status}: ${count}`)
                  .join('\n') || 'None'
              )
            },
            {
              name: 'Capabilities',
              value: truncateEmbedValue(Object.keys(providerDiagnostics.capabilityMetadata).join(', ') || 'None')
            }
          ],
          timestamp: context.nowIso()
        },
        {
          title: 'Projection Health',
          color: projectionFailures.length === 0 ? 0x2ecc71 : 0xe74c3c,
          fields: [
            {
              name: 'Pipelines',
              value:
                truncateEmbedValue(
                  projectionStates
                    .map((entry) => `${entry.projector}: ${entry.failure ? `failed (${entry.failure})` : 'ok'}`)
                    .join('\n') || 'None'
                )
            }
          ],
          timestamp: context.nowIso()
        },
        {
          title: 'Managed Namespace',
          color: 0x3498db,
          fields: [
            { name: 'Chat', value: `<#${namespace.chatChannelId}>`, inline: true },
            { name: 'Status', value: `<#${namespace.statusChannelId}>`, inline: true },
            { name: 'Sessions', value: namespace.sessionsCategoryId, inline: true },
            { name: 'Archive', value: namespace.archiveCategoryId, inline: true }
          ],
          timestamp: context.nowIso()
        }
      ],
      ephemeral: true
    });
  }
};
