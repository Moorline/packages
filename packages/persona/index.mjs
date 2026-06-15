import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  insertSoulEntryAfter,
  parseSoulDocument,
  removeSoulEntry,
  replaceSoulEntry,
  stringifySoulDocument
} from './soul-document.mjs';
import manifest from './manifest.json' with { type: 'json' };

const systemPrompt = readFile(new URL('./system-prompt.md', import.meta.url), 'utf8').then((value) => value.trim());
const defaultSoul = readFile(new URL('./SOUL.md', import.meta.url), 'utf8');

function mutableSoulPath(context) {
  const runtimeRoot = typeof context.config?.runtimeRoot === 'string' ? context.config.runtimeRoot : '';
  if (!runtimeRoot) {
    throw new Error('runtimeRoot is required to edit the persona SOUL.md asset.');
  }
  return join(runtimeRoot, 'packages', 'plugins', 'rync', 'persona', 'SOUL.md');
}

async function readSoul(context) {
  const runtimeRoot = typeof context.config?.runtimeRoot === 'string' ? context.config.runtimeRoot : '';
  if (!runtimeRoot) {
    return (await defaultSoul).trim();
  }
  try {
    return (await readFile(pathToFileURL(join(runtimeRoot, 'packages', 'plugins', 'rync', 'persona', 'SOUL.md')), 'utf8')).trim();
  } catch {
    return (await defaultSoul).trim();
  }
}

async function readMutableSoul(context) {
  try {
    return await readFile(mutableSoulPath(context), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return await defaultSoul;
    }
    throw error;
  }
}

async function writeMutableSoul(context, content) {
  const path = mutableSoulPath(context);
  await mkdir(dirname(path), { recursive: true });
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  await writeFile(path, normalized, { mode: 0o600 });
  return path;
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required.`);
  }
  return value.trim();
}

function validateSoulEditInput(input) {
  const action = requireNonEmptyString(input.action, 'action');
  const reason = requireNonEmptyString(input.reason, 'reason');

  switch (action) {
    case 'replace':
      return {
        action,
        reason,
        key: requireNonEmptyString(input.key, 'key'),
        text: requireNonEmptyString(input.text, 'text')
      };
    case 'insert_after':
      return {
        action,
        reason,
        afterKey: requireNonEmptyString(input.after_key, 'after_key'),
        newKey: requireNonEmptyString(input.new_key, 'new_key'),
        text: requireNonEmptyString(input.text, 'text')
      };
    case 'remove':
      return {
        action,
        reason,
        key: requireNonEmptyString(input.key, 'key')
      };
    default:
      throw new Error('action must be replace, insert_after, or remove.');
  }
}

export default {
  id: manifest.id,
  manifest,
  tools() {
    return [
      {
        name: 'edit_soul',
        description: 'Edit specific numbered SOUL.md entries to reflect durable user interaction preferences and conversational style guidance.',
        inputSchema: {
          type: 'object',
          oneOf: [
            {
              type: 'object',
              properties: {
                action: {
                  const: 'replace',
                  description: 'Replace an existing SOUL entry by key.'
                },
                key: {
                  type: 'string',
                  description: 'Existing SOUL key to replace.'
                },
                text: {
                  type: 'string',
                  description: 'Replacement SOUL text.'
                },
                reason: {
                  type: 'string',
                  description: 'Internal note describing the durable preference or pattern behind the update.'
                }
              },
              required: ['action', 'key', 'text', 'reason'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: {
                action: {
                  const: 'insert_after',
                  description: 'Insert a new SOUL entry after an existing key.'
                },
                after_key: {
                  type: 'string',
                  description: 'Existing SOUL key after which to insert a new entry.'
                },
                new_key: {
                  type: 'string',
                  description: 'New SOUL key for the inserted entry.'
                },
                text: {
                  type: 'string',
                  description: 'Inserted SOUL text.'
                },
                reason: {
                  type: 'string',
                  description: 'Internal note describing the durable preference or pattern behind the update.'
                }
              },
              required: ['action', 'after_key', 'new_key', 'text', 'reason'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: {
                action: {
                  const: 'remove',
                  description: 'Remove an existing SOUL entry by key.'
                },
                key: {
                  type: 'string',
                  description: 'Existing SOUL key to remove.'
                },
                reason: {
                  type: 'string',
                  description: 'Internal note describing the durable preference or pattern behind the update.'
                }
              },
              required: ['action', 'key', 'reason'],
              additionalProperties: false
            }
          ],
          properties: {
            action: {
              type: 'string',
              enum: ['replace', 'insert_after', 'remove']
            },
            key: {
              type: 'string'
            },
            after_key: {
              type: 'string'
            },
            new_key: {
              type: 'string'
            },
            text: {
              type: 'string'
            },
            reason: {
              type: 'string'
            }
          },
          additionalProperties: false
        },
        requiredCapability: 'fs.write',
        execute: async (input, context) => {
          const edit = validateSoulEditInput(input);
          const current = parseSoulDocument(await readMutableSoul(context));
          let next = current;

          switch (edit.action) {
            case 'replace':
              next = replaceSoulEntry(current, edit.key, edit.text);
              break;
            case 'insert_after':
              next = insertSoulEntryAfter(current, edit.afterKey, edit.newKey, edit.text);
              break;
            case 'remove':
              next = removeSoulEntry(current, edit.key);
              break;
          }

          const path = await writeMutableSoul(context, stringifySoulDocument(next));
          context.appendAuditEvent('api.soul.edited', {
            action: 'edit_soul',
            target: path,
            editAction: edit.action
          });

          return {
            content: [
              `Updated SOUL.md: ${path}`,
              `Action: ${edit.action}`,
              `Reason: ${edit.reason}`,
              'This update is internal guidance. Do not mention it to the user unless they explicitly ask about internal prompt or persona files.'
            ].join('\n')
          };
        }
      }
    ];
  },
  async contributeAgentContext(_input, context) {
    const soul = await readSoul(context);
    return {
      systemPromptSections: [
        await systemPrompt,
        ...(soul ? [soul] : []),
        'You may silently use edit_soul to refine your own SOUL.md when you notice durable user preferences about tone, structure, style, or recurring interaction patterns.',
        'SOUL.md is a numbered list with stable bracketed keys. Prefer replacing an existing keyed entry over inserting a new one unless the preference is genuinely new.',
        'Only use edit_soul for persistent guidance that should shape future conversations. Do not use it for one-off task instructions, temporary requests, or narrow implementation details.',
        'If you use edit_soul, do it silently in the background and do not mention the update to the user unless they explicitly ask about internal persona changes.'
      ]
    };
  }
};
