import { z } from 'zod';

// ============================================================================
// Member limits and my role — the caller's seat and role context.
//
//   GET /api/member-limits  → memberLimitsSchema (general:read)
//   GET /api/my-role        → myRoleSchema (every member)
//   GET /api/prepaid-seats  → prepaidSeatsSchema (general:read)
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

/**
 * The seats the workspace has paid for and how many are in use: the plan's
 * included users plus purchased seats (a partner licence's cap for a
 * partner-managed workspace; without a cap `prepaidSeats` equals
 * `usedSeats` and `canAddMore` is true).
 */
export const prepaidSeatsSchema = z.object({
  prepaidSeats: z.number().int(),
  /** Members plus pending invitations that will take a seat. */
  usedSeats: z.number().int(),
  availableSeats: z.number().int().nonnegative(),
  canAddMore: z.boolean(),
});

export type PrepaidSeats = z.infer<typeof prepaidSeatsSchema>;
