/**
 * App-API workspace agents domain client — `/api/weldagent/agents/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateWorkspaceAgentInput,
  UpdateWorkspaceAgentInput,
  RunWorkspaceAgentInput,
  WorkspaceAgent,
  WorkspaceAgentRun,
  WorkspaceAgentToolCatalogItem,
} from '../schemas/workspace-agents';

export function createWorkspaceAgentsApi(api: ClientApi) {
  return {
    list(status?: string): Promise<DataResponse<WorkspaceAgent[]>> {
      return api.get<DataResponse<WorkspaceAgent[]>>(
        `/weldagent/agents${buildQueryString({ status })}`,
      );
    },

    get(id: string): Promise<DataResponse<WorkspaceAgent & { availableTools?: WorkspaceAgentToolCatalogItem[] }>> {
      return api.get(`/weldagent/agents/${id}`);
    },

    create(data: CreateWorkspaceAgentInput): Promise<DataResponse<WorkspaceAgent>> {
      return api.post('/weldagent/agents', data);
    },

    update(id: string, data: UpdateWorkspaceAgentInput): Promise<DataResponse<WorkspaceAgent>> {
      return api.patch(`/weldagent/agents/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete(`/weldagent/agents/${id}`);
    },

    activate(id: string): Promise<DataResponse<WorkspaceAgent>> {
      return api.post(`/weldagent/agents/${id}/activate`, {});
    },

    pause(id: string): Promise<DataResponse<WorkspaceAgent>> {
      return api.post(`/weldagent/agents/${id}/pause`, {});
    },

    listRuns(id: string, limit = 50): Promise<DataResponse<WorkspaceAgentRun[]>> {
      return api.get(`/weldagent/agents/${id}/runs${buildQueryString({ limit })}`);
    },

    run(id: string, data: RunWorkspaceAgentInput = {}): Promise<DataResponse<{ runId: string; text: string; success: boolean; error?: string }>> {
      return api.post(`/weldagent/agents/${id}/run`, data);
    },

    listTools(): Promise<DataResponse<WorkspaceAgentToolCatalogItem[]>> {
      return api.get('/weldagent/agents/tools');
    },

    listGrantablePermissions(): Promise<DataResponse<string[]>> {
      return api.get('/weldagent/agents/grantable-permissions');
    },
  };
}
