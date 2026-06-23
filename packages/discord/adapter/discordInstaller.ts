import {
  ChannelType,
  Client,
  Events,
  PermissionFlagsBits,
  type GuildBasedChannel,
  type TextChannel
} from 'discord.js';
import { URLSearchParams } from 'node:url';
import type {
  RuntimeActionDefinition,
  RuntimeActorIdentity,
  RuntimeCreateTransportResourceInput,
  RuntimeDeleteTransportResourceInput,
  RuntimeMessagePayload,
  RuntimeMessageReceipt,
  RuntimeMessageTarget,
  RuntimeNativeActionRegistration,
  RuntimeScopeId,
  RuntimeSurfaceBootstrapInput,
  RuntimeSurfaceState,
  RuntimeTransport,
  RuntimeTransportAccessInput,
  RuntimeTransportActivityInput,
  RuntimeTransportAuth,
  RuntimeTransportCapabilities,
  RuntimeTransportEffect,
  RuntimeTransportEffectReceipt,
  RuntimeTransportIntent,
  RuntimeTransportResourceRecord,
  RuntimeUpdateTransportResourceInput,
  RuntimeTransportVerification,
} from '@moorline/contracts';
import {
  DISCORD_EPHEMERAL_FLAG,
  resolveReplyFlags,
  sanitizeDiscordPayload,
  toDiscordComponents,
  toDiscordFiles,
  toDiscordPayload,
  toDiscordSendPayloads
} from './discordPayload.js';
import {
  asChannelRecord,
  assertTextChannel,
  collectStringOptions,
  createDiscordClient,
  extractImageAttachments,
  extractMemberRoleIds,
  sortCommandOptions,
  toDiscordPermissionOverwrites
} from './discordMapping.js';

export const REQUIRED_DISCORD_PERMISSIONS = '268528720';
const DISCORD_START_CHANNEL_NAME = 'moorline-start';
const DISCORD_ACTIVITY_RENDER_INTERVAL_MS = 8_000;
const DEFAULT_ACTIVITY_LEASE_MS = 15_000;

export interface RuntimePermissionOverwrite {
  subject: 'everyone' | 'role' | 'member';
  subjectId?: string;
  allowPermissions: string[];
  denyPermissions: string[];
}

export interface RuntimeInputImageAttachment {
  url: string;
  filename?: string;
  contentType?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface DiscordChannelRecord {
  id: string;
  name: string;
  type: 'text' | 'category' | 'thread';
  parentId: string | null;
}

export interface DiscordCommandDefinition {
  name: string;
  description: string;
  options?: Array<{
    type?: 'string';
    name: string;
    description: string;
    required?: boolean;
    choices?: Array<{ name: string; value: string }>;
  }>;
  subcommands?: Array<{
    name: string;
    description: string;
    options?: Array<{
      type?: 'string';
      name: string;
      description: string;
      required?: boolean;
      choices?: Array<{ name: string; value: string }>;
    }>;
  }>;
}

export interface DiscordEmbedPayload {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
}

export interface DiscordButtonPayload {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
  disabled?: boolean;
}

export interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbedPayload[];
  files?: Array<{ path: string; name?: string; description?: string }>;
  buttons?: DiscordButtonPayload[];
  ephemeral?: boolean;
  flags?: number;
}

export type DiscordMessageReceipt = RuntimeMessageReceipt;

export interface DiscordVerificationResult extends RuntimeTransportVerification {
  guildId: string;
  guildName: string;
  botUserId: string;
  botUsername: string;
}

export interface DiscordMessageEvent {
  scopeId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  channel: DiscordChannelRecord | null;
  authorId: string;
  authorUsername: string;
  authorGlobalName: string | null;
  authorDisplayName: string | null;
  authorLabel: string;
  authorMention: string;
  content: string;
  attachments: RuntimeInputImageAttachment[];
  memberRoleIds: string[];
  isTransportAdmin: boolean;
  bot: boolean;
}

export interface SlashCommandEvent {
  scopeId: string;
  guildId: string;
  channelId: string;
  interactionId: string;
  userId: string;
  userMention: string;
  memberRoleIds: string[];
  isTransportAdmin: boolean;
  commandName: string;
  subcommandName: string | null;
  options: Record<string, string>;
  defer(input?: { ephemeral?: boolean; flags?: number }): Promise<void>;
  reply(payload: DiscordMessagePayload): Promise<void>;
}

export interface DiscordNativeActionPayload {
  commandName?: string;
  subcommandName?: string | null;
  channelId?: string;
  messageId?: string;
  reply?(payload: DiscordMessagePayload): Promise<void>;
  defer?(input?: { ephemeral?: boolean; flags?: number }): Promise<void>;
}

export interface DiscordButtonInteractionEvent {
  scopeId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  memberRoleIds: string[];
  isTransportAdmin: boolean;
  buttonId: string;
  defer(input?: { ephemeral?: boolean; flags?: number }): Promise<void>;
  reply(payload: DiscordMessagePayload): Promise<void>;
}

export type DiscordTransportLifecycleEvent =
  | {
      kind: 'channel';
      action: 'created' | 'updated' | 'deleted';
      scopeId: string;
      guildId: string;
      channel: DiscordChannelRecord;
      previous?: DiscordChannelRecord;
    }
  | {
      kind: 'message';
      action: 'updated' | 'deleted' | 'bulk_deleted';
      scopeId: string;
      guildId: string;
      channelId: string;
      messageId?: string;
      messageIds?: string[];
      authorId?: string | null;
      content?: string | null;
      previousContent?: string | null;
    };

