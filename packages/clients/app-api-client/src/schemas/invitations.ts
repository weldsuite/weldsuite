import { z } from 'zod';

// ============================================================================
// Invitations: /api/invitations (session only, no workspace needed).
//
//   GET  /:token  the invitation's details
//   POST /accept  link the caller to their invited member row
// ============================================================================

export const invitationDetailsSchema = z.object({
  /** The Clerk org id of the inviting workspace. */
  workspaceId: z.string(),
  workspaceName: z.string(),
  role: z.string(),
  inviteeEmail: z.string(),
  inviteeName: z.string(),
  isExpired: z.boolean(),
  isUsed: z.boolean(),
  expiresAt: z.string().optional(),
});

export type InvitationDetails = z.infer<typeof invitationDetailsSchema>;

export const acceptedInvitationSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  role: z.string(),
});

export type AcceptedInvitation = z.infer<typeof acceptedInvitationSchema>;
