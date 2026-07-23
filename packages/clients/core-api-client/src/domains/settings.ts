import type { ClientApi, DataResponse } from '../types';
import type {
  UpdateWorkspaceSlugInput,
  WorkspaceSlugUpdated,
  UpdateWorkspaceNameInput,
  WorkspaceNameUpdated,
} from '../schemas/workspace';

export function createSettingsApi(api: ClientApi) {
  return {
    updateWorkspaceSlug(
      input: UpdateWorkspaceSlugInput,
    ): Promise<DataResponse<WorkspaceSlugUpdated>> {
      return api.post<DataResponse<WorkspaceSlugUpdated>>(
        '/settings/workspace/slug',
        input,
      );
    },

    updateWorkspaceName(
      input: UpdateWorkspaceNameInput,
    ): Promise<DataResponse<WorkspaceNameUpdated>> {
      return api.put<DataResponse<WorkspaceNameUpdated>>(
        '/settings/workspace/name',
        input,
      );
    },
  };
}