export interface DiscordOperator extends RuntimeTransport {
  registerCommands(scopeId: string, commands: DiscordCommandDefinition[]): Promise<void>;
  onMessage(handler: (event: DiscordMessageEvent) => Promise<void>): void;
  onSlashCommand(handler: (event: SlashCommandEvent) => Promise<void>): void;
  onButtonInteraction(handler: (event: DiscordButtonInteractionEvent) => Promise<void>): void;
  onLifecycleEvent(handler: (event: DiscordTransportLifecycleEvent) => Promise<void>): void;
  listChannels(scopeId: string): Promise<DiscordChannelRecord[]>;
  createCategory(scopeId: string, name: string, permissionOverwrites?: RuntimePermissionOverwrite[]): Promise<DiscordChannelRecord>;
  createTextChannel(
    scopeId: string,
    name: string,
    parentId: string | null,
    permissionOverwrites?: RuntimePermissionOverwrite[]
  ): Promise<DiscordChannelRecord>;
  updateChannel(
    scopeId: string,
    channelId: string,
    update: { name?: string; parentId?: string | null; permissionOverwrites?: RuntimePermissionOverwrite[] }
  ): Promise<DiscordChannelRecord>;
  deleteChannel(scopeId: string, channelId: string): Promise<void>;
  triggerTyping(channelId: string): Promise<void>;
}

interface DiscordListenerErrorContext {
  surface: 'message' | 'slash' | 'button' | 'lifecycle';
  guildId?: string;
  channelId?: string;
  commandName?: string;
}

interface DiscordRuntimeActionCommandMetadata {
  commandName: string;
  commandDescription: string;
  subcommandName?: string;
  subcommandDescription?: string;
  options?: DiscordCommandDefinition['options'];
}

interface DiscordActivityState {
  leases: Map<string, number>;
  interval: ReturnType<typeof globalThis.setInterval> | null;
}

const DISCORD_READY_TIMEOUT_MS_DEFAULT = 20_000;

export class DiscordReadyTimeoutError extends Error {
  readonly code = 'DISCORD_READY_TIMEOUT';
  constructor(readonly timeoutMs: number) {
    super(`Discord client did not emit ClientReady within ${timeoutMs}ms.`);
  }
}

function resolveDiscordReadyTimeoutMs(): number {
  const raw = process.env.MOORLINE_DISCORD_READY_TIMEOUT_MS;
  if (!raw) {
    return DISCORD_READY_TIMEOUT_MS_DEFAULT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('MOORLINE_DISCORD_READY_TIMEOUT_MS must be a positive integer when provided.');
  }
  return parsed;
}

