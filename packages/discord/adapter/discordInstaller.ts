import {
  ChannelType,
  Client,
  Events,
  PermissionsBitField,
  PermissionFlagsBits,
  type GuildBasedChannel,
  type TextChannel
} from 'discord.js';
import { URLSearchParams } from 'node:url';
import type { RuntimeSurfaceBootstrapInput, RuntimeSurfaceState } from '@moorline/contracts';
import type {
  RuntimeAccessGroupInput,
  RuntimeAccessGroupRecord,
  RuntimeActionDefinition,
  RuntimeActorIdentity,
  RuntimeMessagePayload,
  RuntimeMessageReceipt,
  RuntimeNativeActionRegistration,
  RuntimeScopeId,
  RuntimeTransportAccessInput,
  RuntimeTransportAuth,
  RuntimeTransportVerification,
} from '@moorline/contracts';
import { bootstrapManagedSurface } from '../mapping/managedSurface.js';
import {
  DISCORD_EPHEMERAL_FLAG,
  resolveReplyFlags,
  sanitizeDiscordPayload,
  toDiscordComponents,
  toDiscordFiles,
  toDiscordPayload
} from './discordPayload.js';
import {
  asChannelRecord,
  asRoleRecord,
  assertTextChannel,
  collectStringOptions,
  createDiscordClient,
  extractImageAttachments,
  extractMemberRoleIds,
  sortCommandOptions,
  toDiscordPermissionOverwrites
} from './discordMapping.js';

export const REQUIRED_DISCORD_PERMISSIONS = '268528720';
const DISCORD_MANAGED_ADMIN_ROLE_PERMISSIONS = new PermissionsBitField(PermissionFlagsBits.ManageRoles).bitfield.toString();

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

export interface DiscordRoleRecord {
  id: string;
  name: string;
  permissions: string;
}

type RuntimeTransportResourceKind = 'root' | 'collection' | 'conversation' | 'item' | 'direct' | 'external';

interface RuntimeTransportResourceRecord {
  id: string;
  name: string;
  kind: RuntimeTransportResourceKind;
  parentId: string | null;
  metadata?: Record<string, unknown>;
}

interface RuntimeCreateTransportResourceInput {
  scopeId: RuntimeScopeId;
  name: string;
  kind: RuntimeTransportResourceKind;
  parentId?: string | null;
  metadata?: Record<string, unknown>;
}

interface RuntimeUpdateTransportResourceInput {
  scopeId: RuntimeScopeId;
  transportResourceId: string;
  name?: string;
  parentId?: string | null;
  metadata?: Record<string, unknown>;
}

interface RuntimeDeleteTransportResourceInput {
  scopeId: RuntimeScopeId;
  transportResourceId: string;
}

interface RuntimeMessageTarget {
  scopeId?: RuntimeScopeId;
  transportResourceId: string;
  threadId?: string;
}

interface RuntimeTransportCapabilities {
  nativeActions: boolean;
  resources: {
    list: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;
  };
  presence: boolean;
  maxMessageTextLength?: number;
  maxAttachmentBytes?: number;
  metadata?: Record<string, unknown>;
}

type RuntimeTransportEvent =
  | {
      type: 'message.received';
      scopeId: RuntimeScopeId;
      transportResourceId: string;
      actor: RuntimeActorIdentity;
      message: { id?: string; text: string; attachments?: unknown[]; metadata?: Record<string, unknown> };
    }
  | {
      type: 'action.invoked';
      scopeId: RuntimeScopeId;
      transportResourceId?: string;
      actor: RuntimeActorIdentity;
      actionId: string;
      input: Record<string, unknown>;
      native?: { kind: string; id?: string; payload?: unknown };
    }
  | {
      type: 'resource.lifecycle';
      scopeId: RuntimeScopeId;
      resource: RuntimeTransportResourceRecord;
      action: 'created' | 'updated' | 'deleted';
      previous?: Partial<RuntimeTransportResourceRecord>;
    };

interface RuntimeTransport {
  verifyAccess(input: RuntimeTransportAccessInput): Promise<RuntimeTransportVerification>;
  start(auth: RuntimeTransportAuth): Promise<void>;
  stop(): Promise<void>;
  capabilities(): RuntimeTransportCapabilities;
  onEvent(handler: (event: RuntimeTransportEvent) => Promise<void>): void;
  sendMessage(target: RuntimeMessageTarget, payload: RuntimeMessagePayload): Promise<RuntimeMessageReceipt>;
}

