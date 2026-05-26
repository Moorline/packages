import { readFile } from 'node:fs/promises';

const promptCache = new Map();

function isMutablePromptDocument(url) {
  return url.pathname.endsWith('/SOUL.md');
}

async function readPromptDocument(url) {
  const href = url.href;
  if (!isMutablePromptDocument(url)) {
    const cached = promptCache.get(href);
    if (cached) {
      return cached;
    }
  }

  const content = (await readFile(url, 'utf8')).trim();
  if (!isMutablePromptDocument(url)) {
    promptCache.set(href, content);
  }
  return content;
}

export async function loadPromptSections(input) {
  const sections = [];

  for (const relativePath of input.relativePaths) {
    sections.push(await readPromptDocument(new globalThis.URL(relativePath, input.fromUrl)));
  }

  if (input.dynamicSections) {
    for (const section of input.dynamicSections) {
      const trimmed = section.trim();
      if (trimmed) {
        sections.push(trimmed);
      }
    }
  }

  return sections;
}
