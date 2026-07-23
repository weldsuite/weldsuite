import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  pgEnum,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';

// Team role enum
export const socialTeamRoleEnum = pgEnum('social_team_role', [
  'owner',
  'admin',
  'manager',
  'editor',
  'contributor',
  'viewer',
]);

// Notification preferences interface
export interface SocialNotificationPreferences {
  postPublished?: boolean;
  postScheduled?: boolean;
  postFailed?: boolean;
  approvalRequested?: boolean;
  approvalDecision?: boolean;
  newComment?: boolean;
  mentionAlert?: boolean;
  dailyDigest?: boolean;
  weeklyReport?: boolean;
  channels?: ('email' | 'push' | 'slack')[];
}

// Permission set interface
export interface SocialPermissions {
  // Account management
  canConnectAccounts?: boolean;
  canDisconnectAccounts?: boolean;
  canViewAllAccounts?: boolean;
  // Post management
  canCreatePosts?: boolean;
  canEditAnyPost?: boolean;
  canDeleteAnyPost?: boolean;
  canSchedulePosts?: boolean;
  canPublishImmediately?: boolean;
  // Approval workflow
  canApprove?: boolean;
  canRequestApproval?: boolean;
  bypassApproval?: boolean;
  // Media library
  canUploadMedia?: boolean;
  canDeleteMedia?: boolean;
  canOrganizeMedia?: boolean;
  // Analytics
  canViewAnalytics?: boolean;
  canExportAnalytics?: boolean;
  // Team management
  canInviteMembers?: boolean;
  canRemoveMembers?: boolean;
  canChangeRoles?: boolean;
  // Settings
  canManageSettings?: boolean;
  canManageIntegrations?: boolean;
}

// Account access level interface
export interface SocialAccountAccess {
  accountId: string;
  canView: boolean;
  canPost: boolean;
  canAnalyze: boolean;
}

export const socialTeamMembers = pgTable('social_team_members', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // User reference (Clerk user ID)
  userId: varchar('user_id', { length: 255 }).notNull(),

  // User info (cached from Clerk)
  email: varchar('email', { length: 255 }),
  name: varchar('name', { length: 255 }),
  avatarUrl: varchar('avatar_url', { length: 500 }),

  // Role
  role: socialTeamRoleEnum('role').notNull().default('contributor'),

  // Custom permissions (override role defaults)
  permissions: jsonb('permissions').$type<SocialPermissions>(),

  // Account-level access (which social accounts can they access)
  accountAccess: jsonb('account_access').$type<SocialAccountAccess[]>(),
  canAccessAllAccounts: boolean('can_access_all_accounts').default(false),

  // Status
  isActive: boolean('is_active').notNull().default(true),

  // Invitation tracking
  invitedByUserId: varchar('invited_by_user_id', { length: 255 }),
  invitedAt: timestamp('invited_at'),
  acceptedAt: timestamp('accepted_at'),

  // Last activity
  lastActiveAt: timestamp('last_active_at'),

  // Notification preferences
  notificationPreferences: jsonb('notification_preferences').$type<SocialNotificationPreferences>(),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('social_team_members_user_idx').on(table.userId),
  index('social_team_members_role_idx').on(table.role),
  index('social_team_members_is_active_idx').on(table.isActive),
  unique('social_team_members_unique').on(table.userId),
]);

export type SocialTeamMember = typeof socialTeamMembers.$inferSelect;
export type NewSocialTeamMember = typeof socialTeamMembers.$inferInsert;

