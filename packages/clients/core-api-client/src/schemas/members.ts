import { z } from 'zod';

// ============================================================================
// Input Schemas
// ============================================================================

export const listMembersQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: z.string().optional(),
  /**
   * Filter by member type. Defaults server-side to 'INTERNAL' so the
   * existing team admin views don't suddenly start showing guests.
   * Pass 'all' for the team-settings table (which renders both with a
   * distinguishing badge), or 'EXTERNAL_GUEST' to list only guests.
   */
  memberType: z.enum(['INTERNAL', 'EXTERNAL_GUEST', 'all']).optional(),
});

export const inviteMemberInput = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  roleId: z.string().nullish(),
  memberType: z.enum(['INTERNAL', 'EXTERNAL_GUEST']).optional(),
});

export const updateMemberRoleInput = z.object({
  roleId: z.string(),
});

// ============================================================================
// Inferred Input Types
// ============================================================================

export type ListMembersQuery = z.infer<typeof listMembersQuery>;
export type InviteMemberInput = z.infer<typeof inviteMemberInput>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleInput>;

// ============================================================================
// Response Types (field visibility levels)
// ============================================================================

/** Fields visible to all authenticated users. */
export interface MemberPublic {
  id: string;
  userId: string;
  name: string | null;
  picture: string | null;
  role: string;
  status: string;
  memberType: 'INTERNAL' | 'EXTERNAL_GUEST';
}

/** Fields visible to the member themselves (extends public). */
export interface MemberSelf extends MemberPublic {
  email: string | null;
  roleId: string | null;
  permissions: string[];
}

/** Fields visible to admins with settings:team:read (extends self). */
export interface MemberAdmin extends MemberSelf {
  invitedBy: string | null;
  invitedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

/**
 * Union type for member responses — the actual shape depends on
 * the viewer's permissions. Use type guards to narrow:
 *
 * ```ts
 * if ('email' in member) { // MemberSelf or MemberAdmin }
 * if ('invitedBy' in member) { // MemberAdmin }
 * ```
 */
export type Member = MemberPublic | MemberSelf | MemberAdmin;
