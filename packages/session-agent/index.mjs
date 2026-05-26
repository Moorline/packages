import { readFile } from 'node:fs/promises';
import manifest from './manifest.json' with { type: 'json' };

const staticEnvironmentPrompt = readFile(new globalThis.URL('./environment.md', import.meta.url), 'utf8').then((value) =>
  value.trim()
);

async function loadPromptSections(context, dynamicSections = []) {
  const sections = [await staticEnvironmentPrompt];
  const providerCommand =
    typeof context.config?.surfaces?.provider?.config?.command === "string"
      ? context.config.surfaces.provider.config.command.trim()
      : "";
  sections.push(
    "Transport surface: Discord session channel.",
    `Provider package: ${context.config?.surfaces?.provider?.activePackageId ?? "unknown"}.`,
    `Default model preference: ${context.config?.defaults?.model ?? "latest"}.`,
    providerCommand ? `Provider command: ${providerCommand}.` : "Provider command: unknown."
  );
  for (const section of dynamicSections) {
    const trimmed = section.trim();
    if (trimmed) {
      sections.push(trimmed);
    }
  }
  return sections;
}

export default {
  id: manifest.id,
  manifest,
  async onTransportEvent(event, context) {
    if (event.type !== 'message.received') {
      return { handled: false };
    }

    const session = context.getSessionBySpaceId(event.spaceId);
    if (!session || session.lifecycleStatus === 'archived') {
      return { handled: false };
    }

    const reply = await context.runAgent({
      surface: 'session',
      spaceId: event.spaceId,
      actorId: event.actor.actorId,
      actorLabel: event.actor.displayName ?? event.actor.actorId,
      text: event.message.text,
      attachments: event.message.attachments,
      session,
      cwd: session.workspacePath,
      runtimeMode: session.runtimeMode,
      basePromptSections: await loadPromptSections(context, [
        `Session ID: ${session.sessionId}`,
        `Workspace: ${session.workspacePath}`,
        `Runtime mode: ${session.runtimeMode}`
      ])
    });

    await context.sendMessage(event.spaceId, reply);
    context.appendAuditEvent('session.replied', {
      sessionId: session.sessionId,
      spaceId: event.spaceId,
      pluginId: manifest.id
    });
    return { handled: true };
  }
};
