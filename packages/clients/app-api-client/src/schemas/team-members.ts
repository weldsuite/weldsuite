import { z } from 'zod';

// ============================================================================
// Team Members — workspace member directory, profiles, private notes,
// common-concepts and per-member activity.
//
// Backed by `workspace_members` (+ `user_preferences`, `member_notes`,
// `audit_logs`). Permission prefix: `team:*`.
//
// Ported from @weldsuite/core-api-client/schemas/member-profile so that
// app-api owns its own schemas and does not depend on the obsolete
// core-api-client package.
// ============================================================================

export const memberProfileLink = z.object({
  label: z.string().min(1).max(40),
  url: z.string().url().max(500),
});

export type MemberProfileLink = z.infer<typeof memberProfileLink>;

// ----------------------------------------------------------------------------
// Member management (invite / role change)
// ----------------------------------------------------------------------------

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  roleId: z.string().nullish(),
  // INTERNAL (default) → counts as a paid seat, full role.
  // EXTERNAL_GUEST → free, scoped to invited channels only. Requires the
  // `team:invite_external` permission instead of `team:create`.
  // EMPLOYEE → paid seat, My HR + WeldChat only (fixed permission set; the
  // roleId is ignored). Requires `team:create`.
  memberType: z.enum(['INTERNAL', 'EXTERNAL_GUEST', 'EMPLOYEE']).optional(),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

// Role change accepts EXACTLY ONE of:
//   - `role`   → a built-in system tier (clears any custom role; roleId set null)
//   - `roleId` → a custom workspace role row (tier derived from the role name)
// OWNER is intentionally not an accepted tier: ownership cannot be granted (or,
// for the current owner, removed) through this endpoint — see the OWNER guard
// in apps/workers/app-api/src/routes/team-members PATCH /:id.
export const updateMemberRoleSchema = z
  .object({
    role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).optional(),
    roleId: z.string().optional(),
  })
  .refine((d) => (d.role ? 1 : 0) + (d.roleId ? 1 : 0) === 1, {
    message: 'Provide exactly one of `role` or `roleId`.',
  });

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

// Member update — the full admin-side write behind PATCH /api/team-members/:id.
//
// Superset of `updateMemberRoleSchema` above, ported from api-worker
// `PUT /settings/members/:memberId`, which also wrote `name`, `permissions`
// (per-member grants layered on top of the role) and `hoursPerWeek`.
//
// The role rules are unchanged: AT MOST one of `role` / `roleId`, and OWNER is
// still not an accepted tier. The difference from `updateMemberRoleSchema` is
// "at most one" rather than "exactly one" — the legacy route allowed writing
// only `permissions` or only `hoursPerWeek`, with no role change at all, and
// the team-member panel does exactly that.
//
// `hoursPerWeek` is a STRING to match the `numeric` column (and the legacy
// contract). Not to be confused with `updateMemberProfileInput.hoursPerWeek`
// below, which is the self-service profile edit and is a number.
export const updateMemberInput = z
  .object({
    name: z.string().min(1).max(255).optional(),
    role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).optional(),
    roleId: z.string().optional(),
    permissions: z.array(z.string()).optional(),
    // Explicit per-member denies (`weldbooks:companies:read`); a deny always
    // wins over the role and the member's own grants.
    permissionDenies: z.array(z.string()).optional(),
    hoursPerWeek: z.string().optional(),
  })
  .refine((d) => (d.role ? 1 : 0) + (d.roleId ? 1 : 0) <= 1, {
    message: 'Provide at most one of `role` or `roleId`.',
  });

export type UpdateMemberInput = z.infer<typeof updateMemberInput>;

// ----------------------------------------------------------------------------
// Profile update input (partial profile edit — self or admin)
// ----------------------------------------------------------------------------

export const updateMemberProfileInput = z
  .object({
    title: z.string().max(120).nullable(),
    bio: z.string().max(4000).nullable(),
    phone: z.string().max(40).nullable(),
    location: z.string().max(120).nullable(),
    pronouns: z.string().max(40).nullable(),
    links: z.array(memberProfileLink).max(10).nullable(),
    hoursPerWeek: z.number().min(0).max(168).nullable(),
    // workingHours: flexible JSON from helpdesk-agents' WorkingHours shape
    workingHours: z.record(z.string(), z.any()).nullable(),
    timezone: z.string().max(100),
  })
  .partial();

export type UpdateMemberProfileInput = z.infer<typeof updateMemberProfileInput>;

// ----------------------------------------------------------------------------
// Notes
// ----------------------------------------------------------------------------

export const memberNoteInput = z.object({
  body: z.string().max(20000),
});

export type MemberNoteInput = z.infer<typeof memberNoteInput>;

export interface MemberNote {
  id: string;
  authorUserId: string;
  subjectUserId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------------------------
// Profile response (shared profile view shown in the team member panel)
// ----------------------------------------------------------------------------

export interface DayHours {
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
  breaks?: { start: string; end: string }[];
}

export interface WorkingHours {
  monday?: DayHours;
  tuesday?: DayHours;
  wednesday?: DayHours;
  thursday?: DayHours;
  friday?: DayHours;
  saturday?: DayHours;
  sunday?: DayHours;
}

export interface MemberProfile {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  role: string;
  status: string;

  // Profile
  title: string | null;
  bio: string | null;
  phone: string | null;
  location: string | null;
  pronouns: string | null;
  links: MemberProfileLink[] | null;

