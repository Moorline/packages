import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import type { RuntimeSurfaceNames, RuntimeSurfaceState } from '@moorline/contracts';
import type {
  DiscordChannelRecord,
  DiscordOperator,
  DiscordRoleRecord,
  NamespaceBootstrapInput,
  RuntimePermissionOverwrite
} from '../adapter/discordInstaller.js';

const MOORLINE_PARTICIPANT_CHANNEL_PERMISSIONS = [
  'ViewChannel',
  'SendMessages',
  'ReadMessageHistory',
  'AddReactions',
  'EmbedLinks',
  'AttachFiles'
] as const;

const MOORLINE_ADMIN_CHANNEL_PERMISSIONS = [
  ...MOORLINE_PARTICIPANT_CHANNEL_PERMISSIONS,
  'ManageMessages',
  'ManageChannels'
] as const;

const MOORLINE_BOT_CHANNEL_PERMISSIONS = [
  ...MOORLINE_PARTICIPANT_CHANNEL_PERMISSIONS
] as const;

const MANAGED_ADMIN_ROLE_PERMISSIONS = new PermissionsBitField(PermissionFlagsBits.ManageRoles).bitfield.toString();

interface ExpectedResource {
  key:
    | 'mainCategoryId'
    | 'chatChannelId'
    | 'statusChannelId'
    | 'sessionsCategoryId'
    | 'missionsCategoryId'
    | 'archiveCategoryId';
  name: string;
  type: 'text' | 'category';
  parentId: string | null;
  permissionOverwrites: RuntimePermissionOverwrite[];
}

function findById(channels: DiscordChannelRecord[], id: string | undefined): DiscordChannelRecord | null {
  if (!id) {
    return null;
  }
  return channels.find((channel) => channel.id === id) ?? null;
}

function findByShape(
  channels: DiscordChannelRecord[],
  input: { name: string; type: 'text' | 'category'; parentId: string | null }
): DiscordChannelRecord | null {
  return (
    channels.find(
      (channel) =>
        channel.name === input.name && channel.type === input.type && (channel.parentId ?? null) === input.parentId
    ) ?? null
  );
}

async function ensureResource(
  operator: DiscordOperator,
  scopeId: string,
  channels: DiscordChannelRecord[],
  previousState: RuntimeSurfaceState | null,
  resource: ExpectedResource
): Promise<DiscordChannelRecord> {
  const tracked = findById(channels, previousState?.[resource.key]);
  if (tracked) {
    if (tracked.name !== resource.name || (tracked.parentId ?? null) !== resource.parentId) {
      return operator.updateChannel(scopeId, tracked.id, {
        name: resource.name,
        parentId: resource.parentId,
        permissionOverwrites: resource.permissionOverwrites
      });
    }
    await operator.updateChannel(scopeId, tracked.id, {
      permissionOverwrites: resource.permissionOverwrites
    });
    return tracked;
  }

  const matching = findByShape(channels, resource);
  if (matching) {
    return await operator.updateChannel(scopeId, matching.id, {
      permissionOverwrites: resource.permissionOverwrites
    });
  }

  if (resource.type === 'category') {
    return operator.createCategory(scopeId, resource.name, resource.permissionOverwrites);
  }

  return operator.createTextChannel(scopeId, resource.name, resource.parentId, resource.permissionOverwrites);
}

function findRoleById(roles: DiscordRoleRecord[], id: string | undefined): DiscordRoleRecord | null {
  if (!id) {
    return null;
  }

  return roles.find((role) => role.id === id) ?? null;
}

function findRoleByName(roles: DiscordRoleRecord[], name: string): DiscordRoleRecord | null {
  return roles.find((role) => role.name === name) ?? null;
}

function isSafeManagedAdminRole(role: DiscordRoleRecord): boolean {
  return role.permissions === MANAGED_ADMIN_ROLE_PERMISSIONS;
}

function isSafeManagedUserRole(role: DiscordRoleRecord): boolean {
  return role.permissions === '0';
}

async function ensureAdminRole(
  operator: DiscordOperator,
  scopeId: string,
  roles: DiscordRoleRecord[],
  previousState: RuntimeSurfaceState | null,
  input: NamespaceBootstrapInput
): Promise<DiscordRoleRecord | null> {
  if (input.managedAdminAccessGroup.enabled !== true) {
    return null;
  }

  const tracked = findRoleById(roles, previousState?.adminAccessGroupId);
  if (tracked) {
    if (tracked.name !== input.managedAdminAccessGroup.name || !isSafeManagedAdminRole(tracked)) {
      return await operator.updateRole(scopeId, tracked.id, {
        ...(tracked.name !== input.managedAdminAccessGroup.name ? { name: input.managedAdminAccessGroup.name } : {}),
        ...(!isSafeManagedAdminRole(tracked) ? { permissions: MANAGED_ADMIN_ROLE_PERMISSIONS } : {})
      });
    }
    return tracked;
  }

  const matching = findRoleByName(roles, input.managedAdminAccessGroup.name);
  if (matching) {
    if (isSafeManagedAdminRole(matching)) {
      return matching;
    }
  }

  const created = await operator.createRole(scopeId, input.managedAdminAccessGroup.name);
  return await operator.updateRole(scopeId, created.id, { permissions: MANAGED_ADMIN_ROLE_PERMISSIONS });
}

