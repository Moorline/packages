import { readFile } from 'node:fs/promises';
import manifest from './manifest.json' with { type: 'json' };

const staticEnvironmentPrompt = readFile(new globalThis.URL('./environment.md', import.meta.url), 'utf8').then((value) =>
  value.trim()
);

async function loadPromptSections(context) {
  const sections = [await staticEnvironmentPrompt];
  const providerCommand =
    typeof context.config?.surfaces?.provider?.config?.command === "string"
      ? context.config.surfaces.provider.config.command.trim()
      : "";
  sections.push(
    "Transport surface: Discord coordination resource.",
    `Provider package: ${context.config?.surfaces?.provider?.activePackageId ?? "unknown"}.`,
    `Default model preference: ${context.config?.defaults?.model ?? "latest"}.`,
    providerCommand ? `Provider command: ${providerCommand}.` : "Provider command: unknown."
  );
  return sections;
}

function mainCoordinationRuntimeMode(context) {
  return context.config?.defaults?.runtimeMode === 'approval-required' ? 'approval-required' : 'full-access';
}

export default {
  id: manifest.id,
  manifest,
  async onTransportEvent(event, context) {
    if (event.type !== 'message.received') {
      return { handled: false };
    }

    const surface = context.getSurfaceState();
    if (event.transportResourceId !== surface.coordinationResourceId) {
      return { handled: false };
    }

    const reply = await context.runAgent({
      surface: 'coordination',
      transportResourceId: event.transportResourceId,
      actorId: event.actor.actorId,
      actorLabel: event.actor.displayName ?? event.actor.actorId,
      text: event.message.text,
      attachments: event.message.attachments,
      session: null,
      cwd: context.getCoordinationWorkspacePath(),
      runtimeMode: mainCoordinationRuntimeMode(context),
      basePromptSections: await loadPromptSections(context)
    });

    await context.sendMessage(event.transportResourceId, reply);
    const runtimeMode = mainCoordinationRuntimeMode(context);
    context.appendAuditEvent('coordination.replied', {
      transportResourceId: event.transportResourceId,
      mode: runtimeMode,
      pluginId: manifest.id
    });
    return { handled: true };
  }
};
