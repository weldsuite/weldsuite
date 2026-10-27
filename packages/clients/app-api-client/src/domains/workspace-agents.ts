/**
 * App-API workspace agents domain client — `/api/weldagent/agents/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import type { ConversationSummary } from '../schemas/weldagent';
import { buildQueryString } from '../types';
import type {
  CreateWorkspaceAgentInput,
  UpdateWorkspaceAgentInput,
  RunWorkspaceAgentInput,
  UpdateWorkspaceAgentAccessInput,
  UpdateWorkspaceAgentSubagentsInput,
  WorkspaceAgent,
  WorkspaceAgentDetail,
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

    get(id: string): Promise<DataResponse<WorkspaceAgentDetail>> {
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

    /** Owner, visibility and members (owner or weldagent:manage). */
    updateAccess(id: string, data: UpdateWorkspaceAgentAccessInput): Promise<DataResponse<WorkspaceAgent>> {
      return api.put(`/weldagent/agents/${id}/access`, data);
    },

    /** The agents this agent may hand work to. */
    updateSubagents(id: string, data: UpdateWorkspaceAgentSubagentsInput): Promise<DataResponse<WorkspaceAgent>> {
      return api.put(`/weldagent/agents/${id}/subagents`, data);
    },

    /** The caller's one continuous chat with the agent, created on first use. */
    mainChat(id: string): Promise<DataResponse<ConversationSummary>> {
      return api.post(`/weldagent/agents/${id}/chat`, {});
    },
  };
}