// Default permissions by role
export const SOCIAL_ROLE_PERMISSIONS: Record<string, SocialPermissions> = {
  owner: {
    canConnectAccounts: true,
    canDisconnectAccounts: true,
    canViewAllAccounts: true,
    canCreatePosts: true,
    canEditAnyPost: true,
    canDeleteAnyPost: true,
    canSchedulePosts: true,
    canPublishImmediately: true,
    canApprove: true,
    canRequestApproval: true,
    bypassApproval: true,
    canUploadMedia: true,
    canDeleteMedia: true,
    canOrganizeMedia: true,
    canViewAnalytics: true,
    canExportAnalytics: true,
    canInviteMembers: true,
    canRemoveMembers: true,
    canChangeRoles: true,
    canManageSettings: true,
    canManageIntegrations: true,
  },
  admin: {
    canConnectAccounts: true,
    canDisconnectAccounts: true,
    canViewAllAccounts: true,
    canCreatePosts: true,
    canEditAnyPost: true,
    canDeleteAnyPost: true,
    canSchedulePosts: true,
    canPublishImmediately: true,
    canApprove: true,
    canRequestApproval: true,
    bypassApproval: true,
    canUploadMedia: true,
    canDeleteMedia: true,
    canOrganizeMedia: true,
    canViewAnalytics: true,
    canExportAnalytics: true,
    canInviteMembers: true,
    canRemoveMembers: true,
    canChangeRoles: true,
    canManageSettings: true,
    canManageIntegrations: true,
  },
  manager: {
    canConnectAccounts: false,
    canDisconnectAccounts: false,
    canViewAllAccounts: true,
    canCreatePosts: true,
    canEditAnyPost: true,
    canDeleteAnyPost: true,
    canSchedulePosts: true,
    canPublishImmediately: true,
    canApprove: true,
    canRequestApproval: true,
    bypassApproval: false,
    canUploadMedia: true,
    canDeleteMedia: true,
    canOrganizeMedia: true,
    canViewAnalytics: true,
    canExportAnalytics: true,
    canInviteMembers: true,
    canRemoveMembers: false,
    canChangeRoles: false,
    canManageSettings: false,
    canManageIntegrations: false,
  },
  editor: {
    canConnectAccounts: false,
    canDisconnectAccounts: false,
    canViewAllAccounts: false,
    canCreatePosts: true,
    canEditAnyPost: false,
    canDeleteAnyPost: false,
    canSchedulePosts: true,
    canPublishImmediately: false,
    canApprove: false,
    canRequestApproval: true,
    bypassApproval: false,
    canUploadMedia: true,
    canDeleteMedia: false,
    canOrganizeMedia: true,
    canViewAnalytics: true,
    canExportAnalytics: false,
    canInviteMembers: false,
    canRemoveMembers: false,
    canChangeRoles: false,
    canManageSettings: false,
    canManageIntegrations: false,
  },
  contributor: {
    canConnectAccounts: false,
    canDisconnectAccounts: false,
    canViewAllAccounts: false,
    canCreatePosts: true,
    canEditAnyPost: false,
    canDeleteAnyPost: false,
    canSchedulePosts: false,
    canPublishImmediately: false,
    canApprove: false,
    canRequestApproval: true,
    bypassApproval: false,
    canUploadMedia: true,
    canDeleteMedia: false,
    canOrganizeMedia: false,
    canViewAnalytics: false,
    canExportAnalytics: false,
    canInviteMembers: false,
    canRemoveMembers: false,
    canChangeRoles: false,
    canManageSettings: false,
    canManageIntegrations: false,
  },
  viewer: {
    canConnectAccounts: false,
    canDisconnectAccounts: false,
    canViewAllAccounts: false,
    canCreatePosts: false,
    canEditAnyPost: false,
    canDeleteAnyPost: false,
    canSchedulePosts: false,
    canPublishImmediately: false,
    canApprove: false,
    canRequestApproval: false,
    bypassApproval: false,
    canUploadMedia: false,
    canDeleteMedia: false,
    canOrganizeMedia: false,
    canViewAnalytics: true,
    canExportAnalytics: false,
    canInviteMembers: false,
    canRemoveMembers: false,
    canChangeRoles: false,
    canManageSettings: false,
    canManageIntegrations: false,
  },
};
