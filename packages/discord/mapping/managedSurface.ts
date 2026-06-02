import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import type {
  DiscordChannelRecord,
  DiscordOperator,
  DiscordRoleRecord,
  SurfaceBootstrapInput,
  RuntimePermissionOverwrite
} from '../adapter/discordInstaller.js';

interface ManagedSurfaceNames {
  mainCategoryName: string;
  coordinationResourceName: string;
  statusResourceName: string;
  sessionsGroupName: string;
  archiveGroupName: string;
}

interface ManagedSurfaceState {
  scopeId?: string;
  mainCategoryId: string;
  coordinationResourceId: string;
  statusResourceId: string;
  sessionsCategoryId: string;
  archiveCategoryId: string;
  adminAccessGroupId?: string;
  memberAccessGroupId?: string;
  createdAt: string;
  updatedAt: string;
}

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
    | 'coordinationResourceId'
    | 'statusResourceId'
    | 'sessionsCategoryId'
    | 'archiveCategoryId';
  name: string;
  type: 'text' | 'category';
  parentId: string | null;
  permissionOverwrites: RuntimePermissionOverwrite[];
}

function surfaceNames(input: SurfaceBootstrapInput): ManagedSurfaceNames {
  return input.names as unknown as ManagedSurfaceNames;
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
  previousState: ManagedSurfaceState | null,
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
  previousState: ManagedSurfaceState | null,
  input: SurfaceBootstrapInput
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
  previousState: ManagedSurfaceState | null,
  input: SurfaceBootstrapInput
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

export async function bootstrapManagedSurface(
  operator: DiscordOperator,
  input: SurfaceBootstrapInput
) {
  const scopeId = input.scopeId ?? input.guildId ?? '';
  const names = surfaceNames(input);
  const previousState = input.previousState as unknown as ManagedSurfaceState | null;
  const existingChannels = await operator.listChannels(scopeId);
  const existingRoles = await operator.listRoles(scopeId);
  const adminRole = await ensureAdminRole(operator, scopeId, existingRoles, previousState, input);
  const refreshedRoles = await operator.listRoles(scopeId);
  const userRole = await ensureUserRole(operator, scopeId, refreshedRoles, previousState, input);
  const policy = accessPolicy({
    scopeId,
    actorId: input.actorId,
    adminAccessGroupId: adminRole?.id ?? null,
    memberAccessGroupId: userRole?.id ?? null,
    explicitAdminRoleIds: input.explicitAdminRoleIds,
    explicitAdminUserIds: input.explicitAdminUserIds
  });

  const mainCategory = await ensureResource(operator, scopeId, existingChannels, previousState, {
    key: 'mainCategoryId',
    name: names.mainCategoryName,
    type: 'category',
    parentId: null,
    permissionOverwrites: policy
  });

  const sessionsCategory = await ensureResource(operator, scopeId, existingChannels, previousState, {
    key: 'sessionsCategoryId',
    name: names.sessionsGroupName,
    type: 'category',
    parentId: null,
    permissionOverwrites: policy
  });

  const archiveCategory = await ensureResource(operator, scopeId, existingChannels, previousState, {
    key: 'archiveCategoryId',
    name: names.archiveGroupName,
    type: 'category',
    parentId: null,
    permissionOverwrites: policy
  });

  const refreshedChannels = await operator.listChannels(scopeId);

  const coordination = await ensureResource(operator, scopeId, refreshedChannels, previousState, {
    key: 'coordinationResourceId',
    name: names.coordinationResourceName,
    type: 'text',
    parentId: mainCategory.id,
    permissionOverwrites: policy
  });

  const status = await ensureResource(operator, scopeId, refreshedChannels, previousState, {
    key: 'statusResourceId',
    name: names.statusResourceName,
    type: 'text',
    parentId: mainCategory.id,
    permissionOverwrites: policy
  });

  return {
    scopeId,
    mainCategoryId: mainCategory.id,
    coordinationResourceId: coordination.id,
    statusResourceId: status.id,
    sessionsCategoryId: sessionsCategory.id,
    archiveCategoryId: archiveCategory.id,
    ...(adminRole ? { adminAccessGroupId: adminRole.id } : {}),
    ...(userRole ? { memberAccessGroupId: userRole.id } : {}),
    createdAt: previousState?.createdAt ?? input.nowIso,
    updatedAt: input.nowIso
  };
}