async function ensureUserRole(
  operator: DiscordOperator,
  scopeId: string,
  roles: DiscordRoleRecord[],
  previousState: RuntimeSurfaceState | null,
  input: NamespaceBootstrapInput
): Promise<DiscordRoleRecord | null> {
  if (input.managedMemberAccessGroup.enabled !== true) {
    return null;
  }

  const tracked = findRoleById(roles, previousState?.memberAccessGroupId);
  if (tracked) {
    if (tracked.name !== input.managedMemberAccessGroup.name || !isSafeManagedUserRole(tracked)) {
      return await operator.updateRole(scopeId, tracked.id, {
        ...(tracked.name !== input.managedMemberAccessGroup.name ? { name: input.managedMemberAccessGroup.name } : {}),
        ...(!isSafeManagedUserRole(tracked) ? { permissions: '0' } : {})
      });
    }
    return tracked;
  }

  const matching = findRoleByName(roles, input.managedMemberAccessGroup.name);
  if (matching && isSafeManagedUserRole(matching)) {
    return matching;
  }

  return await operator.createRole(scopeId, input.managedMemberAccessGroup.name);
}

function accessPolicy(input: {
  scopeId: string;
  actorId: string;
  adminAccessGroupId: string | null;
  memberAccessGroupId: string | null;
  explicitAdminRoleIds: string[];
  explicitAdminUserIds: string[];
}): RuntimePermissionOverwrite[] {
  const policy: RuntimePermissionOverwrite[] = [
    {
      subject: 'everyone',
      allowPermissions: [],
      denyPermissions: ['ViewChannel']
    },
    {
      subject: 'member',
      subjectId: input.actorId,
      allowPermissions: [...MOORLINE_BOT_CHANNEL_PERMISSIONS],
      denyPermissions: []
    }
  ];

  const adminAccessGroupIds = [...(input.adminAccessGroupId ? [input.adminAccessGroupId] : []), ...input.explicitAdminRoleIds];
  for (const roleId of new Set(adminAccessGroupIds)) {
    policy.push({
      subject: 'role',
      subjectId: roleId,
      allowPermissions: [...MOORLINE_ADMIN_CHANNEL_PERMISSIONS],
      denyPermissions: []
    });
  }
  if (input.memberAccessGroupId) {
    policy.push({
      subject: 'role',
      subjectId: input.memberAccessGroupId,
      allowPermissions: [...MOORLINE_PARTICIPANT_CHANNEL_PERMISSIONS],
      denyPermissions: []
    });
  }
  for (const userId of new Set(input.explicitAdminUserIds)) {
    policy.push({
      subject: 'member',
      subjectId: userId,
      allowPermissions: [...MOORLINE_ADMIN_CHANNEL_PERMISSIONS],
      denyPermissions: []
    });
  }

  return policy;
}

export async function bootstrapManagedNamespace(
  operator: DiscordOperator,
  input: NamespaceBootstrapInput
) : Promise<RuntimeSurfaceState> {
  const scopeId = input.scopeId ?? input.guildId ?? '';
  const existingChannels = await operator.listChannels(scopeId);
  const existingRoles = await operator.listRoles(scopeId);
  const adminRole = await ensureAdminRole(operator, scopeId, existingRoles, input.previousState, input);
  const refreshedRoles = await operator.listRoles(scopeId);
  const userRole = await ensureUserRole(operator, scopeId, refreshedRoles, input.previousState, input);
  const policy = accessPolicy({
    scopeId,
    actorId: input.actorId,
    adminAccessGroupId: adminRole?.id ?? null,
    memberAccessGroupId: userRole?.id ?? null,
    explicitAdminRoleIds: input.explicitAdminRoleIds,
    explicitAdminUserIds: input.explicitAdminUserIds
  });

  const mainCategory = await ensureResource(operator, scopeId, existingChannels, input.previousState, {
    key: 'mainCategoryId',
    name: input.names.mainCategoryName,
    type: 'category',
    parentId: null,
    permissionOverwrites: policy
  });

  const sessionsCategory = await ensureResource(operator, scopeId, existingChannels, input.previousState, {
    key: 'sessionsCategoryId',
    name: (input.names as RuntimeSurfaceNames & { sessionsGroupName?: string }).sessionsGroupName ?? input.names.sessionsCategoryName,
    type: 'category',
    parentId: null,
    permissionOverwrites: policy
  });

  const missionsCategory = await ensureResource(operator, scopeId, existingChannels, input.previousState, {
    key: 'missionsCategoryId',
    name: (input.names as RuntimeSurfaceNames & { missionsGroupName?: string }).missionsGroupName ?? input.names.missionsCategoryName,
    type: 'category',
    parentId: null,
    permissionOverwrites: policy
  });

  const archiveCategory = await ensureResource(operator, scopeId, existingChannels, input.previousState, {
    key: 'archiveCategoryId',
    name: (input.names as RuntimeSurfaceNames & { archiveGroupName?: string }).archiveGroupName ?? input.names.archiveCategoryName,
    type: 'category',
    parentId: null,
    permissionOverwrites: policy
  });

  const refreshedChannels = await operator.listChannels(scopeId);

  const chat = await ensureResource(operator, scopeId, refreshedChannels, input.previousState, {
    key: 'chatChannelId',
    name: input.names.chatChannelName,
    type: 'text',
    parentId: mainCategory.id,
    permissionOverwrites: policy
  });

  const status = await ensureResource(operator, scopeId, refreshedChannels, input.previousState, {
    key: 'statusChannelId',
    name: input.names.statusChannelName,
    type: 'text',
    parentId: mainCategory.id,
    permissionOverwrites: policy
  });

  return {
    scopeId,
    mainCategoryId: mainCategory.id,
    chatChannelId: chat.id,
    statusChannelId: status.id,
    sessionsCategoryId: sessionsCategory.id,
    missionsCategoryId: missionsCategory.id,
    archiveCategoryId: archiveCategory.id,
    ...(adminRole ? { adminAccessGroupId: adminRole.id } : {}),
    ...(userRole ? { memberAccessGroupId: userRole.id } : {}),
    createdAt: input.previousState?.createdAt ?? input.nowIso,
    updatedAt: input.nowIso
  };
}
