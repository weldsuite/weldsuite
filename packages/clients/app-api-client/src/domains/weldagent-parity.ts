/**
 * App-API WeldAgent Grok-parity domain — skills, routines, approvals, memory, templates.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateSkillInput,
  UpdateSkillInput,
  CreateRoutineInput,
  UpdateRoutineInput,
  DecideApprovalInput,
  CreateMemoryInput,
  ExportTemplateInput,
  InstallTemplateInput,
  ConnectorEventInput,
} from '../schemas/weldagent-parity';

export function createWeldAgentParityApi(api: ClientApi) {
  return {
    listSkills(status?: string) {
      return api.get<DataResponse<unknown[]>>(`/weldagent/skills${buildQueryString({ status })}`);
    },
    createSkill(data: CreateSkillInput) {
      return api.post<DataResponse<unknown>>('/weldagent/skills', data);
    },
    updateSkill(id: string, data: UpdateSkillInput) {
      return api.patch<DataResponse<unknown>>(`/weldagent/skills/${id}`, data);
    },
    deleteSkill(id: string) {
      return api.delete<void>(`/weldagent/skills/${id}`);
    },
    listAgentSkills(agentId: string) {
      return api.get<DataResponse<unknown[]>>(`/weldagent/agents/${agentId}/skills`);
    },
    enableSkill(agentId: string, skillId: string) {
      return api.post<DataResponse<unknown>>(`/weldagent/agents/${agentId}/skills/${skillId}`, {});
    },
    disableSkill(agentId: string, skillId: string) {
      return api.delete<void>(`/weldagent/agents/${agentId}/skills/${skillId}`);
    },

    listRoutines(agentId?: string) {
      return api.get<DataResponse<unknown[]>>(`/weldagent/routines${buildQueryString({ agentId })}`);
    },
    createRoutine(data: CreateRoutineInput) {
      return api.post<DataResponse<unknown>>('/weldagent/routines', data);
    },
    updateRoutine(id: string, data: UpdateRoutineInput) {
      return api.patch<DataResponse<unknown>>(`/weldagent/routines/${id}`, data);
    },
    deleteRoutine(id: string) {
      return api.delete<void>(`/weldagent/routines/${id}`);
    },
    listRoutineRuns(id: string) {
      return api.get<DataResponse<unknown[]>>(`/weldagent/routines/${id}/runs`);
    },
    testRoutine(id: string) {
      return api.post<DataResponse<unknown>>(`/weldagent/routines/${id}/test`, {});
    },

    listApprovals(opts?: { agentId?: string; status?: string }) {
      return api.get<DataResponse<unknown[]>>(`/weldagent/approvals${buildQueryString(opts ?? {})}`);
    },
    decideApproval(id: string, data: DecideApprovalInput) {
      return api.post<DataResponse<unknown>>(`/weldagent/approvals/${id}/decide`, data);
    },

    listMemories(agentId: string) {
      return api.get<DataResponse<unknown[]>>(`/weldagent/agents/${agentId}/memories`);
    },
    createMemory(data: CreateMemoryInput) {
      return api.post<DataResponse<unknown>>('/weldagent/memories', data);
    },
    deleteMemory(id: string) {
      return api.delete<void>(`/weldagent/memories/${id}`);
    },

    exportTemplate(data: ExportTemplateInput) {
      return api.post<DataResponse<unknown>>('/weldagent/templates/export', data);
    },
    installTemplate(data: InstallTemplateInput) {
      return api.post<DataResponse<unknown>>('/weldagent/templates/install', data);
    },
    getTemplateByShare(token: string) {
      return api.get<DataResponse<unknown>>(`/weldagent/templates/share/${token}`);
    },

    startTeach(agentId: string, title: string) {
      return api.post<DataResponse<unknown>>(`/weldagent/agents/${agentId}/teach/start`, { title });
    },
    appendTeachStep(sessionId: string, step: Record<string, unknown>) {
      return api.post<DataResponse<unknown>>(`/weldagent/teach/${sessionId}/steps`, { step });
    },
    stopTeach(sessionId: string, data?: { createSkill?: boolean; skillName?: string }) {
      return api.post<DataResponse<unknown>>(`/weldagent/teach/${sessionId}/stop`, data ?? {});
    },

    listComputerFiles(agentId: string, path?: string) {
      return api.get<DataResponse<unknown>>(
        `/weldagent/agents/${agentId}/computer/files${buildQueryString({ path })}`,
      );
    },
    liveView(agentId: string) {
      return api.post<DataResponse<unknown>>(`/weldagent/agents/${agentId}/browser/live-view`, {});
    },
    computerHealth() {
      return api.get<DataResponse<unknown>>('/weldagent/computer/health');
    },

    postConnectorEvent(data: ConnectorEventInput) {
      return api.post<DataResponse<unknown>>('/weldagent/connectors/events', data);
    },
  };
}
