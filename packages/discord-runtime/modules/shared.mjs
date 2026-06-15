export function discordAction(id, title, commandName, commandDescription, subcommandName, subcommandDescription, options, policy) {
  if (Array.isArray(subcommandName) || subcommandName === undefined && subcommandDescription && typeof subcommandDescription === 'object' && !Array.isArray(subcommandDescription)) {
    policy = subcommandDescription;
    options = subcommandName;
    subcommandDescription = undefined;
    subcommandName = undefined;
  }

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

export function stringOption(input, key) {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function toRuntimeReply(payload) {
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

export async function reply(event, payload) {
  const native = event.native?.payload;
  if (native && typeof native === 'object' && typeof native.reply === 'function') {
    await native.reply(payload);
    return { handled: true };
  }
  return { handled: true, reply: toRuntimeReply(payload) };
}

export async function defer(event, payload) {
  const native = event.native?.payload;
  if (native && typeof native === 'object' && typeof native.defer === 'function') {
    await native.defer(payload);
  }
}

export function isMissingPermissions(error) {
  return !!error && typeof error === 'object' && error.code === 50013;
}

export function workspaceDisplay(sessionId) {
  return `runtime/workspaces/${sessionId}`;
}
