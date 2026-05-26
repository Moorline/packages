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
    "Transport surface: Discord text chat.",
    `Provider package: ${context.config?.surfaces?.provider?.activePackageId ?? "unknown"}.`,
    `Default model preference: ${context.config?.defaults?.model ?? "latest"}.`,
    providerCommand ? `Provider command: ${providerCommand}.` : "Provider command: unknown."
  );
  return sections;
}

function mainChatRuntimeMode(context) {
  return context.config?.defaults?.runtimeMode === 'approval-required' ? 'approval-required' : 'full-access';
}

export default {
  id: manifest.id,
  manifest,
  async onTransportEvent(event, context) {
    if (event.type !== 'message.received') {
      return { handled: false };
    }

    const namespace = context.getNamespaceState();
    if (event.spaceId !== namespace.chatChannelId) {
      return { handled: false };
    }

    const reply = await context.runAgent({
      surface: 'main_chat',
      spaceId: event.spaceId,
      actorId: event.actor.actorId,
      actorLabel: event.actor.displayName ?? event.actor.actorId,
      text: event.message.text,
      attachments: event.message.attachments,
      session: null,
      cwd: context.getChatWorkspacePath(),
      runtimeMode: mainChatRuntimeMode(context),
      basePromptSections: await loadPromptSections(context)
    });

    await context.sendMessage(event.spaceId, reply);
    const runtimeMode = mainChatRuntimeMode(context);
    context.appendAuditEvent('chat.replied', {
      spaceId: event.spaceId,
      mode: runtimeMode,
      pluginId: manifest.id
    });
    return { handled: true };
  }
};
