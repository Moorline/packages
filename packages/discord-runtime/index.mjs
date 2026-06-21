import manifest from './manifest.json' with { type: 'json' };
import routing from './modules/routing/index.mjs';
import status from './modules/status/index.mjs';

const modules = [
  routing,
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
  async onTransportIntent(intent, context) {
    return await firstHandled('onTransportIntent', [intent, context]);
  }
};
