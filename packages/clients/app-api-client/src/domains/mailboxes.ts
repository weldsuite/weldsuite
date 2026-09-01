/**
 * App-API mailboxes domain client — org-less `GET /api/mailboxes`.
 *
 * Lists every workspace mailbox the authenticated user can see, so WeldMail
 * can render a multi-workspace sidebar without flipping the active Clerk org
 * first. Personal inboxes are not included (those live on personal-api).
 */

import type { ClientApi, DataResponse } from '../types';

export interface MailboxAccount {
  id: string;
  email: string;
  displayName: string;
  provider: string | null;
  isDefault: boolean;
  status: string;
}

export interface WorkspaceMailboxGroup {
  clerkOrgId: string;
  workspaceId: string;
  workspaceName: string;
  slug: string;
  imageUrl: string | null;
  role: string;
  accounts: MailboxAccount[];
}

export function createMailboxesApi(api: ClientApi) {
  return {
    list(): Promise<DataResponse<WorkspaceMailboxGroup[]>> {
      return api.get<DataResponse<WorkspaceMailboxGroup[]>>('/mailboxes');
    },
  };
}
