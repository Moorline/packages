import manifest from './manifest.json' with { type: 'json' };
import adminControl from './modules/admin-control/index.mjs';
import channelLifecycle from './modules/channel-lifecycle/index.mjs';
import routing from './modules/routing/index.mjs';
import sessionCommands from './modules/session-commands/index.mjs';
import status from './modules/status/index.mjs';

const modules = [
  adminControl,
  channelLifecycle,
  routing,
  sessionCommands,
  status
];

async function firstHandled(hook, args) {
  for (const module of modules) {
    const handler = module[hook];
    if (typeof handler !== 'function') {
      continue;
    }
    const result = await handler(...args);
    if (result?.handled) {
      return result;
    }
  }
  return { handled: false };
}

export default {
  id: manifest.id,
  manifest,
  actions() {
    return modules.flatMap((module) => typeof module.actions === 'function' ? module.actions() : []);
  },
  async onAction(event, context) {
    return await firstHandled('onAction', [event, context]);
  },
  async onDomainEvent(event, context) {
    return await firstHandled('onDomainEvent', [event, context]);
  },
  async onTransportEvent(event, context) {
    return await firstHandled('onTransportEvent', [event, context]);
  }
};
