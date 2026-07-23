import { pgTable, varchar, text, timestamp, jsonb, numeric, index, unique } from 'drizzle-orm/pg-core';

export interface MemberProfileLink {
  label: string;
  url: string;
}

// Workspace members - tracks users in a workspace with their roles
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: varchar('id', { length: 30 }).primaryKey(),

    // User reference (Clerk user ID)
    userId: varchar('user_id', { length: 255 }).notNull(),

    // User info (cached from Clerk for display)
    email: varchar('email', { length: 255 }),
    name: varchar('name', { length: 255 }),
    picture: varchar('picture', { length: 500 }),

    // Role in workspace: OWNER, ADMIN, MEMBER, VIEWER
    role: varchar('role', { length: 20 }).notNull().default('MEMBER'),

    // Custom role reference (for custom roles)
    roleId: varchar('role_id', { length: 30 }),

    // Additional permissions beyond role
    permissions: jsonb('permissions').$type<string[]>().default([]),

    // Working hours per week (defaults to 40 in application code)
    hoursPerWeek: numeric('hours_per_week', { precision: 5, scale: 2 }),

    // Profile fields (self-editable; admins can edit anyone)
    title: varchar('title', { length: 120 }),
    bio: text('bio'),
    phone: varchar('phone', { length: 40 }),
    location: varchar('location', { length: 120 }),
    pronouns: varchar('pronouns', { length: 40 }),
    links: jsonb('links').$type<MemberProfileLink[]>(),

    // Status: ACTIVE, PENDING (invited but not accepted), SUSPENDED
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),

    // Member type: INTERNAL (workspace employee, counts as a paid seat),
    // EXTERNAL_GUEST (outside collaborator scoped to invited channels, free).
    memberType: varchar('member_type', { length: 20 }).notNull().default('INTERNAL'),

    // Invitation tracking
    invitedBy: varchar('invited_by', { length: 255 }),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),

    // Clerk identifiers for sync
    clerkMembershipId: varchar('clerk_membership_id', { length: 255 }),
    clerkInvitationId: varchar('clerk_invitation_id', { length: 255 }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('workspace_members_user_idx').on(table.userId),
    index('workspace_members_clerk_invitation_idx').on(table.clerkInvitationId),
    index('workspace_members_member_type_idx').on(table.memberType),
    unique('workspace_members_unique').on(table.userId),
  ]
);

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
