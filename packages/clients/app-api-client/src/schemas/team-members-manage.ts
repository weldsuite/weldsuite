import { z } from 'zod';

// ============================================================================
// Team members — what the managing routes answer (the request schemas are in
// ./team-members.ts).
//
//   POST   /api/team-members/sync                → teamMembersSyncResultSchema
//   POST   /api/team-members/invite              → inviteMemberResultSchema
//   PATCH  /api/team-members/:id                 → updateMemberResultSchema
//   DELETE /api/team-members/:id                 → 204
//   POST   /api/team-members/:id/resend-invite   → resendInviteResultSchema
// ============================================================================

export const teamMembersSyncResultSchema = z.object({ synced: z.literal(true) });

/** `activated` is true when a guest with an account was added straight away. */
export const inviteMemberResultSchema = z.object({
  memberId: z.string(),
  memberType: z.enum(['INTERNAL', 'EXTERNAL_GUEST', 'EMPLOYEE']),
  activated: z.boolean(),
});

export type InviteMemberResult = z.infer<typeof inviteMemberResultSchema>;

export const updateMemberResultSchema = z.object({ id: z.string() });

export const resendInviteResultSchema = z.object({ success: z.literal(true) });
