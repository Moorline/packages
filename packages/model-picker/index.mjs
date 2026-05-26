import manifest from './manifest.json' with { type: 'json' };

function discordAction(id, title, commandName, commandDescription, subcommandName, subcommandDescription, options) {
  return {
    id,
    title,
    description: subcommandDescription ?? commandDescription,
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

function formatDefaultModel(model) {
  return model === 'latest' ? 'latest (provider default)' : model;
}

function buildModelEmbed(context) {
  const diagnostics = context.getProviderDiagnostics();
  const availableModels = diagnostics.availableModels;
  return {
    title: 'Moorline Model',
    color: 0x3498db,
    fields: [
      { name: 'Default', value: formatDefaultModel(context.getDefaultModel()), inline: true },
      { name: 'Account', value: diagnostics.accountLabel ?? 'unknown', inline: true },
      {
        name: 'Available Models',
        value:
          availableModels.length > 0
            ? ['latest (provider default)', ...availableModels].join('\n').slice(0, 1024)
            : 'Unknown until a provider session has reported model metadata.'
      }
    ],
    timestamp: context.nowIso()
  };
}

async function reply(event, payload) {
  const native = event.native?.payload;
  if (native && typeof native === 'object' && typeof native.reply === 'function') {
    await native.reply(payload);
    return { handled: true };
  }
  return { handled: true, reply: { ...(payload.content ? { text: payload.content } : {}) } };
}

export default {
  id: manifest.id,
  manifest,
  actions() {
    return [
      discordAction(
        'provider.model.list',
        'List the default model',
        'model',
        'List and select the default Moorline model',
        'list',
        'Show the configured default model and known available models'
      ),
      discordAction(
        'provider.model.select',
        'Select the default model',
        'model',
        'List and select the default Moorline model',
        'select',
        'Set the default model for future Moorline turns',
        [{ type: 'string', name: 'name', description: 'Model id to use by default, or latest', required: true }]
      )
    ];
  },
  managementContributions() {
    return [
      {
        id: 'default-model',
        title: 'Default Model',
        surface: 'cli',
        packageId: manifest.id,
        placement: 'settings',
        kind: 'form',
        requiredCapability: 'fs.write',
        executeActionId: 'provider.model.select',
        readModelSelector: 'settings.defaults.model',
        inputSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              title: 'Model',
              description: 'Model id to use by default, or latest'
            }
          }
        }
      }
    ];
  },
  async onAction(event, context) {
    if (event.actionId === 'provider.model.list') {
      return await reply(event, {
        content: `Current default model: ${formatDefaultModel(context.getDefaultModel())}`,
        embeds: [buildModelEmbed(context)],
        ephemeral: true
      });
    }

    if (event.actionId !== 'provider.model.select') {
      return { handled: false };
    }

    const requestedModel = stringOption(event.input, 'name');
    if (!requestedModel) {
      return await reply(event, { content: 'name is required.', ephemeral: true });
    }

    const currentModel = context.getDefaultModel();
    if (currentModel === requestedModel) {
      return await reply(event, {
        content: `Moorline is already using ${formatDefaultModel(requestedModel)} by default.`,
        embeds: [buildModelEmbed(context)],
        ephemeral: true
      });
    }

    try {
      await context.setDefaultModel(requestedModel);
    } catch (error) {
      return await reply(event, {
        content: error instanceof Error ? error.message : String(error),
        embeds: [buildModelEmbed(context)],
        ephemeral: true
      });
    }

    context.appendAuditEvent('config.default-model.updated', {
      model: requestedModel,
      pluginId: manifest.id
    });
    return await reply(event, {
      content:
        requestedModel === 'latest'
          ? 'Default model updated to latest. Future turns will use the provider default.'
          : `Default model updated to ${requestedModel}. Future turns will use it.`,
      embeds: [buildModelEmbed(context)],
      ephemeral: true
    });
  }
};
