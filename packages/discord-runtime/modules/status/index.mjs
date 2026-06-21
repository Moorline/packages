import manifest from '../../manifest.json' with { type: 'json' };
import { discordAction, reply } from '../shared.mjs';

function statusEmbed(input) {
  return {
    title: 'Moorline Status',
    color: input.acceptingNewWork ? 0x2ecc71 : 0xf1c40f,
    fields: [
      { name: 'Uptime', value: `${input.uptimeSeconds}s`, inline: true },
      { name: 'Accepting Work', value: input.acceptingNewWork ? 'Yes' : 'No', inline: true },
      { name: 'Open Sessions', value: String(input.openSessions), inline: true },
      { name: 'Running', value: String(input.runningSessions), inline: true },
      { name: 'Waiting', value: String(input.waitingSessions), inline: true },
      { name: 'Provider', value: input.providerLabel ?? 'unknown', inline: true }
    ],
    timestamp: new Date().toISOString()
  };
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
        'Show Moorline runtime status',
        undefined,
        undefined,
        undefined,
        { allowedWhileDraining: true }
      )
    ];
  },
  async onAction(event, context) {
    if (event.actionId !== 'runtime.status') {
      return { handled: false };
    }

    const runtimeStatus = context.getRuntimeStatus();
    const controlStatus = context.getRuntimeControlStatus();
    const providerDiagnostics = context.getProviderDiagnostics();
    return await reply(event, {
      content: 'Moorline runtime status',
      embeds: [
        statusEmbed({
          uptimeSeconds: runtimeStatus.uptimeSeconds,
          acceptingNewWork: controlStatus.acceptingNewWork,
          openSessions: runtimeStatus.openSessions,
          runningSessions: runtimeStatus.runningSessions,
          waitingSessions: runtimeStatus.waitingSessions,
          providerLabel: providerDiagnostics.accountLabel
        })
      ],
      ephemeral: true
    });
  }
};