export function buildDiscordInviteUrl(applicationId: string, permissions = REQUIRED_DISCORD_PERMISSIONS): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: 'bot applications.commands',
    permissions
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export class DiscordJsOperator implements DiscordOperator {
  private readonly client: Client;
  private static readonly EPHEMERAL_FLAG = DISCORD_EPHEMERAL_FLAG;
  private transportIntentHandler: ((intent: RuntimeTransportIntent) => Promise<void>) | null = null;
  private genericBindingsRegistered = false;
  private readonly nativeActionIdsByDiscordPath = new Map<string, string>();
  private readonly knownSessionChannelIds = new Set<string>();
  private readonly activityByChannelId = new Map<string, DiscordActivityState>();

  constructor(
    client = createDiscordClient(),
    private readonly onListenerError: (error: Error, context: DiscordListenerErrorContext) => void = (error) => {
      globalThis.console.error('[moorline:discord]', error);
    }
  ) {
    this.client = client;
  }

  capabilities(): RuntimeTransportCapabilities {
    return {
      nativeActions: true,
      resources: {
        list: false,
        create: false,
        update: false,
        delete: false
      },
      activity: true,
      presence: false,
      metadata: {
        packageId: 'rync/discord'
      }
    };
  }

  async verifyAccess(input: RuntimeTransportAccessInput): Promise<DiscordVerificationResult> {
    const probe = createDiscordClient();
    const authToken = input.authToken?.trim();
    if (!authToken) {
      throw new Error('Discord transport auth token is required');
    }

    try {
      await probe.login(authToken);
      const application = await probe.application?.fetch();
      if (!application?.id || !probe.user?.id) {
        throw new Error('Discord application metadata is unavailable');
      }

      const guild = await probe.guilds.fetch(input.scopeId);
      return {
        scopeId: guild.id,
        scopeName: guild.name,
        applicationId: application.id,
        actorId: probe.user.id,
        actorName: probe.user.username,
        guildId: guild.id,
        guildName: guild.name,
        botUserId: probe.user.id,
        botUsername: probe.user.username
      };
    } finally {
      probe.destroy();
    }
  }

  async start(auth: RuntimeTransportAuth): Promise<void> {
    if (!this.client.isReady()) {
      const token = auth.token?.trim();
      if (!token) {
        throw new Error('Discord transport auth token is required');
      }
      await this.client.login(token);
      await this.waitForReady();
    }
    const scopeId = typeof auth.metadata?.scopeId === 'string' ? auth.metadata.scopeId : undefined;
    if (scopeId) {
      await this.hydrateKnownSessionChannels(scopeId);
    }
  }

  async bootstrapSurface(input: RuntimeSurfaceBootstrapInput): Promise<Partial<RuntimeSurfaceState>> {
    if (!input.scopeId) {
      return {};
    }
    const startChannel = await this.ensureStartChannel(input.scopeId);
    return {
      scopeId: input.scopeId,
      surfaceId: input.scopeId,
      statusResourceId: startChannel.id,
      coordinationResourceId: startChannel.id,
      metadata: {
        startChannelName: startChannel.name
      }
    };
  }

  async stop(): Promise<void> {
    this.clearActivityState();
    this.client.destroy();
  }

  onIntent(handler: (intent: RuntimeTransportIntent) => Promise<void>): void {
    this.transportIntentHandler = handler;
    if (this.genericBindingsRegistered) {
      return;
    }

    this.genericBindingsRegistered = true;
    this.onMessage(async (event) => {
      if (event.bot) {
        return;
      }
      if (!this.isSessionTextChannel(event.channel) && !this.knownSessionChannelIds.has(event.channelId)) {
        return;
      }
      if (this.isSessionTextChannel(event.channel)) {
        this.knownSessionChannelIds.add(event.channel.id);
      }
      await this.transportIntentHandler?.({
        type: 'transport.message.received',
        intentId: `discord:message:${event.guildId}:${event.messageId}`,
        scopeId: event.scopeId,
        transportPackageId: 'rync/discord',
        occurredAt: new Date().toISOString(),
        transportResourceId: event.channelId,
        actor: this.toRuntimeActor({
          actorId: event.authorId,
          displayName: event.authorLabel,
          accessGroupIds: event.memberRoleIds,
          isSurfaceAdmin: event.isTransportAdmin
        }),
        message: {
          text: event.content,
          attachments: event.attachments.map((attachment) => ({
            kind: 'image',
            url: attachment.url,
            ...(attachment.filename ? { name: attachment.filename } : {}),
            ...(attachment.contentType ? { contentType: attachment.contentType } : {})
          }))
        }
      });
    });
    this.onSlashCommand(async (event) => {
      if (event.commandName !== 'status' || event.subcommandName) {
        await event.reply({
          content: 'Only `/status` is available in this Discord surface.',
          ephemeral: true
        });
        return;
      }
      const mappedActionId =
        this.nativeActionIdsByDiscordPath.get(this.discordActionPath(event.commandName, event.subcommandName)) ??
        `discord.command.${event.commandName}${event.subcommandName ? `.${event.subcommandName}` : ''}`;
      await this.transportIntentHandler?.({
        type: 'transport.action.invoked',
        intentId: `discord:command:${event.guildId}:${event.interactionId}`,
        scopeId: event.scopeId,
        transportPackageId: 'rync/discord',
        occurredAt: new Date().toISOString(),
        transportResourceId: event.channelId,
        actor: this.toRuntimeActor({
          actorId: event.userId,
          displayName: event.userMention,
          accessGroupIds: event.memberRoleIds,
          isSurfaceAdmin: event.isTransportAdmin
        }),
        actionId: mappedActionId,
        input: event.options,
        native: {
          kind: 'discord.slash_command',
          payload: {
            commandName: event.commandName,
            subcommandName: event.subcommandName,
            channelId: event.channelId,
            reply: event.reply,
            defer: event.defer
          }
        }
      });
    });
    this.onButtonInteraction(async (event) => {
      await event.reply({
        content: 'This Discord action is no longer available.',
        ephemeral: true
      });
    });
    this.onLifecycleEvent(async (event) => {
      if (event.kind !== 'channel') {
        return;
      }
      if (event.action === 'created') {
        if (!this.isSessionTextChannel(event.channel)) {
          return;
        }
        this.knownSessionChannelIds.add(event.channel.id);
        await this.emitSessionEnsureIntent(event, this.sessionEnsureIntentId('created', event.guildId, event.channel));
        return;
      }
      if (event.action === 'updated') {
        const wasSession = this.isSessionTextChannel(event.previous ?? null) || this.knownSessionChannelIds.has(event.channel.id);
        const isSession = this.isSessionTextChannel(event.channel);
        if (!isSession) {
          return;
        }
        this.knownSessionChannelIds.add(event.channel.id);
        if (!wasSession || event.previous?.parentId !== event.channel.parentId || event.previous?.name !== event.channel.name) {
          await this.emitSessionEnsureIntent(event, this.sessionEnsureIntentId('updated', event.guildId, event.channel));
        }
        return;
      }
      if (event.action === 'deleted') {
        const deletedChannelId = event.channel.id;
        if (!this.isSessionTextChannel(event.channel) && !this.knownSessionChannelIds.has(deletedChannelId)) {
          return;
        }
        this.knownSessionChannelIds.delete(deletedChannelId);
        await this.transportIntentHandler?.({
          type: 'transport.session.delete',
          intentId: `discord:channel.deleted:${event.guildId}:${deletedChannelId}`,
          scopeId: event.scopeId,
          transportPackageId: 'rync/discord',
          occurredAt: new Date().toISOString(),
          transportResourceId: deletedChannelId,
          reason: 'Discord text channel deleted',
          deleteWorkspace: true
        });
      }
    });
  }

  private async emitSessionEnsureIntent(event: Extract<DiscordTransportLifecycleEvent, { kind: 'channel' }>, intentId: string): Promise<void> {
    await this.transportIntentHandler?.({
      type: 'transport.session.ensure',
      intentId,
      scopeId: event.scopeId,
      transportPackageId: 'rync/discord',
      occurredAt: new Date().toISOString(),
      transportResourceId: event.channel.id,
      requestedName: event.channel.name,
      owner: {
        kind: 'work_item',
        id: event.channel.parentId ?? event.guildId,
        label: event.channel.parentId ? `Discord category ${event.channel.parentId}` : event.guildId
      }
    });
  }

  private sessionEnsureIntentId(reason: 'created' | 'updated', guildId: string, channel: DiscordChannelRecord): string {
    return [
      'discord:channel.ensure',
      reason,
      guildId,
      channel.id,
      channel.parentId ?? 'orphan',
      encodeURIComponent(channel.name)
    ].join(':');
  }

  async registerCommands(scopeId: string, commands: DiscordCommandDefinition[]): Promise<void> {
    const payload = commands.map((command) => ({
        name: command.name,
        description: command.description,
        options: [
          ...(command.options ?? []).map((option) => ({
            type: 3,
            name: option.name,
            description: option.description,
            required: option.required ?? false,
            choices: option.choices
          })),
          ...(command.subcommands ?? []).map((subcommand) => ({
            type: 1,
            name: subcommand.name,
            description: subcommand.description,
            options: sortCommandOptions(subcommand.options).map((option) => ({
              type: 3,
              name: option.name,
              description: option.description,
              required: option.required ?? false,
              choices: option.choices
            }))
          }))
        ]
      }));
    try {
      await this.waitForReady();
      const guild = await this.client.guilds.fetch(scopeId);
      await guild.commands.set(payload);
    } catch (error) {
      if (error instanceof Error) {
        const discordError = error as Error & {
          code?: unknown;
          method?: unknown;
          url?: unknown;
          requestBody?: { json?: unknown };
          rawError?: unknown;
        };
        const commandNames = payload.map((command) => command.name).join(', ');
        const detail = [
          `Discord command registration failed for guild ${scopeId}`,
          `commands: ${commandNames}`,
          discordError.code !== undefined ? `code: ${String(discordError.code)}` : null,
          discordError.method !== undefined ? `method: ${String(discordError.method)}` : null,
          discordError.url !== undefined ? `url: ${String(discordError.url)}` : null,
          discordError.rawError !== undefined ? `raw: ${JSON.stringify(discordError.rawError)}` : null,
          discordError.requestBody?.json !== undefined
            ? `body: ${JSON.stringify(discordError.requestBody.json).slice(0, 4000)}`
            : null
        ]
          .filter((entry): entry is string => entry !== null)
          .join('; ');
        throw new Error(`${error.message}; ${detail}`, { cause: error });
      }
      throw error;
    }
  }

  onMessage(handler: (event: DiscordMessageEvent) => Promise<void>): void {
    this.client.on(Events.MessageCreate, (message) => {
      if (!message.guildId) {
        return;
      }

      const authorDisplayName =
        message.member && 'displayName' in message.member && typeof message.member.displayName === 'string'
          ? message.member.displayName
          : null;

      void handler({
        scopeId: message.guildId,
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        channel: asChannelRecord(message.channel as GuildBasedChannel),
        authorId: message.author.id,
        authorUsername: message.author.username,
        authorGlobalName: message.author.globalName ?? null,
        authorDisplayName,
        authorLabel: authorDisplayName ?? message.author.globalName ?? message.author.username,
        authorMention: `<@${message.author.id}>`,
        content: message.content,
        attachments: extractImageAttachments(message),
        memberRoleIds: extractMemberRoleIds(message.member),
        isTransportAdmin: message.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ?? false,
        bot: message.author.bot
      }).catch((error: unknown) => {
        this.reportListenerFailure(error, {
          surface: 'message',
          guildId: message.guildId ?? undefined,
          channelId: message.channelId
        });
      });
    });
  }

  onSlashCommand(handler: (event: SlashCommandEvent) => Promise<void>): void {
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand() || !interaction.guildId) {
        return;
      }

      const userId = interaction.user?.id ?? 'unknown-user';
      void handler({
        scopeId: interaction.guildId,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        interactionId: interaction.id,
        userId,
        userMention: `<@${userId}>`,
        memberRoleIds: extractMemberRoleIds(interaction.member),
        isTransportAdmin: interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
        commandName: interaction.commandName,
        subcommandName: interaction.options.getSubcommand(false),
        options: collectStringOptions(interaction.options.data),
        defer: async ({ ephemeral, flags } = {}) => {
          await interaction.deferReply(resolveReplyFlags({ ephemeral, flags }));
        },
        reply: async ({ content, embeds, files, ephemeral, flags }) => {
          const sanitized = sanitizeDiscordPayload({ content, embeds });
          const discordFiles = toDiscordFiles({ files });
          if (interaction.deferred && !interaction.replied) {
            await interaction.editReply({
              ...sanitized,
              ...(discordFiles ? { files: discordFiles } : {})
            });
            return;
          }

          const payload = {
            ...sanitized,
            ...(discordFiles ? { files: discordFiles } : {}),
            ...resolveReplyFlags({ ephemeral, flags })
          };

          if (interaction.replied) {
            await interaction.followUp(payload);
            return;
          }

          await interaction.reply(payload);
        }
      }).catch(async (error: unknown) => {
        this.reportListenerFailure(error, {
          surface: 'slash',
          guildId: interaction.guildId ?? undefined,
          channelId: interaction.channelId ?? undefined,
          commandName: interaction.commandName
        });

        try {
          const payload = {
            content: 'Moorline hit an internal error while handling this command.',
            flags: DiscordJsOperator.EPHEMERAL_FLAG
          };
          const editPayload = {
            content: payload.content
          };

          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply(payload);
            return;
          }

          if (interaction.deferred && !interaction.replied) {
            await interaction.editReply(editPayload);
            return;
          }

          await interaction.followUp(payload);
        } catch (replyError) {
          this.reportListenerFailure(replyError, {
            surface: 'slash',
            guildId: interaction.guildId ?? undefined,
            channelId: interaction.channelId ?? undefined,
            commandName: interaction.commandName
          });
        }
      });
    });
  }

  onButtonInteraction(handler: (event: DiscordButtonInteractionEvent) => Promise<void>): void {
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isButton() || !interaction.guildId) {
        return;
      }

      const userId = interaction.user?.id ?? 'unknown-user';
      void handler({
        scopeId: interaction.guildId,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        messageId: interaction.message.id,
        userId,
        memberRoleIds: extractMemberRoleIds(interaction.member),
        isTransportAdmin: interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
        buttonId: interaction.customId,
        defer: async ({ ephemeral, flags } = {}) => {
          await interaction.deferReply(resolveReplyFlags({ ephemeral, flags }));
        },
        reply: async ({ content, embeds, files, buttons, ephemeral, flags }) => {
          const sanitized = sanitizeDiscordPayload({ content, embeds });
          const discordFiles = toDiscordFiles({ files });
          const components = toDiscordComponents({ buttons });
          if (interaction.deferred && !interaction.replied) {
            await interaction.editReply({
              ...sanitized,
              ...(discordFiles ? { files: discordFiles } : {}),
              ...(components ? { components } : {})
            });
            return;
          }

          const payload = {
            ...sanitized,
            ...(discordFiles ? { files: discordFiles } : {}),
            ...(components ? { components } : {}),
            ...resolveReplyFlags({ ephemeral, flags })
          };

          if (interaction.replied) {
            await interaction.followUp(payload);
            return;
          }

          await interaction.reply(payload);
        }
      }).catch(async (error: unknown) => {
        this.reportListenerFailure(error, {
          surface: 'button',
          guildId: interaction.guildId ?? undefined,
          channelId: interaction.channelId ?? undefined,
          commandName: interaction.customId
        });

        try {
          const payload = {
            content: 'Moorline hit an internal error while handling this action.',
            flags: DiscordJsOperator.EPHEMERAL_FLAG
          };
          const editPayload = {
            content: payload.content
          };

          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply(payload);
            return;
          }

          if (interaction.deferred && !interaction.replied) {
            await interaction.editReply(editPayload);
            return;
          }

          await interaction.followUp(payload);
        } catch (replyError) {
          this.reportListenerFailure(replyError, {
            surface: 'button',
            guildId: interaction.guildId ?? undefined,
            channelId: interaction.channelId ?? undefined,
            commandName: interaction.customId
          });
        }
      });
    });
  }

  onLifecycleEvent(handler: (event: DiscordTransportLifecycleEvent) => Promise<void>): void {
    this.client.on(Events.ChannelCreate, (channel) => {
      const record = asChannelRecord(channel);
      const guildId = 'guildId' in channel && typeof channel.guildId === 'string' ? channel.guildId : undefined;
      if (!record || !guildId) {
        return;
      }
      void handler({
        kind: 'channel',
        action: 'created',
        scopeId: guildId,
        guildId,
        channel: record
      }).catch((error: unknown) => {
        this.reportListenerFailure(error, {
          surface: 'lifecycle',
          guildId,
          channelId: record.id
        });
      });
    });

    this.client.on(Events.ChannelUpdate, (previous, current) => {
      const previousRecord = asChannelRecord(previous as GuildBasedChannel);
      const currentRecord = asChannelRecord(current as GuildBasedChannel);
      const guildId =
        ('guildId' in current && typeof current.guildId === 'string' ? current.guildId : undefined) ??
        ('guildId' in previous && typeof previous.guildId === 'string' ? previous.guildId : undefined);
      if (!currentRecord || !guildId) {
        return;
      }
      void handler({
        kind: 'channel',
        action: 'updated',
        scopeId: guildId,
        guildId,
        channel: currentRecord,
        ...(previousRecord ? { previous: previousRecord } : {})
      }).catch((error: unknown) => {
        this.reportListenerFailure(error, {
          surface: 'lifecycle',
          guildId,
          channelId: currentRecord.id
        });
      });
    });

    this.client.on(Events.ChannelDelete, (channel) => {
      const record = asChannelRecord(channel as GuildBasedChannel);
      const guildId = 'guildId' in channel && typeof channel.guildId === 'string' ? channel.guildId : undefined;
      if (!record || !guildId) {
        return;
      }
      void handler({
        kind: 'channel',
        action: 'deleted',
        scopeId: guildId,
        guildId,
        channel: record
      }).catch((error: unknown) => {
        this.reportListenerFailure(error, {
          surface: 'lifecycle',
          guildId,
          channelId: record.id
        });
      });
    });

    this.client.on(Events.MessageUpdate, (previous, current) => {
      const guildId = current.guildId ?? previous.guildId;
      const channelId = current.channelId ?? previous.channelId;
      if (!guildId || !channelId) {
        return;
      }
      void handler({
        kind: 'message',
        action: 'updated',
        scopeId: guildId,
        guildId,
        channelId,
        messageId: current.id ?? previous.id,
        authorId: current.author?.id ?? previous.author?.id ?? null,
        content: typeof current.content === 'string' ? current.content : null,
        previousContent: typeof previous.content === 'string' ? previous.content : null
      }).catch((error: unknown) => {
        this.reportListenerFailure(error, {
          surface: 'lifecycle',
          guildId,
          channelId
        });
      });
    });

    this.client.on(Events.MessageDelete, (message) => {
      const guildId = message.guildId;
      const channelId = message.channelId;
      if (!guildId || !channelId) {
        return;
      }
      void handler({
        kind: 'message',
        action: 'deleted',
        scopeId: guildId,
        guildId,
        channelId,
        messageId: message.id,
        authorId: message.author?.id ?? null,
        content: typeof message.content === 'string' ? message.content : null
      }).catch((error: unknown) => {
        this.reportListenerFailure(error, {
          surface: 'lifecycle',
          guildId,
          channelId
        });
      });
    });

    this.client.on(Events.MessageBulkDelete, (messages) => {
      const first = messages.first();
      const guildId = first?.guildId;
      const channelId = first?.channelId;
      if (!guildId || !channelId) {
        return;
      }
      void handler({
        kind: 'message',
        action: 'bulk_deleted',
        scopeId: guildId,
        guildId,
        channelId,
        messageIds: messages.map((message) => message.id)
      }).catch((error: unknown) => {
        this.reportListenerFailure(error, {
          surface: 'lifecycle',
          guildId,
          channelId
        });
      });
    });
  }

  async listChannels(scopeId: string): Promise<DiscordChannelRecord[]> {
    await this.waitForReady();
    const guild = await this.client.guilds.fetch(scopeId);
    const channels = await guild.channels.fetch();
    return channels
      .map((channel) => (channel ? asChannelRecord(channel) : null))
      .filter((channel): channel is DiscordChannelRecord => channel !== null);
  }

  async createCategory(
    scopeId: string,
    name: string,
    permissionOverwrites?: RuntimePermissionOverwrite[]
  ): Promise<DiscordChannelRecord> {
    await this.waitForReady();
    const guild = await this.client.guilds.fetch(scopeId);
    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      ...(permissionOverwrites ? { permissionOverwrites: toDiscordPermissionOverwrites(guild.id, permissionOverwrites) } : {})
    });
    return assertRecord(asChannelRecord(created), 'category');
  }

  async createTextChannel(
    scopeId: string,
    name: string,
    parentId: string | null,
    permissionOverwrites?: RuntimePermissionOverwrite[]
  ): Promise<DiscordChannelRecord> {
    await this.waitForReady();
    const guild = await this.client.guilds.fetch(scopeId);
    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parentId ?? undefined,
      ...(permissionOverwrites ? { permissionOverwrites: toDiscordPermissionOverwrites(guild.id, permissionOverwrites) } : {})
    });
    return assertRecord(asChannelRecord(created), 'text');
  }

  async updateChannel(
    scopeId: string,
    channelId: string,
    update: { name?: string; parentId?: string | null; permissionOverwrites?: RuntimePermissionOverwrite[] }
  ): Promise<DiscordChannelRecord> {
    await this.waitForReady();
    const guild = await this.client.guilds.fetch(scopeId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (update.name && channel.name !== update.name) {
      await channel.setName(update.name);
    }

    if (update.parentId !== undefined) {
      if (channel.type !== ChannelType.GuildCategory) {
        const text = assertTextChannel(channel, channelId);
        if (text.parentId !== update.parentId) {
          await text.setParent(update.parentId, { lockPermissions: false });
        }
      }
    }

    if (update.permissionOverwrites && 'permissionOverwrites' in channel) {
      await channel.permissionOverwrites.set(toDiscordPermissionOverwrites(guild.id, update.permissionOverwrites) ?? []);
    }

    const refreshed = await guild.channels.fetch(channelId);
    return assertRecord(refreshed ? asChannelRecord(refreshed) : null, 'channel');
  }

  async listTransportResources(scopeId: RuntimeScopeId): Promise<RuntimeTransportResourceRecord[]> {
    return (await this.listChannels(scopeId)).map((channel) => this.toRuntimeTransportResourceRecord(channel));
  }

  async createTransportResource(input: RuntimeCreateTransportResourceInput): Promise<RuntimeTransportResourceRecord> {
    const created =
      input.kind === 'collection' || input.kind === 'root'
        ? await this.createCategory(input.scopeId, input.name)
        : await this.createTextChannel(input.scopeId, input.name, input.parentId ?? null);
    return this.toRuntimeTransportResourceRecord(created);
  }

  async updateTransportResource(input: RuntimeUpdateTransportResourceInput): Promise<RuntimeTransportResourceRecord> {
    const updated = await this.updateChannel(input.scopeId, input.transportResourceId, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {})
    });
    return this.toRuntimeTransportResourceRecord(updated);
  }

  async deleteTransportResource(input: RuntimeDeleteTransportResourceInput): Promise<void> {
    await this.deleteChannel(input.scopeId, input.transportResourceId);
  }

  async registerNativeActions(input: RuntimeNativeActionRegistration): Promise<void> {
    const registration = this.toDiscordNativeActionRegistration(
      input.actions.filter((action) => action.id === 'runtime.status')
    );
    this.nativeActionIdsByDiscordPath.clear();
    for (const [path, actionId] of registration.actionIdsByPath.entries()) {
      this.nativeActionIdsByDiscordPath.set(path, actionId);
    }
    await this.registerCommands(input.scopeId, registration.commands);
  }

  async applyEffect(effect: RuntimeTransportEffect): Promise<RuntimeTransportEffectReceipt> {
    const appliedAt = new Date().toISOString();
    switch (effect.type) {
      case 'transport.message.send': {
        const receipt = await this.sendMessage(effect.target, effect.payload);
        return {
          effectId: effect.effectId,
          appliedAt,
          nativeId: receipt.nativeId ?? receipt.id,
          metadata: receipt.metadata
        };
      }
      case 'transport.actions.register':
        await this.registerNativeActions(effect.input);
        return { effectId: effect.effectId, appliedAt };
      case 'transport.resource.create': {
        const resource = await this.createTransportResource(effect.input);
        return {
          effectId: effect.effectId,
          appliedAt,
          nativeId: resource.id,
          metadata: { resource }
        };
      }
      case 'transport.resource.update': {
        const resource = await this.updateTransportResource(effect.input);
        return {
          effectId: effect.effectId,
          appliedAt,
          nativeId: resource.id,
          metadata: { resource }
        };
      }
      case 'transport.resource.delete':
        await this.deleteTransportResource(effect.input);
        return {
          effectId: effect.effectId,
          appliedAt,
          nativeId: effect.input.transportResourceId
        };
      case 'transport.activity.set':
        await this.applyActivity(effect.input);
        return {
          effectId: effect.effectId,
          appliedAt,
          nativeId: effect.input.transportResourceId
        };
      case 'transport.presence.set':
        return {
          effectId: effect.effectId,
          appliedAt,
          ...(effect.input.transportResourceId ? { nativeId: effect.input.transportResourceId } : {})
        };
    }
  }

  async sendMessage(target: RuntimeMessageTarget, payload: RuntimeMessagePayload): Promise<DiscordMessageReceipt>;
  async sendMessage(channelId: string, payload: RuntimeMessagePayload): Promise<DiscordMessageReceipt>;
  async sendMessage(target: RuntimeMessageTarget | string, payload: RuntimeMessagePayload): Promise<DiscordMessageReceipt> {
    const channelId = typeof target === 'string' ? target : target.transportResourceId;
    const discordPayload = toDiscordPayload(payload);
    const sentMessages = await this.withTextChannel(channelId, async (channel) => {
      const sent = [];
      for (const sendPayload of toDiscordSendPayloads(discordPayload)) {
        const sanitized = sanitizeDiscordPayload(sendPayload);
        const files = toDiscordFiles(sendPayload);
        const components = toDiscordComponents(sendPayload);
        sent.push(
          await channel.send({
            ...sanitized,
            ...(files ? { files } : {}),
            ...(components ? { components } : {})
          })
        );
      }
      return sent;
    });
    const first = sentMessages[0];
    if (!first) {
      throw new Error('Discord send did not return a message receipt.');
    }
    return {
      id: first.id,
      nativeId: first.id,
      ...(sentMessages.length > 1
        ? {
            metadata: {
              messageIds: sentMessages.map((message) => message.id)
            }
          }
        : {})
    };
  }

  async triggerTyping(channelId: string): Promise<void> {
    await this.withTextChannel(channelId, async (channel) => {
      await channel.sendTyping();
    });
  }

  private async applyActivity(input: RuntimeTransportActivityInput): Promise<void> {
    if (input.kind !== 'work') {
      return;
    }
    const state = this.getActivityState(input.transportResourceId);
    this.pruneExpiredActivities(state);

    if (input.state === 'inactive') {
      state.leases.delete(input.activityId);
      this.stopActivityLoopIfIdle(input.transportResourceId, state);
      return;
    }

    const wasActive = state.leases.size > 0;
    const leaseMs = this.normalizeActivityLeaseMs(input.leaseMs);
    state.leases.set(input.activityId, Date.now() + leaseMs);
    this.ensureActivityLoop(input.transportResourceId, state);
    if (!wasActive) {
      await this.renderActivity(input.transportResourceId);
    }
  }

  private getActivityState(channelId: string): DiscordActivityState {
    let state = this.activityByChannelId.get(channelId);
    if (!state) {
      state = { leases: new Map(), interval: null };
      this.activityByChannelId.set(channelId, state);
    }
    return state;
  }

  private normalizeActivityLeaseMs(leaseMs: number | undefined): number {
    return typeof leaseMs === 'number' && Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : DEFAULT_ACTIVITY_LEASE_MS;
  }

  private ensureActivityLoop(channelId: string, state: DiscordActivityState): void {
    if (state.interval) {
      return;
    }
    state.interval = globalThis.setInterval(() => {
      this.pruneExpiredActivities(state);
      if (state.leases.size === 0) {
        this.stopActivityLoopIfIdle(channelId, state);
        return;
      }
      void this.renderActivity(channelId).catch((error: unknown) => {
        this.onListenerError(error instanceof Error ? error : new Error(String(error)), {
          surface: 'lifecycle',
          channelId
        });
      });
    }, DISCORD_ACTIVITY_RENDER_INTERVAL_MS);
  }

  private async renderActivity(channelId: string): Promise<void> {
    await this.triggerTyping(channelId);
  }

  private pruneExpiredActivities(state: DiscordActivityState): void {
    const now = Date.now();
    for (const [activityId, expiresAt] of state.leases.entries()) {
      if (expiresAt <= now) {
        state.leases.delete(activityId);
      }
    }
  }

  private stopActivityLoopIfIdle(channelId: string, state: DiscordActivityState): void {
    if (state.leases.size > 0) {
      return;
    }
    if (state.interval) {
      globalThis.clearInterval(state.interval);
      state.interval = null;
    }
    this.activityByChannelId.delete(channelId);
  }

  private clearActivityState(): void {
    for (const state of this.activityByChannelId.values()) {
      if (state.interval) {
        globalThis.clearInterval(state.interval);
      }
    }
    this.activityByChannelId.clear();
  }

  async deleteChannel(scopeId: string, channelId: string): Promise<void> {
    await this.waitForReady();
    const guild = await this.client.guilds.fetch(scopeId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel) {
      return;
    }
    await channel.delete();
  }

  private isStartChannel(channel: DiscordChannelRecord | null): boolean {
    return channel?.type === 'text' && channel.name === DISCORD_START_CHANNEL_NAME;
  }

  private isSessionTextChannel(channel: DiscordChannelRecord | null): channel is DiscordChannelRecord {
    return channel?.type === 'text' && channel.parentId !== null && !this.isStartChannel(channel);
  }

  private async hydrateKnownSessionChannels(scopeId: string): Promise<void> {
    const channels = await this.listChannels(scopeId);
    for (const channel of channels) {
      if (this.isSessionTextChannel(channel)) {
        this.knownSessionChannelIds.add(channel.id);
      }
    }
  }

  private async ensureStartChannel(scopeId: string): Promise<DiscordChannelRecord> {
    const channels = await this.listChannels(scopeId);
    const existing = channels.find((channel) => this.isStartChannel(channel));
    if (existing) {
      if (existing.parentId !== null) {
        return await this.updateChannel(scopeId, existing.id, { parentId: null });
      }
      return existing;
    }

    const created = await this.createTextChannel(scopeId, DISCORD_START_CHANNEL_NAME, null);
    await this.sendMessage(created.id, {
      text: [
        'Moorline is ready.',
        'Create a Discord category for a project, then create text channels inside it to start Moorline sessions.',
        'Deleting a session channel deletes that Moorline session. Use `/status` for runtime status.'
      ].join('\n')
    });
    return created;
  }

  private async waitForReady(): Promise<void> {
    if (this.client.isReady()) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeoutMs = resolveDiscordReadyTimeoutMs();
      const timer = globalThis.setTimeout(() => {
        this.client.off(Events.ClientReady, onReady);
        reject(new DiscordReadyTimeoutError(timeoutMs));
      }, timeoutMs);
      const onReady = () => {
        globalThis.clearTimeout(timer);
        resolve();
      };
      this.client.once(Events.ClientReady, onReady);
    });
  }

  private async withTextChannel<T>(channelId: string, work: (channel: TextChannel) => Promise<T>): Promise<T> {
    await this.waitForReady();
    const channel = await this.client.channels.fetch(channelId);
    return await work(assertTextChannel(channel as GuildBasedChannel | null, channelId));
  }

  private toRuntimeActor(input: {
    actorId: string;
    displayName?: string;
    accessGroupIds?: string[];
    isSurfaceAdmin?: boolean;
  }): RuntimeActorIdentity {
    return {
      actorId: input.actorId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accessGroupIds ? { accessGroupIds: input.accessGroupIds } : {}),
      ...(input.isSurfaceAdmin !== undefined ? { isSurfaceAdmin: input.isSurfaceAdmin } : {})
    };
  }

  private toRuntimeTransportResourceRecord(channel: DiscordChannelRecord): RuntimeTransportResourceRecord {
    return {
      id: channel.id,
      name: channel.name,
      kind: channel.type === 'category' ? 'collection' : 'conversation',
      parentId: channel.parentId
    };
  }

  private discordActionPath(commandName: string, subcommandName?: string | null): string {
    return `${commandName}${subcommandName ? `.${subcommandName}` : ''}`;
  }

  private discordCommandMetadata(action: RuntimeActionDefinition): DiscordRuntimeActionCommandMetadata | null {
    const metadata = action.metadata;
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }
    if ('discordCommand' in metadata) {
      const raw = (metadata as { discordCommand?: unknown }).discordCommand;
      if (!raw || typeof raw !== 'object') {
        return null;
      }
      const command = raw as {
        commandName?: unknown;
        commandDescription?: unknown;
        subcommandName?: unknown;
        subcommandDescription?: unknown;
        options?: unknown;
      };
      if (typeof command.commandName !== 'string' || typeof command.commandDescription !== 'string') {
        return null;
      }
      const options =
        Array.isArray(command.options) && command.options.every((entry) => !!entry && typeof entry === 'object')
          ? (command.options as DiscordCommandDefinition['options'])
          : undefined;
      return {
        commandName: command.commandName,
        commandDescription: command.commandDescription,
        ...(typeof command.subcommandName === 'string' ? { subcommandName: command.subcommandName } : {}),
        ...(typeof command.subcommandDescription === 'string'
          ? { subcommandDescription: command.subcommandDescription }
          : {}),
        ...(options ? { options } : {})
      };
    }
    return this.workflowCommandMetadata(action);
  }

  private workflowCommandMetadata(action: RuntimeActionDefinition): DiscordRuntimeActionCommandMetadata | null {
    const workflow = action.metadata?.workflow;
    if (!workflow || typeof workflow !== 'object') {
      return null;
    }
    const commandName = action.id.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase().slice(0, 32).replace(/^-+|-+$/g, '');
    if (!commandName) {
      return null;
    }
    const options = this.workflowStringOptions(action);
    return {
      commandName,
      commandDescription: (action.description ?? action.title).slice(0, 100),
      ...(options.length > 0 ? { options } : {})
    };
  }

  private workflowStringOptions(action: RuntimeActionDefinition): NonNullable<DiscordCommandDefinition['options']> {
    const schema = action.inputSchema;
    const schemaRecord = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : null;
    if (!schemaRecord) {
      return [];
    }
    const properties = schemaRecord.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      return [];
    }
    const required = new Set(Array.isArray(schemaRecord.required) ? schemaRecord.required.filter((entry): entry is string => typeof entry === 'string') : []);
    return Object.entries(properties)
      .filter(([, value]) => !!value && typeof value === 'object' && !Array.isArray(value) && (value as { type?: unknown }).type === 'string')
      .slice(0, 25)
      .map(([name, value]) => {
        const property = value as { description?: unknown; title?: unknown };
        return {
          type: 'string' as const,
          name: name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase().slice(0, 32).replace(/^-+|-+$/g, '') || 'value',
          description: String(property.description ?? property.title ?? name).slice(0, 100),
          required: required.has(name)
        };
      });
  }

  private toDiscordNativeActionRegistration(actions: RuntimeActionDefinition[]): {
    commands: DiscordCommandDefinition[];
    actionIdsByPath: Map<string, string>;
  } {
    const commandsByName = new Map<string, DiscordCommandDefinition>();
    const actionIdsByPath = new Map<string, string>();
    const ensureUniqueActionPath = (path: string, actionId: string): void => {
      const existing = actionIdsByPath.get(path);
      if (existing && existing !== actionId) {
        throw new Error(`Discord command path collision "${path}" maps to both "${existing}" and "${actionId}".`);
      }
      actionIdsByPath.set(path, actionId);
    };

    for (const action of actions) {
      const metadata = this.discordCommandMetadata(action);
      if (!metadata) {
        const command = this.toDiscordCommandDefinition(action);
        commandsByName.set(command.name, command);
        ensureUniqueActionPath(command.name, action.id);
        continue;
      }

      const existing = commandsByName.get(metadata.commandName) ?? {
        name: metadata.commandName,
        description: metadata.commandDescription
      };
      if (metadata.subcommandName) {
        existing.subcommands = [
          ...(existing.subcommands ?? []).filter((entry) => entry.name !== metadata.subcommandName),
          {
            name: metadata.subcommandName,
            description: metadata.subcommandDescription ?? action.title,
            ...(metadata.options ? { options: metadata.options } : {})
          }
        ];
        ensureUniqueActionPath(this.discordActionPath(metadata.commandName, metadata.subcommandName), action.id);
      } else {
        existing.options = metadata.options;
        ensureUniqueActionPath(this.discordActionPath(metadata.commandName), action.id);
      }
      commandsByName.set(metadata.commandName, existing);
    }

    return {
      commands: [...commandsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
      actionIdsByPath
    };
  }

  private toDiscordCommandDefinition(action: RuntimeActionDefinition): DiscordCommandDefinition {
    const sanitized = action.id.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase().slice(0, 32).replace(/^-+|-+$/g, '');
    return {
      name: sanitized || 'action',
      description: (action.description ?? action.title).slice(0, 100)
    };
  }

  private reportListenerFailure(error: unknown, context: DiscordListenerErrorContext): void {
    this.onListenerError(error instanceof Error ? error : new Error(String(error)), context);
  }
}

function assertRecord(record: DiscordChannelRecord | null, label: string): DiscordChannelRecord {
  if (!record) {
    throw new Error(`Expected ${label} channel`);
  }
  return record;
}
