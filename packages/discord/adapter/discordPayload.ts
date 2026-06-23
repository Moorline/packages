import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type AttachmentPayload } from 'discord.js';
import { basename } from 'node:path';
import type { RuntimeActionReference, RuntimeAttachmentPayload, RuntimeMessagePayload } from '@moorline/contracts';
import type { DiscordButtonPayload, DiscordEmbedPayload, DiscordMessagePayload } from './discordInstaller.js';

export const DISCORD_EPHEMERAL_FLAG = 64;
export const DISCORD_CONTENT_LIMIT = 2000;

function sanitizeDiscordText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((\/[^)]+)\)/g, '$1 ($2)')
    .replace(/file:\/\/\S+/g, (match) => match.replace(/^file:\/\//, ''));
}

export function sanitizeDiscordPayload(payload: Pick<DiscordMessagePayload, 'content' | 'embeds'>): Pick<DiscordMessagePayload, 'content' | 'embeds'> {
  return {
    ...(payload.content ? { content: sanitizeDiscordText(payload.content) } : {}),
    ...(payload.embeds
      ? {
          embeds: payload.embeds.map((embed) => ({
            ...embed,
            ...(embed.description ? { description: sanitizeDiscordText(embed.description) } : {}),
            ...(embed.fields
              ? {
                  fields: embed.fields.map((field) => ({
                    ...field,
                    value: sanitizeDiscordText(field.value)
                  }))
                }
              : {})
          }))
        }
      : {})
  };
}
export function toDiscordFiles(payload: Pick<DiscordMessagePayload, 'files'>): AttachmentPayload[] | undefined {
  if (!payload.files || payload.files.length === 0) {
    return undefined;
  }

  return payload.files.map((file) => ({
    attachment: file.path,
    name: file.name ?? basename(file.path),
    ...(file.description ? { description: file.description } : {})
  }));
}

function toDiscordButtonStyle(style: DiscordButtonPayload['style']): ButtonStyle {
  switch (style) {
    case 'primary':
      return ButtonStyle.Primary;
    case 'success':
      return ButtonStyle.Success;
    case 'danger':
      return ButtonStyle.Danger;
    case 'secondary':
    default:
      return ButtonStyle.Secondary;
  }
}

export function toDiscordComponents(payload: Pick<DiscordMessagePayload, 'buttons'>) {
  if (!payload.buttons || payload.buttons.length === 0) {
    return undefined;
  }

  const rows: Array<ActionRowBuilder<ButtonBuilder>> = [];
  for (let index = 0; index < payload.buttons.length; index += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const button of payload.buttons.slice(index, index + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(button.id)
          .setLabel(button.label)
          .setStyle(toDiscordButtonStyle(button.style))
          .setDisabled(button.disabled ?? false)
      );
    }
    rows.push(row);
  }

  return rows;
}

function splitDiscordContent(content: string, limit = DISCORD_CONTENT_LIMIT): string[] {
  if (content.length <= limit) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const boundaries = [
      window.lastIndexOf('\n\n', limit),
      window.lastIndexOf('\n', limit),
      window.lastIndexOf(' ', limit)
    ].filter((index) => index > 0);
    const splitAt = boundaries.length > 0 ? Math.max(...boundaries) : limit;
    const chunk = remaining.slice(0, splitAt).trimEnd();
    chunks.push(chunk.length > 0 ? chunk : remaining.slice(0, limit));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

export function toDiscordSendPayloads(payload: DiscordMessagePayload): DiscordMessagePayload[] {
  const content = payload.content;
  if (!content || content.length <= DISCORD_CONTENT_LIMIT) {
    return [payload];
  }
  const chunks = splitDiscordContent(content);
  return chunks.map((chunk, index) => {
    if (index === 0) {
      return {
        ...payload,
        content: chunk
      };
    }
    return {
      content: chunk,
      ...(payload.ephemeral !== undefined ? { ephemeral: payload.ephemeral } : {}),
      ...(payload.flags !== undefined ? { flags: payload.flags } : {})
    };
  });
}

export function resolveReplyFlags(input: { ephemeral?: boolean; flags?: number }): { flags?: number } {
  if (input.flags !== undefined) {
    return { flags: input.flags };
  }

  return input.ephemeral === true ? { flags: DISCORD_EPHEMERAL_FLAG } : {};
}

function renderBlockText(payload: RuntimeMessagePayload): string | undefined {
  const segments = [
    payload.text,
    ...(payload.blocks ?? []).flatMap((block) => {
      if (block.kind === 'fields') {
        return [
          block.title,
          ...(block.fields ?? []).map((field) => `${field.label}: ${field.value}`)
        ];
      }
      return [block.title, block.text];
    })
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());

  return segments.length > 0 ? segments.join('\n\n') : undefined;
}

function blockToneColor(tone: 'default' | 'info' | 'success' | 'warning' | 'danger' | undefined): number | undefined {
  switch (tone) {
    case 'info':
      return 0x3498db;
    case 'success':
      return 0x2ecc71;
    case 'warning':
      return 0xf1c40f;
    case 'danger':
      return 0xe74c3c;
    default:
      return undefined;
  }
}

function toDiscordEmbedsFromBlocks(blocks: RuntimeMessagePayload['blocks']): DiscordEmbedPayload[] | undefined {
  if (!blocks || blocks.length === 0) {
    return undefined;
  }

  const embeds = blocks.map((block) => ({
    ...(block.title ? { title: block.title } : {}),
    ...(block.text ? { description: block.text } : {}),
    ...(block.fields
      ? {
          fields: block.fields.map((field) => ({
            name: field.label,
            value: field.value,
            ...(field.inline !== undefined ? { inline: field.inline } : {})
          }))
        }
      : {}),
    ...(blockToneColor(block.tone) ? { color: blockToneColor(block.tone) } : {})
  }));

  return embeds.length > 0 ? embeds : undefined;
}

function toDiscordFilesFromAttachments(attachments: RuntimeAttachmentPayload[] | undefined): DiscordMessagePayload['files'] | undefined {
  const files = (attachments ?? [])
    .filter((attachment) => !!attachment.path)
    .map((attachment) => ({
      path: attachment.path!,
      ...(attachment.name ? { name: attachment.name } : {}),
      ...(attachment.description ? { description: attachment.description } : {})
    }));
  return files.length > 0 ? files : undefined;
}

function toDiscordButtonsFromActions(actions: RuntimeActionReference[] | undefined): DiscordButtonPayload[] | undefined {
  if (!actions || actions.length === 0) {
    return undefined;
  }

  return actions.map((action) => ({
    id: action.actionId,
    label: action.label,
    style: action.style ?? 'secondary',
    ...(action.disabled !== undefined ? { disabled: action.disabled } : {})
  }));
}

export function toDiscordPayload(payload: RuntimeMessagePayload): DiscordMessagePayload {
  return {
    ...(renderBlockText(payload) ? { content: renderBlockText(payload) } : {}),
    ...(toDiscordEmbedsFromBlocks(payload.blocks) ? { embeds: toDiscordEmbedsFromBlocks(payload.blocks) } : {}),
    ...(toDiscordFilesFromAttachments(payload.attachments) ? { files: toDiscordFilesFromAttachments(payload.attachments) } : {}),
    ...(toDiscordButtonsFromActions(payload.actions) ? { buttons: toDiscordButtonsFromActions(payload.actions) } : {})
  };
}
