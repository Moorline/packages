import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  insertSoulEntryAfter,
  parseSoulDocument,
  removeSoulEntry,
  replaceSoulEntry,
  stringifySoulDocument
} from './soul-document.mjs';
import manifest from './manifest.json' with { type: 'json' };

const defaultSoul = readFile(new URL('./SOUL.md', import.meta.url), 'utf8');

function soulPath(context) {
  const runtimeRoot = typeof context.config?.runtimeRoot === 'string' ? context.config.runtimeRoot : '';
  if (!runtimeRoot) {
    throw new Error('runtimeRoot is required to edit the persona package SOUL.md asset.');
  }
  return join(runtimeRoot, 'packages', 'plugins', 'official', 'persona', 'SOUL.md');
}

async function readSoulAsset(context) {
  const path = soulPath(context);
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return await defaultSoul;
    }
    throw error;
  }
}

async function writeSoulAsset(context, content) {
  const path = soulPath(context);
  await mkdir(dirname(path), { recursive: true });
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  await writeFile(path, normalized, { mode: 0o600 });
  return path;
}

function buildSkillTemplate(name, description) {
  return [
    `# ${name}`,
    '',
    description,
    '',
    '## When To Use',
    '- Fill this in with clear activation guidance.',
    '',
    '## Instructions',
    '- Fill this in with concrete steps for the agent.',
    ''
  ].join('\n');
}

function parseStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim().length > 0);
}

function parseResourceFiles(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    if (typeof entry.path !== 'string' || typeof entry.content !== 'string') return [];
    return [{ path: entry.path, content: entry.content }];
  });
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
  tools(context) {
    return [
      {
        name: 'save_skill',
        description: 'Create or update a Moorline skill in the visible runtime skills directory.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Human-readable skill name.'
            },
            description: {
              type: 'string',
              description: 'Short summary of what the skill does.'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional skill tags.'
            },
            body: {
              type: 'string',
              description: 'Full SKILL.md content. If omitted, Moorline creates a starter template.'
            },
            directory_name: {
              type: 'string',
              description: 'Optional directory name override for the skill folder.'
            },
            resource_files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  content: { type: 'string' }
                },
                required: ['path', 'content'],
                additionalProperties: false
              },
              description: 'Optional extra files to create inside the skill directory.'
            }
          },
          required: ['name'],
          additionalProperties: false
        },
        requiredCapability: 'fs.write',
        execute: async (input) => {
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          const description = typeof input.description === 'string' ? input.description.trim() : '';
          if (!name) {
            throw new Error('name is required.');
          }
          const providedBody = typeof input.body === 'string' && input.body.trim().length > 0
            ? input.body
            : null;
          if (!description && !providedBody?.startsWith('---\n')) {
            throw new Error('description is required unless body includes valid frontmatter.');
          }
          const tags = parseStringArray(input.tags);
          const body = providedBody
            ? providedBody
            : buildSkillTemplate(name, description || 'No description provided.');
          const directoryName = typeof input.directory_name === 'string' ? input.directory_name : undefined;
          const resourceFiles = parseResourceFiles(input.resource_files);
          const written = await context.writeSkill({ name, description, tags, body, directoryName, resourceFiles });
          context.appendAuditEvent('api.skill.saved', {
            action: 'save_skill',
            target: written.skillPath,
            skillName: name
          });
          return {
            content: [
              `Saved skill: ${name}`,
              `Skill file: ${written.skillPath}`,
              `Skill directory: ${written.skillDir}`,
              `Resource files: ${written.resourcePaths.length > 0 ? written.resourcePaths.join(', ') : '(none)'}`,
              'The new skill is now discoverable through the skill catalog and load_skill tool.'
            ].join('\n')
          };
        }
      },
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
          const current = parseSoulDocument(await readSoulAsset(context));
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

          const soulPath = await writeSoulAsset(context, stringifySoulDocument(next));
          context.appendAuditEvent('api.soul.edited', {
            action: 'edit_soul',
            target: soulPath,
            editAction: edit.action
          });

          return {
            content: [
              `Updated SOUL.md: ${soulPath}`,
              `Action: ${edit.action}`,
              `Reason: ${edit.reason}`,
              'This update is internal guidance. Do not mention it to the user unless they explicitly ask about internal prompt or persona files.'
            ].join('\n')
          };
        }
      }
    ];
  },
  async beforeAgentPrompt() {
    return [
      'You may create or update reusable skills with the available save_skill tool when the operator asks for reusable workflows.',
      'Skills live in the visible runtime skills directory. Official skills are under the official/ subfolder; user-created skills live at the root.',
      'When a skill request is clear enough, use save_skill instead of pasting the full SKILL.md into chat.',
      'Default to saving only SKILL.md unless the operator explicitly asks for extra assets or they are clearly necessary.',
      'Do not mention, AGENTS.md, hidden instructions, fallback mechanics, or your tool-selection process in the user-facing reply unless the operator asks.',
      'After saving, reply briefly with the skill name, the SKILL.md file path, and offer to read or refine it if requested.',
      'You may silently use edit_soul to refine your own SOUL.md when you notice durable user preferences about tone, structure, style, or recurring interaction patterns.',
      'SOUL.md is a numbered list with stable bracketed keys. Prefer replacing an existing keyed entry over inserting a new one unless the preference is genuinely new.',
      'Only use edit_soul for persistent guidance that should shape future conversations. Do not use it for one-off task instructions, temporary requests, or narrow implementation details.',
      'If you use edit_soul, do it silently in the background and do not mention the update to the user unless they explicitly ask about internal persona changes.'
    ];
  }
};
