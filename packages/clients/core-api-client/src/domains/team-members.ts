/**
 * App-API team-members domain client.
 *
 * Full team & membership surface on the flat `/team-members/*` endpoints of
 * app-api (successor of core-api's `/team/members/*`):
 *
 *   GET    /team-members                          — directory listing
 *   GET    /team-members/me                       — current user's member row
 *   GET    /team-members/:id                      — single member
 *   PATCH  /team-members/:id                      — change role
 *   DELETE /team-members/:id                      — remove / cancel invite (204)
 *   POST   /team-members/sync                     — reconcile vs Clerk
 *   POST   /team-members/invite                   — invite member / guest
 *   POST   /team-members/:id/resend-invite        — re-issue invitation
 *   GET/PATCH  /team-members/user/:userId/profile — member profile
 *   GET/PUT/DELETE /team-members/user/:userId/notes — viewer's private note
 *   GET    /team-members/user/:userId/common      — shared concepts
 *   GET    /team-members/user/:userId/activity    — audit-log feed
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  Member,
  ListMembersQuery,
  InviteMemberInput,
  UpdateMemberRoleInput,
} from '../schemas/members';
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

export interface TeamMemberListItem {
  id: string;
  userId: string;
  name: string;
  email: string;
  picture: string | null;
  role: string;
  status: string;
}

export interface CurrentMember {
  id: string;
  userId: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  role: string;
  roleId: string | null;
  permissions: string[] | null;
  status: string;
  memberType: 'INTERNAL' | 'EXTERNAL_GUEST';
}

export interface InviteMemberResult {
  memberId: string;
  memberType: 'INTERNAL' | 'EXTERNAL_GUEST';
  /** True when the invitee already had a Clerk identity and was added directly. */
  activated: boolean;
}

export function createTeamMembersApi(api: ClientApi) {
  return {
    // ── Directory ──────────────────────────────────────────────────────────

    list(): Promise<DataResponse<TeamMemberListItem[]>> {
      return api.get<DataResponse<TeamMemberListItem[]>>('/team-members');
    },

    listMembers(params: Partial<ListMembersQuery> = {}): Promise<ListResponse<Member>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<Member>>(`/team-members${query}`);
    },

    getMe(): Promise<DataResponse<CurrentMember>> {
      return api.get<DataResponse<CurrentMember>>('/team-members/me');
    },

    getMember(id: string): Promise<DataResponse<Member>> {
      return api.get<DataResponse<Member>>(`/team-members/${id}`);
    },

    // ── Manage (Clerk-synced) ──────────────────────────────────────────────

    syncFromClerk(): Promise<DataResponse<{ synced: boolean }>> {
      return api.post<DataResponse<{ synced: boolean }>>('/team-members/sync');
    },

    inviteMember(data: InviteMemberInput): Promise<DataResponse<InviteMemberResult>> {
      return api.post<DataResponse<InviteMemberResult>>('/team-members/invite', data);
    },

    removeMember(id: string): Promise<void> {
      return api.delete<void>(`/team-members/${id}`);
    },

    updateMemberRole(id: string, data: UpdateMemberRoleInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/team-members/${id}`, data);
    },

    resendInvite(id: string): Promise<DataResponse<{ success: boolean }>> {
      return api.post<DataResponse<{ success: boolean }>>(`/team-members/${id}/resend-invite`);
    },

    // ── Profile (by userId) ────────────────────────────────────────────────

    getProfile(userId: string): Promise<DataResponse<MemberProfile>> {
      return api.get<DataResponse<MemberProfile>>(`/team-members/user/${userId}/profile`);
    },

    updateProfile(
      userId: string,
      patch: UpdateMemberProfileInput,
    ): Promise<DataResponse<MemberProfile>> {
      return api.patch<DataResponse<MemberProfile>>(
        `/team-members/user/${userId}/profile`,
        patch,
      );
    },

    // ── Private notes (viewer-scoped) ──────────────────────────────────────

    getMyNote(userId: string): Promise<DataResponse<MemberNote | null>> {
      return api.get<DataResponse<MemberNote | null>>(`/team-members/user/${userId}/notes`);
    },

    upsertMyNote(
      userId: string,
      body: MemberNoteInput,
    ): Promise<DataResponse<MemberNote>> {
      return api.put<DataResponse<MemberNote>>(`/team-members/user/${userId}/notes`, body);
    },

    deleteMyNote(userId: string): Promise<void> {
      return api.delete<void>(`/team-members/user/${userId}/notes`);
    },

    // ── Common concepts between viewer and subject ─────────────────────────

    getCommonConcepts(
      userId: string,
      categories?: CommonConceptCategory[],
    ): Promise<DataResponse<CommonConceptsResponse>> {
      const query = categories && categories.length > 0
        ? `?categories=${categories.join(',')}`
        : '';
      return api.get<DataResponse<CommonConceptsResponse>>(
        `/team-members/user/${userId}/common${query}`,
      );
    },

    // ── Activity feed (admin or self only) ─────────────────────────────────

    listActivity(
      userId: string,
      params: ListMemberActivityQuery = { limit: 25 },
    ): Promise<ListResponse<MemberActivityItem>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<MemberActivityItem>>(
        `/team-members/user/${userId}/activity${query}`,
      );
    },
  };
}
