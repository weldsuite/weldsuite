import { z } from 'zod';

// ============================================================================
// Member limits and my role — the caller's seat and role context.
//
//   GET /api/member-limits  → memberLimitsSchema (general:read)
//   GET /api/my-role        → myRoleSchema (every member)
// ============================================================================

/** The workspace's member limit and the seats in use. `limit` null is unlimited. */
export const memberLimitsSchema = z.object({
  limit: z.number().int().nullable(),
  /** Members plus pending invitations that will take a seat. */
  current: z.number().int(),
  atLimit: z.boolean(),
  planName: z.string(),
  /** Set for a partner-managed workspace: the partner whose licence sets the limit. */
  managedBy: z.string().optional(),
});

export type MemberLimits = z.infer<typeof memberLimitsSchema>;

/** The caller's role and what it lets them manage; `role` null when not a member. */
export const myRoleSchema = z.object({
  role: z.string().nullable(),
  canManageMembers: z.boolean(),
  canManageRoles: z.boolean(),
});

export type MyRole = z.infer<typeof myRoleSchema>;
