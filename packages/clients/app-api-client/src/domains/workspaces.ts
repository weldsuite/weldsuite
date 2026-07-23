/**
 * App-API workspaces domain client — read-only `/api/workspaces`.
 *
 * Lists the workspaces the authenticated user belongs to (for a workspace
 * switcher). `id` is the Clerk org id used to switch orgs; `workspaceId` is
 * the internal master-DB id.
 */

import type { ClientApi, DataResponse } from '../types';

export interface WorkspaceSummary {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  role: string;
}

export function createWorkspacesApi(api: ClientApi) {
  return {
    list(): Promise<DataResponse<WorkspaceSummary[]>> {
      return api.get<DataResponse<WorkspaceSummary[]>>('/workspaces');
    },
  };
}
