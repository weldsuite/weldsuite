/**
 * Team Members Query Hooks
 *
 * Uses the app-api `/api/team-members/*` endpoints via the
 * `teamMembers` domain client (useAppApi).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type { ListMembersQuery, InviteMemberInput, UpdateMemberRoleInput } from '@weldsuite/core-api-client/schemas/members';
import type {
  UpdateMemberProfileInput,
  MemberNoteInput,
  CommonConceptCategory,
  MemberProfile,
  MemberNote,
  ListMemberActivityQuery,
} from '@weldsuite/core-api-client/schemas/member-profile';

export const teamKeys = {
  all: ['team'] as const,
  members: () => [...teamKeys.all, 'members'] as const,
  memberList: (params?: ListMembersQuery) => [...teamKeys.members(), params ?? {}] as const,
  member: (id: string) => [...teamKeys.members(), id] as const,
  profile: (userId: string) => [...teamKeys.all, 'profile', userId] as const,
  note: (userId: string) => [...teamKeys.all, 'note', userId] as const,
  common: (userId: string, categories?: CommonConceptCategory[]) =>
    [...teamKeys.all, 'common', userId, categories ?? 'all'] as const,
  activity: (userId: string, params?: ListMemberActivityQuery) =>
    [...teamKeys.all, 'activity', userId, params ?? {}] as const,
};

export function useTeamMembers(params?: ListMembersQuery | undefined) {
  const { teamMembers: team } = useAppApi();

  return useQuery({
    queryKey: teamKeys.memberList(params),
    queryFn: () => team.listMembers(params!),
    enabled: params !== undefined,
  });
}

export function useTeamMember(id: string) {
  const { teamMembers: team } = useAppApi();

  return useQuery({
    queryKey: teamKeys.member(id),
    queryFn: () => team.getMember(id),
    enabled: !!id,
  });
}

// ============================================================================
// Profile panel hooks
// ============================================================================

export function useMemberProfile(userId: string | null | undefined) {
  const { teamMembers: team } = useAppApi();

  return useQuery({
    queryKey: teamKeys.profile(userId ?? ''),
    queryFn: () => team.getProfile(userId!),
    enabled: !!userId,
    select: (res) => res.data,
  });
}

export function useUpdateMemberProfile(userId: string) {
  const { teamMembers: team } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (patch: UpdateMemberProfileInput) => team.updateProfile(userId, patch),
    onSuccess: (res) => {
      qc.setQueryData(teamKeys.profile(userId), res);
      qc.invalidateQueries({ queryKey: teamKeys.members() });
    },
  });
}

export function useMemberNote(userId: string | null | undefined) {
  const { teamMembers: team } = useAppApi();

  return useQuery({
    queryKey: teamKeys.note(userId ?? ''),
    queryFn: () => team.getMyNote(userId!),
    enabled: !!userId,
    select: (res) => res.data,
  });
}

export function useUpsertMemberNote(userId: string) {
  const { teamMembers: team } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (body: MemberNoteInput) => team.upsertMyNote(userId, body),
    onSuccess: (res) => {
      qc.setQueryData(teamKeys.note(userId), res);
    },
  });
}

function useDeleteMemberNote(userId: string) {
  const { teamMembers: team } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: () => team.deleteMyNote(userId),
    onSuccess: () => {
      qc.setQueryData(teamKeys.note(userId), { data: null });
    },
  });
}

export function useCommonConcepts(
  userId: string | null | undefined,
  categories?: CommonConceptCategory[],
) {
  const { teamMembers: team } = useAppApi();

  return useQuery({
    queryKey: teamKeys.common(userId ?? '', categories),
    queryFn: () => team.getCommonConcepts(userId!, categories),
    enabled: !!userId,
    select: (res) => res.data,
  });
}

export function useMemberActivity(
  userId: string | null | undefined,
  params?: ListMemberActivityQuery,
  options?: { enabled?: boolean },
) {
  const { teamMembers: team } = useAppApi();
  const enabled = options?.enabled ?? true;

  return useQuery({
    queryKey: teamKeys.activity(userId ?? '', params),
    queryFn: () => team.listActivity(userId!, params ?? { limit: 25 }),
    enabled: !!userId && enabled,
  });
}

// ============================================================================
// Pending invitations
// ============================================================================

export function usePendingMembers(enabled = true) {
  const { teamMembers: team } = useAppApi();

  // memberType: 'all' so PENDING external guest invites surface in the
  // Pending section alongside internal invites.
  return useQuery({
    queryKey: teamKeys.memberList({ limit: 100, status: 'PENDING', memberType: 'all' }),
    queryFn: () => team.listMembers({ limit: 100, status: 'PENDING', memberType: 'all' }),
    enabled,
  });
}

// ============================================================================
// Mutations
// ============================================================================

export function useSyncTeamFromClerk() {
  const { teamMembers: team } = useAppApi();

  return useMutation({
    mutationFn: () => team.syncFromClerk(),
  });
}

function useInviteMember() {
  const { teamMembers: team } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (data: InviteMemberInput) => team.inviteMember(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamKeys.all });
    },
  });
}

export function useRemoveMember() {
  const { teamMembers: team } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => team.removeMember(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamKeys.all });
    },
  });
}

function useUpdateMemberRole() {
  const { teamMembers: team } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateMemberRoleInput }) =>
      team.updateMemberRole(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamKeys.all });
    },
  });
}

export function useResendInvite() {
  const { teamMembers: team } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => team.resendInvite(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamKeys.all });
    },
  });
}

;
