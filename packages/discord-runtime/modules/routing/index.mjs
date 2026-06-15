import { readFile } from 'node:fs/promises';
import manifest from '../../manifest.json' with { type: 'json' };

const prompts = {
  coordination: readFile(new globalThis.URL('./coordination.md', import.meta.url), 'utf8').then((value) => value.trim()),
  session: readFile(new globalThis.URL('./session.md', import.meta.url), 'utf8').then((value) => value.trim())
};

function providerCommandLine(context) {
  const providerCommand =
    typeof context.config?.surfaces?.provider?.config?.command === 'string'
      ? context.config.surfaces.provider.config.command.trim()
      : '';
  return providerCommand ? `Provider command: ${providerCommand}.` : 'Provider command: unknown.';
}

async function loadPromptSections(context, surface, dynamicSections = []) {
  const sections = [
    await prompts[surface],
    `Transport surface: discord ${surface} resource.`,
    `Provider package: ${context.config?.surfaces?.provider?.activePackageId ?? 'unknown'}.`,
    `Default model preference: ${context.config?.defaults?.model ?? 'latest'}.`,
    providerCommandLine(context)
  ];
  for (const section of dynamicSections) {
    const trimmed = section.trim();
    if (trimmed) {
      sections.push(trimmed);
    }
  }
  return sections;
}

function mainCoordinationRuntimeMode(context) {
  return context.config?.defaults?.runtimeMode === 'approval-required' ? 'approval-required' : 'full-access';
}

async function routeCoordinationMessage(event, context) {
  const runtimeMode = mainCoordinationRuntimeMode(context);
  const reply = await context.runAgent({
    surface: 'coordination',
    transportResourceId: event.transportResourceId,
    actorId: event.actor.actorId,
    actorLabel: event.actor.displayName ?? event.actor.actorId,
    message: event.message.text,
    attachments: event.message.attachments,
    session: null,
    cwd: context.getRuntimeRootPath(),
    runtimeMode,
    context: {
      systemPromptSections: await loadPromptSections(context, 'coordination', [
        'This coordination surface may use the runtime root for machine-level work, but it is not a durable worker workspace.'
      ])
    }
  });

  await context.sendMessage(event.transportResourceId, reply);
  context.appendAuditEvent('coordination.replied', {
    transportResourceId: event.transportResourceId,
    mode: runtimeMode,
    pluginId: manifest.id
  });
  return { handled: true };
}

async function routeSessionMessage(event, context, session) {
  const reply = await context.runAgent({
    surface: 'session',
    transportResourceId: event.transportResourceId,
    actorId: event.actor.actorId,
    actorLabel: event.actor.displayName ?? event.actor.actorId,
    message: event.message.text,
    attachments: event.message.attachments,
    session,
    cwd: session.workspacePath,
    runtimeMode: session.runtimeMode,
    context: {
      systemPromptSections: await loadPromptSections(context, 'session', [
        `Session ID: ${session.sessionId}`,
        `Workspace: ${session.workspacePath}`,
        `Runtime mode: ${session.runtimeMode}`
      ])
    }
  });

  await context.sendMessage(event.transportResourceId, reply);
  context.appendAuditEvent('session.replied', {
    sessionId: session.sessionId,
    transportResourceId: event.transportResourceId,
    pluginId: manifest.id
  });
  return { handled: true };
}

export default {
  id: manifest.id,
  manifest,
  async onTransportEvent(event, context) {
    if (event.type !== 'message.received') {
      return { handled: false };
    }

    const surface = context.getSurfaceState();
    if (event.transportResourceId === surface.coordinationResourceId) {
      return await routeCoordinationMessage(event, context);
    }

    const session = context.getSessionByTransportResourceId(event.transportResourceId);
    if (!session || session.lifecycleStatus === 'archived') {
      return { handled: false };
    }
    return await routeSessionMessage(event, context, session);
  }
};
