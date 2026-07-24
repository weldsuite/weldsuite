import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type { Member, ListMembersQuery, InviteMemberInput, UpdateMemberRoleInput } from '../schemas/members';
import type {
  MemberProfile,
  UpdateMemberProfileInput,
  MemberNote,
  MemberNoteInput,
  CommonConceptsResponse,
  CommonConceptCategory,
  MemberActivityItem,
  ListMemberActivityQuery,
} from '../schemas/member-profile';

export function createTeamApi(api: ClientApi) {
  return {
    listMembers(params: ListMembersQuery = { limit: 25 }): Promise<ListResponse<Member>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<Member>>(`/team/members${query}`);
    },

    getMember(id: string): Promise<DataResponse<Member>> {
      return api.get<DataResponse<Member>>(`/team/members/${id}`);
    },

    // Profile (by userId)
    getMemberProfile(userId: string): Promise<DataResponse<MemberProfile>> {
      return api.get<DataResponse<MemberProfile>>(`/team/members/user/${userId}/profile`);
    },

    updateMemberProfile(
      userId: string,
      patch: UpdateMemberProfileInput,
    ): Promise<DataResponse<MemberProfile>> {
      return api.patch<DataResponse<MemberProfile>>(
        `/team/members/user/${userId}/profile`,
        patch,
      );
    },

    // Private notes (viewer-scoped)
    getMemberNote(userId: string): Promise<DataResponse<MemberNote | null>> {
      return api.get<DataResponse<MemberNote | null>>(`/team/members/user/${userId}/notes`);
    },

    upsertMemberNote(
      userId: string,
      body: MemberNoteInput,
    ): Promise<DataResponse<MemberNote>> {
      return api.put<DataResponse<MemberNote>>(`/team/members/user/${userId}/notes`, body);
    },

    deleteMemberNote(userId: string): Promise<void> {
      return api.delete<void>(`/team/members/user/${userId}/notes`);
    },

    // Activity feed (admin or self only)
    listMemberActivity(
      userId: string,
      params: ListMemberActivityQuery = { limit: 25 },
    ): Promise<ListResponse<MemberActivityItem>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<MemberActivityItem>>(
        `/team/members/user/${userId}/activity${query}`,
      );
    },

    // Common concepts between viewer and subject
    getCommonConcepts(
      userId: string,
      categories?: CommonConceptCategory[],
    ): Promise<DataResponse<CommonConceptsResponse>> {
      const query = categories && categories.length > 0
        ? `?categories=${categories.join(',')}`
        : '';
      return api.get<DataResponse<CommonConceptsResponse>>(
        `/team/members/user/${userId}/common${query}`,
      );
    },

    // Clerk sync (safety-net reconciliation)
    syncFromClerk(): Promise<DataResponse<{ synced: boolean }>> {
      return api.post<DataResponse<{ synced: boolean }>>('/team/members/sync');
    },

    // Invite a new member
    inviteMember(data: InviteMemberInput): Promise<DataResponse<{ memberId: string }>> {
      return api.post<DataResponse<{ memberId: string }>>('/team/members/invite', data);
    },

    // Remove a member or cancel a pending invitation
    removeMember(id: string): Promise<void> {
      return api.delete<void>(`/team/members/${id}`);
    },

    // Update a member's role
    updateMemberRole(id: string, data: UpdateMemberRoleInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/team/members/${id}`, data);
    },

    // Resend a pending invitation
    resendInvite(id: string): Promise<DataResponse<{ success: boolean }>> {
      return api.post<DataResponse<{ success: boolean }>>(`/team/members/${id}/resend-invite`);
    },
  };
}
