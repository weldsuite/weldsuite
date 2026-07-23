/**
 * App-API workspace-settings domain client — `/api/workspace-settings`.
 *
 * Name (PUT /name, owner or admin) + slug (POST /slug, owner only) mutations,
 * and owner-only workspace deletion.
 */

import type { ClientApi, DataResponse } from '../types';
import type {
  DeleteWorkspaceInput,
  DeleteWorkspaceResult,
  UpdateWorkspaceNameInput,
  UpdateWorkspaceSlugInput,
  WorkspaceDeletionStatus,
  WorkspaceNameUpdated,
  WorkspaceSlugUpdated,
} from '../schemas/workspace-settings';

export function createWorkspaceSettingsApi(api: ClientApi) {
  return {
    updateName(data: UpdateWorkspaceNameInput): Promise<DataResponse<WorkspaceNameUpdated>> {
      return api.put<DataResponse<WorkspaceNameUpdated>>('/workspace-settings/name', data);
    },

    updateSlug(data: UpdateWorkspaceSlugInput): Promise<DataResponse<WorkspaceSlugUpdated>> {
      return api.post<DataResponse<WorkspaceSlugUpdated>>('/workspace-settings/slug', data);
    },

    getDeletionStatus(): Promise<DataResponse<WorkspaceDeletionStatus>> {
      return api.get<DataResponse<WorkspaceDeletionStatus>>('/workspace-settings/deletion-status');
    },

    deleteWorkspace(data: DeleteWorkspaceInput): Promise<DataResponse<DeleteWorkspaceResult>> {
      return api.post<DataResponse<DeleteWorkspaceResult>>('/workspace-settings/delete', data);
    },
  };
}