interface RuntimeSurfaceNames {
  mainCategoryName: string;
  coordinationResourceName: string;
  statusResourceName: string;
  sessionsGroupName: string;
  archiveGroupName: string;
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

export interface DiscordReactionEvent {
  scopeId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  memberRoleIds: string[];
  isTransportAdmin: boolean;
  emoji: string;
  bot: boolean;
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
  reconcileRuntimeSurface(input: RuntimeSurfaceBootstrapInput): Promise<RuntimeSurfaceState>;
  onMessage(handler: (event: DiscordMessageEvent) => Promise<void>): void;
  onSlashCommand(handler: (event: SlashCommandEvent) => Promise<void>): void;
  onReaction(handler: (event: DiscordReactionEvent) => Promise<void>): void;
  onButtonInteraction(handler: (event: DiscordButtonInteractionEvent) => Promise<void>): void;
  onLifecycleEvent(handler: (event: DiscordTransportLifecycleEvent) => Promise<void>): void;
  listChannels(scopeId: string): Promise<DiscordChannelRecord[]>;
  listRoles(scopeId: string): Promise<DiscordRoleRecord[]>;
  createCategory(scopeId: string, name: string, permissionOverwrites?: RuntimePermissionOverwrite[]): Promise<DiscordChannelRecord>;
  createTextChannel(
    scopeId: string,
    name: string,
    parentId: string | null,
    permissionOverwrites?: RuntimePermissionOverwrite[]
  ): Promise<DiscordChannelRecord>;
  createRole(scopeId: string, name: string): Promise<DiscordRoleRecord>;
  updateChannel(
    scopeId: string,
    channelId: string,
    update: { name?: string; parentId?: string | null; permissionOverwrites?: RuntimePermissionOverwrite[] }
  ): Promise<DiscordChannelRecord>;
  updateRole(scopeId: string, roleId: string, update: { name?: string; permissions?: string }): Promise<DiscordRoleRecord>;
  deleteChannel(scopeId: string, channelId: string): Promise<void>;
  deleteRole(scopeId: string, roleId: string): Promise<void>;
  triggerTyping(channelId: string): Promise<void>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
}

interface DiscordListenerErrorContext {
  surface: 'message' | 'slash' | 'button' | 'lifecycle' | 'reaction';
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
  private transportEventHandler: ((event: RuntimeTransportEvent) => Promise<void>) | null = null;
  private genericBindingsRegistered = false;
  private readonly nativeActionIdsByDiscordPath = new Map<string, string>();

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
        list: true,
        create: true,
        update: true,
        delete: true
      },
      presence: false,
      metadata: {
        packageId: 'official/discord'
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
    if (this.client.isReady()) {
      return;
    }

    const token = auth.token?.trim();
    if (!token) {
      throw new Error('Discord transport auth token is required');
    }
    await this.client.login(token);
    await this.waitForReady();
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  onEvent(handler: (event: RuntimeTransportEvent) => Promise<void>): void {
    this.transportEventHandler = handler;
    if (this.genericBindingsRegistered) {
      return;
    }

    this.genericBindingsRegistered = true;
    this.onMessage(async (event) => {
      if (event.bot) {
        return;
      }
      await this.transportEventHandler?.({
        type: 'message.received',
        scopeId: event.scopeId,
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
      const mappedActionId =
        this.nativeActionIdsByDiscordPath.get(this.discordActionPath(event.commandName, event.subcommandName)) ??
        `discord.command.${event.commandName}${event.subcommandName ? `.${event.subcommandName}` : ''}`;
      await this.transportEventHandler?.({
        type: 'action.invoked',
        scopeId: event.scopeId,
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
      await this.transportEventHandler?.({
        type: 'action.invoked',
        scopeId: event.scopeId,
        transportResourceId: event.channelId,
        actor: this.toRuntimeActor({
          actorId: event.userId,
          accessGroupIds: event.memberRoleIds,
          isSurfaceAdmin: event.isTransportAdmin
        }),
        actionId: event.buttonId,
        input: {},
        native: {
          kind: 'discord.button',
          id: event.messageId,
          payload: {
            buttonId: event.buttonId,
            channelId: event.channelId,
            messageId: event.messageId,
            reply: event.reply,
            defer: event.defer
          }
        }
      });
    });
    this.onReaction(async (event) => {
      if (event.bot) {
        return;
      }
      await this.transportEventHandler?.({
        type: 'action.invoked',
        scopeId: event.scopeId,
        transportResourceId: event.channelId,
        actor: this.toRuntimeActor({
          actorId: event.userId,
          accessGroupIds: event.memberRoleIds,
          isSurfaceAdmin: event.isTransportAdmin
        }),
        actionId: `discord.reaction.${event.emoji}`,
        input: {
          emoji: event.emoji,
          messageId: event.messageId
        },
        native: {
          kind: 'discord.reaction',
          id: event.messageId,
          payload: {
            emoji: event.emoji
          }
        }
      });
    });
    this.onLifecycleEvent(async (event) => {
      if (event.kind !== 'channel') {
        return;
      }
      await this.transportEventHandler?.({
        type: 'resource.lifecycle',
        scopeId: event.scopeId,
        action: event.action,
        resource: this.toRuntimeTransportResourceRecord(event.channel),
        ...(event.previous ? { previous: this.toRuntimeTransportResourceRecord(event.previous) } : {})
      });
    });
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

  async reconcileRuntimeSurface(input: RuntimeSurfaceBootstrapInput): Promise<RuntimeSurfaceState> {
    if (!input.actorId || !input.names || !input.managedAdminAccessGroup || !input.managedMemberAccessGroup) {
      throw new Error('Discord runtime surface reconciliation requires actor, names, and managed access group configuration.');
    }
    const names = input.names as unknown as RuntimeSurfaceNames;
    return await bootstrapManagedSurface(this, {
      scopeId: input.scopeId,
      actorId: input.actorId,
      names,
      managedAdminAccessGroup: input.managedAdminAccessGroup,
      managedMemberAccessGroup: input.managedMemberAccessGroup,
      explicitAdminRoleIds: input.explicitAdminRoleIds ?? [],
      explicitAdminUserIds: input.explicitAdminUserIds ?? [],
      previousState: input.previousState,
      nowIso: input.nowIso
    }) as unknown as RuntimeSurfaceState;
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

  onReaction(handler: (event: DiscordReactionEvent) => Promise<void>): void {
    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      const guildId = reaction.message.guildId;
      const channelId = reaction.message.channelId;
      if (!guildId || !channelId) {
        return;
      }

      void (async () => {
        const guild = await this.client.guilds.fetch(guildId);
        let member:
          | {
              permissions?: {
                has?(permission: bigint | number): boolean;
              };
            }
          | null = null;
        try {
          member = (await guild.members.fetch(user.id)) as {
            permissions?: {
              has?(permission: bigint | number): boolean;
            };
          };
        } catch (error) {
          this.reportListenerFailure(error, {
            surface: 'reaction',
            guildId,
            channelId,
            commandName: reaction.emoji.name ?? undefined
          });
        }
        await handler({
          scopeId: guildId,
          guildId,
          channelId,
          messageId: reaction.message.id,
          userId: user.id,
          memberRoleIds: extractMemberRoleIds(member as unknown),
          isTransportAdmin: member?.permissions?.has?.(PermissionFlagsBits.Administrator) ?? false,
          emoji: reaction.emoji.name ?? '',
          bot: user.bot
        });
      })().catch((error: unknown) => {
        this.reportListenerFailure(error, {
          surface: 'reaction',
          guildId,
          channelId
        });
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

  async listRoles(scopeId: string): Promise<DiscordRoleRecord[]> {
    await this.waitForReady();
    const guild = await this.client.guilds.fetch(scopeId);
    const roles = await guild.roles.fetch();
    return roles
      .map((role) => (role ? asRoleRecord(role) : null))
      .filter((role): role is DiscordRoleRecord => role !== null);
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

  async createRole(scopeId: string, name: string): Promise<DiscordRoleRecord> {
    await this.waitForReady();
    const guild = await this.client.guilds.fetch(scopeId);
    const created = await guild.roles.create({
      name,
      permissions: new PermissionsBitField(0n)
    });
    return asRoleRecord(created);
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

  async updateRole(scopeId: string, roleId: string, update: { name?: string; permissions?: string }): Promise<DiscordRoleRecord> {
    await this.waitForReady();
    const guild = await this.client.guilds.fetch(scopeId);
    const role = await guild.roles.fetch(roleId);
    if (!role) {
      throw new Error(`Role not found: ${roleId}`);
    }

    if (update.name && role.name !== update.name) {
      await role.setName(update.name);
    }

    if (update.permissions !== undefined && role.permissions.bitfield.toString() !== update.permissions) {
      await role.setPermissions(new PermissionsBitField(BigInt(update.permissions)));
    }

    const refreshed = await guild.roles.fetch(roleId);
    if (!refreshed) {
      throw new Error(`Role not found after update: ${roleId}`);
    }
    return asRoleRecord(refreshed);
  }

  async ensureAccessGroup(input: RuntimeAccessGroupInput): Promise<RuntimeAccessGroupRecord> {
    const permissions = input.kind === 'admin' ? DISCORD_MANAGED_ADMIN_ROLE_PERMISSIONS : undefined;
    const roles = await this.listRoles(input.scopeId);
    const tracked = input.previousId ? roles.find((role) => role.id === input.previousId) : undefined;
    const named = roles.find((role) => role.name === input.name);
    const verifiedAt = new Date().toISOString();

    const toAccessGroup = (role: DiscordRoleRecord): RuntimeAccessGroupRecord => ({
      id: role.id,
      kind: input.kind,
      name: role.name,
      verifiedAt,
      metadata: {
        nativeKind: 'discord-role'
      }
    });

    if (tracked) {
      if (tracked.name !== input.name || (permissions !== undefined && tracked.permissions !== permissions)) {
        return toAccessGroup(
          await this.updateRole(input.scopeId, tracked.id, {
            name: input.name,
            ...(permissions !== undefined ? { permissions } : {})
          })
        );
      }
      return toAccessGroup(tracked);
    }

    if (named) {
      if (permissions !== undefined && named.permissions !== permissions) {
        return toAccessGroup(await this.updateRole(input.scopeId, named.id, { permissions }));
      }
      return toAccessGroup(named);
    }

    const created = await this.createRole(input.scopeId, input.name);
    return toAccessGroup(
      permissions !== undefined ? await this.updateRole(input.scopeId, created.id, { permissions }) : created
    );
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
    const registration = this.toDiscordNativeActionRegistration(input.actions);
    this.nativeActionIdsByDiscordPath.clear();
    for (const [path, actionId] of registration.actionIdsByPath.entries()) {
      this.nativeActionIdsByDiscordPath.set(path, actionId);
    }
    await this.registerCommands(input.scopeId, registration.commands);
  }

  async sendMessage(target: RuntimeMessageTarget, payload: RuntimeMessagePayload): Promise<DiscordMessageReceipt>;
  async sendMessage(channelId: string, payload: RuntimeMessagePayload): Promise<DiscordMessageReceipt>;
  async sendMessage(target: RuntimeMessageTarget | string, payload: RuntimeMessagePayload): Promise<DiscordMessageReceipt> {
    const channelId = typeof target === 'string' ? target : target.transportResourceId;
    const discordPayload = toDiscordPayload(payload);
    const sent = await this.withTextChannel(channelId, async (channel) => {
      const sanitized = sanitizeDiscordPayload(discordPayload);
      const files = toDiscordFiles(discordPayload);
      const components = toDiscordComponents(discordPayload);
      return await channel.send({
        ...sanitized,
        ...(files ? { files } : {}),
        ...(components ? { components } : {})
      });
    });
    return { id: sent.id };
  }

  async triggerTyping(channelId: string): Promise<void> {
    await this.withTextChannel(channelId, async (channel) => {
      await channel.sendTyping();
    });
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.withTextChannel(channelId, async (channel) => {
      const message = await channel.messages.fetch(messageId);
      await message.react(emoji);
    });
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

  async deleteRole(scopeId: string, roleId: string): Promise<void> {
    await this.waitForReady();
    const guild = await this.client.guilds.fetch(scopeId);
    const role = await guild.roles.fetch(roleId);
    if (!role) {
      return;
    }
    await role.delete();
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
    if (!metadata || typeof metadata !== 'object' || !('discordCommand' in metadata)) {
      return null;
    }
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

export interface SurfaceBootstrapInput {
  scopeId?: string;
  guildId?: string;
  actorId: string;
  names: RuntimeSurfaceNames;
  managedAdminAccessGroup: NonNullable<RuntimeSurfaceBootstrapInput['managedAdminAccessGroup']>;
  managedMemberAccessGroup: NonNullable<RuntimeSurfaceBootstrapInput['managedMemberAccessGroup']>;
  explicitAdminRoleIds: string[];
  explicitAdminUserIds: string[];
  previousState: RuntimeSurfaceState | null;
  nowIso: string;
}
