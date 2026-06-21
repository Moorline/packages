import { ChannelType, Client, GatewayIntentBits, PermissionsBitField, PermissionFlagsBits, Partials, type GuildBasedChannel, type TextChannel } from 'discord.js';
import type { RuntimeInputImageAttachment, RuntimePermissionOverwrite, DiscordChannelRecord } from './discordInstaller.js';

export function asChannelRecord(channel: GuildBasedChannel): DiscordChannelRecord | null {
  if (channel.type === ChannelType.GuildCategory) {
    return {
      id: channel.id,
      name: channel.name,
      type: 'category',
      parentId: null
    };
  }

  if (channel.type === ChannelType.GuildText) {
    return {
      id: channel.id,
      name: channel.name,
      type: 'text',
      parentId: channel.parentId
    };
  }

  if (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  ) {
    return {
      id: channel.id,
      name: channel.name,
      type: 'thread',
      parentId: channel.parentId
    };
  }

  return null;
}

export function extractImageAttachments(message: {
  attachments?: {
    values(): Iterable<{
      url: string;
      name: string | null;
      contentType: string | null;
      size: number;
      width: number | null;
      height: number | null;
    }>;
  };
}): RuntimeInputImageAttachment[] {
  const attachments = message.attachments ? Array.from(message.attachments.values()) : [];
  return attachments
    .filter((attachment) => attachment.contentType?.startsWith('image/') || attachment.width !== null)
    .map((attachment) => ({
      url: attachment.url,
      ...(attachment.name ? { filename: attachment.name } : {}),
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      ...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
      ...(attachment.width !== null ? { width: attachment.width } : {}),
      ...(attachment.height !== null ? { height: attachment.height } : {})
    }));
}

export function toDiscordPermissionOverwrites(
  guildId: string,
  overwrites: RuntimePermissionOverwrite[] | undefined
): Array<{
  id: string;
  allow: PermissionsBitField;
  deny: PermissionsBitField;
}> | undefined {
  if (!overwrites || overwrites.length === 0) {
    return undefined;
  }

  const resolvePermissionFlag = (permission: string): bigint => {
    const resolved = PermissionFlagsBits[permission as keyof typeof PermissionFlagsBits];
    if (typeof resolved !== 'bigint') {
      throw new Error(`Unknown Discord permission flag: ${permission}`);
    }
    return resolved;
  };

  return overwrites.map((overwrite) => ({
    id: overwrite.subject === 'everyone' ? guildId : overwrite.subjectId!,
    allow: new PermissionsBitField(overwrite.allowPermissions.map(resolvePermissionFlag)),
    deny: new PermissionsBitField(overwrite.denyPermissions.map(resolvePermissionFlag))
  }));
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel]
  });
}

export function extractMemberRoleIds(member: unknown): string[] {
  if (!member || typeof member !== 'object' || !('roles' in member)) {
    return [];
  }

  const roles = member.roles;
  if (Array.isArray(roles)) {
    return roles.filter((roleId): roleId is string => typeof roleId === 'string');
  }

  if (!roles || typeof roles !== 'object' || !('cache' in roles)) {
    return [];
  }

  const cache = roles.cache;
  if (cache && typeof cache === 'object' && typeof (cache as { map?: unknown }).map === 'function') {
    return (cache as { map(callback: (role: { id: string }) => string): string[] }).map((role) => role.id);
  }

  if (cache && typeof cache === 'object' && typeof (cache as { values?: unknown }).values === 'function') {
    return Array.from((cache as { values(): Iterable<{ id: string }> }).values(), (role) => role.id);
  }

  return [];
}

export function assertTextChannel(channel: GuildBasedChannel | null, channelId: string): TextChannel {
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(`Managed text channel not found: ${channelId}`);
  }
  return channel as TextChannel;
}

export function sortCommandOptions<
  T extends {
    required?: boolean;
  }
>(options: readonly T[] | undefined): T[] {
  return [...(options ?? [])].sort((left, right) => {
    const leftRequired = left.required === true;
    const rightRequired = right.required === true;
    if (leftRequired === rightRequired) {
      return 0;
    }
    return leftRequired ? -1 : 1;
  });
}

interface StringOptionNode {
  name: string;
  value?: unknown;
  options?: readonly StringOptionNode[];
}

export function collectStringOptions(items: readonly StringOptionNode[]): Record<string, string> {
  const collected: Record<string, string> = {};

  const visit = (entries: readonly StringOptionNode[]): void => {
    for (const entry of entries) {
      if (typeof entry.value === 'string') {
        collected[entry.name] = entry.value;
      }
      if (entry.options) {
        visit(entry.options);
      }
    }
  };

  visit(items);
  return collected;
}
