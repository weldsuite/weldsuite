/**
 * App-API chat-members domain client — the WeldChat member picker roster.
 *
 * WeldChat reuses the existing workspace-member directory rather than a
 * dedicated chat roster endpoint: `GET /api/team-members` (backed by
 * `workspace_members`, visibility-projected). The chat member picker passes
 * `memberType=all` (or the legacy `include=guests`) to include guests.
 *
 * Mirrors the directory listing in apps/workers/app-api/src/routes/team-members/index.ts.
 */

import type { ClientApi, ListResponse } from '../types';
import { buildQueryString } from '../types';

export interface ChatRosterMember {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  status: string | null;
  memberType: string | null;
  roleId?: string | null;
  permissions?: string[] | null;
  [key: string]: unknown;
}

export interface ListChatMembersQuery {
  search?: string;
  status?: string;
  /** 'INTERNAL' (default) | 'EXTERNAL_GUEST' | 'all'. */
  memberType?: 'INTERNAL' | 'EXTERNAL_GUEST' | 'all';
  /** Legacy alias: 'guests' maps to memberType=all on the server. */
  include?: 'guests';
  cursor?: string;
  limit?: number;
}

export function createChatMembersApi(api: ClientApi) {
  return {
    /**
     * List the workspace member roster for the chat member picker. Defaults to
     * including guests so the picker can DM external collaborators.
     */
    list(params: ListChatMembersQuery = {}): Promise<ListResponse<ChatRosterMember>> {
      const query: Record<string, unknown> = { memberType: 'all', ...params };
      return api.get<ListResponse<ChatRosterMember>>(
        `/team-members${buildQueryString(query)}`,
      );
    },
  };
}
