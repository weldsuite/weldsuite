import { z } from 'zod';

// ============================================================================
// Account deletion — /api/account/*
//
// Self-service deletion of the caller's WeldSuite account (Google Play /
// GDPR requirement). Org-LESS: must work for users without a workspace.
//
//   GET  /deletion-status — what deleting the account would do / what blocks it
//   POST /delete          — permanently delete the account (typed confirmation)
// ============================================================================

/** The exact string the user must type to confirm deletion. Not localized. */
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE' as const;

export const deleteAccountInput = z.object({
  confirmation: z.literal(DELETE_ACCOUNT_CONFIRMATION),
});

export type DeleteAccountInput = z.infer<typeof deleteAccountInput>;

export interface AccountDeletionWorkspaceRef {
  workspaceId: string;
  name: string;
}

export interface AccountDeletionBlocker extends AccountDeletionWorkspaceRef {
  /** Caller is the only admin of a workspace that still has other members. */
  reason: 'sole_admin_with_members';
  otherMemberCount: number;
}

export interface AccountDeletionStatus {
  canDelete: boolean;
  /** Workspaces preventing deletion until ownership is transferred. */
  blockers: AccountDeletionBlocker[];
  /** Workspaces where the caller is the only member — deleted along with the account. */
  workspacesToDelete: AccountDeletionWorkspaceRef[];
}

export interface DeleteAccountResult {
  deleted: boolean;
}

// Response schemas, for clients and the conformance suite.

const workspaceRefSchema = z.object({ workspaceId: z.string(), name: z.string() });

export const accountDeletionStatusSchema = z.object({
  canDelete: z.boolean(),
  blockers: z.array(
    workspaceRefSchema.extend({
      reason: z.literal('sole_admin_with_members'),
      otherMemberCount: z.number().int(),
    }),
  ),
  workspacesToDelete: z.array(workspaceRefSchema),
});

export const deleteAccountResultSchema = z.object({ deleted: z.boolean() });

// ============================================================================
// Device sessions — /api/auth-sessions/* (Settings → Security)
//
// Signing the caller's own devices out at the identity provider. Strictly
// self-scoped: no permission beyond being signed in.
//
//   POST /revoke-all         — every other active session (the current one stays)
//   POST /:sessionId/revoke  — one session, after checking it is the caller's
// ============================================================================

/** `POST /revoke-all`: how many sessions were signed out, and how many the provider refused. */
export const authSessionsRevokedSchema = z.object({
  revokedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});

export type AuthSessionsRevoked = z.infer<typeof authSessionsRevokedSchema>;

/** `POST /:sessionId/revoke`. */
export const authSessionRevokedSchema = z.object({
  revoked: z.literal(true),
  sessionId: z.string(),
});

export type AuthSessionRevoked = z.infer<typeof authSessionRevokedSchema>;