  // Work
  hoursPerWeek: string | null;
  workingHours: WorkingHours | null;
  timezone: string;

  // Edit capability for the viewer
  canEdit: boolean;
}

// ----------------------------------------------------------------------------
// Common concepts — things that link the viewer and the subject together
// ----------------------------------------------------------------------------

export type CommonConceptCategory =
  | 'channels'
  | 'projects'
  | 'tasks'
  | 'crm'
  | 'helpdesk';

export const commonConceptsQuery = z.object({
  categories: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? (v.split(',').filter(Boolean) as CommonConceptCategory[])
        : (['channels', 'projects', 'tasks', 'crm', 'helpdesk'] as CommonConceptCategory[]),
    ),
});

export type CommonConceptsQuery = z.infer<typeof commonConceptsQuery>;

export interface CommonChannel {
  id: string;
  name: string;
  type: 'public' | 'private' | 'dm';
  memberCount: number;
}

export interface CommonProject {
  id: string;
  name: string;
  status: string | null;
  color: string | null;
}

export interface CommonTask {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  dueDate: string | null;
  role: 'shared_assignee' | 'shared_watcher' | 'delegated';
}

export interface CommonCrmRecord {
  id: string;
  kind: 'opportunity' | 'activity';
  name: string;
  status: string | null;
}

export interface CommonHelpdeskItem {
  id: string;
  kind: 'conversation' | 'ticket';
  subject: string;
  status: string;
}

export interface CommonConceptsResponse {
  channels: CommonChannel[];
  projects: CommonProject[];
  tasks: CommonTask[];
  crm: CommonCrmRecord[];
  helpdesk: CommonHelpdeskItem[];
}

// ----------------------------------------------------------------------------
// Activity feed (admin-only)
// ----------------------------------------------------------------------------

export const listMemberActivityQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
});

export type ListMemberActivityQuery = z.infer<typeof listMemberActivityQuery>;

export interface MemberActivityItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  createdAt: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
}

// ----------------------------------------------------------------------------
// Response schemas (what the directory routes answer), for clients that parse
// and for the Rust conformance suite.
// ----------------------------------------------------------------------------

/** GET /api/team-members/me: the caller's own member row. */
export const teamMemberSelfSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  picture: z.string().nullable(),
  role: z.string(),
  roleId: z.string().nullable(),
  permissions: z.array(z.string()).nullable(),
  status: z.string(),
  memberType: z.string(),
});

/**
 * A directory row, projected by visibility: the public fields always, the
 * viewer's own row adds email / roleId / permissions, admins see the invite
 * fields too.
 */
export const teamMemberListItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().nullable(),
  picture: z.string().nullable(),
  role: z.string(),
  status: z.string(),
  memberType: z.string(),
  email: z.string().nullable().optional(),
  roleId: z.string().nullable().optional(),
  permissions: z.array(z.string()).nullable().optional(),
  invitedBy: z.string().nullable().optional(),
  invitedAt: z.string().nullable().optional(),
  acceptedAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});

/** GET /api/team-members/:id/permissions. */
export const memberPermissionsBreakdownSchema = z.object({
  effective: z.array(z.string()),
  rolePermissions: z.array(z.string()),
  memberOverrides: z.array(z.string()),
  memberDenies: z.array(z.string()),
  inheritedPermissions: z.array(z.string()),
  role: z.string(),
  roleId: z.string().nullable(),
});

/** One item of GET /api/team-members/:id/apps. */
export const memberAppAssignmentSchema = z.object({
  appCode: z.string(),
  appName: z.string(),
  isAssigned: z.boolean(),
  assignedAt: z.string().nullable(),
  assignedBy: z.string().nullable(),
});

/** POST /api/team-members/:id/apps/toggle. */
export const memberAppToggleResultSchema = z.object({
  appCode: z.string(),
  enabled: z.boolean(),
});

/** GET|PATCH /api/team-members/user/:userId/profile. */
export const memberProfileSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  picture: z.string().nullable(),
  role: z.string(),
  status: z.string(),
  title: z.string().nullable(),
  bio: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  pronouns: z.string().nullable(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).nullable(),
  hoursPerWeek: z.string().nullable(),
  workingHours: z.record(z.string(), z.unknown()).nullable(),
  timezone: z.string(),
  canEdit: z.boolean(),
});

/** A private note (`MemberNote`). */
export const memberNoteSchema = z.object({
  id: z.string(),
  authorUserId: z.string(),
  subjectUserId: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** GET /api/team-members/user/:userId/common. */
export const commonConceptsResponseSchema = z.object({
  channels: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), memberCount: z.number() })),
  projects: z.array(
    z.object({ id: z.string(), name: z.string(), status: z.string().nullable(), color: z.string().nullable() }),
  ),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      projectId: z.string().nullable(),
      dueDate: z.string().nullable(),
      role: z.enum(['shared_assignee', 'shared_watcher', 'delegated']),
    }),
  ),
  crm: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['opportunity', 'activity']),
      name: z.string(),
      status: z.string().nullable(),
    }),
  ),
  helpdesk: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['conversation', 'ticket']),
      subject: z.string(),
      status: z.string(),
    }),
  ),
});

/** One item of GET /api/team-members/user/:userId/activity. */
export const memberActivityItemSchema = z.object({
  id: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  description: z.string(),
  createdAt: z.string(),
  changes: z.record(z.string(), z.unknown()).nullable(),
});
