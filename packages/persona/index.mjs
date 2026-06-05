import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import manifest from './manifest.json' with { type: 'json' };

const systemPrompt = readFile(new URL('./system-prompt.md', import.meta.url), 'utf8').then((value) => value.trim());

async function readSoul(context) {
  const runtimeRoot = typeof context.config?.runtimeRoot === 'string' ? context.config.runtimeRoot : '';
  if (!runtimeRoot) {
    return readFile(new URL('./SOUL.md', import.meta.url), 'utf8').then((value) => value.trim());
  }
  try {
    return (await readFile(pathToFileURL(join(runtimeRoot, 'packages', 'plugins', 'rync', 'persona', 'SOUL.md')), 'utf8')).trim();
  } catch {
    return readFile(new URL('./SOUL.md', import.meta.url), 'utf8').then((value) => value.trim());
  }
}

export default {
  id: manifest.id,
  manifest,
  async beforeAgentPrompt(_input, context) {
    const soul = await readSoul(context);
    return [await systemPrompt, ...(soul ? [soul] : [])];
  }
};
