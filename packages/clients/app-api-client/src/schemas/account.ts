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
