import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  Workflow,
  WorkflowExecution,
  ExecutionStep,
  WorkflowTemplate,
  WorkflowSchedule,
  WorkflowVariable,
  DashboardStats,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  ListWorkflowsQuery,
  TriggerWorkflowInput,
  ListExecutionsQuery,
  ResumeExecutionInput,
  CreateTemplateInput,
  UpdateTemplateInput,
  ListTemplatesQuery,
  CreateScheduleInput,
  UpdateScheduleInput,
  ListSchedulesQuery,
  CreateVariableInput,
  UpdateVariableInput,
  ListVariablesQuery,
} from '../schemas/weldconnect';
import type {
  CreateBuilderDraftInput,
  FinalizeBuilderDraftInput,
  WorkflowDraft,
} from '../schemas/weldconnect-builder';

export function createWeldconnectApi(api: ClientApi) {
  return {
    // ====== Workflows ======
    listWorkflows(params: ListWorkflowsQuery = { limit: 25 }): Promise<ListResponse<Workflow>> {
      return api.get<ListResponse<Workflow>>(`/workflows${buildQueryString(params as Record<string, unknown>)}`);
    },
    getWorkflow(id: string): Promise<DataResponse<Workflow>> {
      return api.get<DataResponse<Workflow>>(`/workflows/${id}`);
    },
    createWorkflow(data: CreateWorkflowInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/workflows', data);
    },
    updateWorkflow(id: string, data: UpdateWorkflowInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/workflows/${id}`, data);
    },
    updateWorkflowStatus(id: string, status: string): Promise<DataResponse<{ id: string; status: string }>> {
      return api.patch<DataResponse<{ id: string; status: string }>>(`/workflows/${id}/status`, { status });
    },
    duplicateWorkflow(id: string, name?: string): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>(`/workflows/${id}/duplicate`, { name });
    },
    deleteWorkflow(id: string): Promise<void> {
      return api.delete<void>(`/workflows/${id}`);
    },
    getWorkflowStats(): Promise<DataResponse<DashboardStats>> {
      return api.get<DataResponse<DashboardStats>>('/workflows/stats');
    },
    listWorkflowsForChaining(excludeId?: string): Promise<DataResponse<Array<{ id: string; name: string; status: string }>>> {
      const query = excludeId ? `?exclude=${excludeId}` : '';
      return api.get<DataResponse<Array<{ id: string; name: string; status: string }>>>(`/workflows/for-chaining${query}`);
    },
    testWorkflow(id: string, data: TriggerWorkflowInput = {}): Promise<DataResponse<{ executionId: string; instanceId: string }>> {
      return api.post<DataResponse<{ executionId: string; instanceId: string }>>(`/workflows/${id}/test`, data);
    },
    triggerWorkflow(id: string, data: TriggerWorkflowInput = {}): Promise<DataResponse<{ executionId: string; instanceId: string }>> {
      return api.post<DataResponse<{ executionId: string; instanceId: string }>>(`/workflows/${id}/trigger`, data);
    },

    // ====== Executions ======
    listExecutions(params: ListExecutionsQuery = { limit: 25 }): Promise<ListResponse<WorkflowExecution>> {
      return api.get<ListResponse<WorkflowExecution>>(`/workflow-executions${buildQueryString(params as Record<string, unknown>)}`);
    },
    getExecution(id: string): Promise<DataResponse<WorkflowExecution>> {
      return api.get<DataResponse<WorkflowExecution>>(`/workflow-executions/${id}`);
    },
    getExecutionSteps(executionId: string): Promise<DataResponse<ExecutionStep[]>> {
      return api.get<DataResponse<ExecutionStep[]>>(`/workflow-executions/${executionId}/steps`);
    },
    getExecutionLogs(executionId: string): Promise<DataResponse<Array<{ timestamp: string; level: string; message: string; stepId?: string; stepName?: string }>>> {
      return api.get<DataResponse<Array<{ timestamp: string; level: string; message: string; stepId?: string; stepName?: string }>>>(`/workflow-executions/${executionId}/logs`);
    },
    cancelExecution(id: string): Promise<DataResponse<{ id: string; status: string }>> {
      return api.patch<DataResponse<{ id: string; status: string }>>(`/workflow-executions/${id}/cancel`, {});
    },
    retryExecution(id: string): Promise<DataResponse<{ id: string; instanceId: string; retryOf: string }>> {
      return api.post<DataResponse<{ id: string; instanceId: string; retryOf: string }>>(`/workflow-executions/${id}/retry`, {});
    },
    resumeExecution(id: string, data: ResumeExecutionInput): Promise<DataResponse<{ resumed: boolean; executionId: string }>> {
      return api.post<DataResponse<{ resumed: boolean; executionId: string }>>(`/workflow-executions/${id}/resume`, data);
    },
    getRecentExecutions(limit = 10): Promise<DataResponse<WorkflowExecution[]>> {
      return api.get<DataResponse<WorkflowExecution[]>>(`/workflow-executions/recent?limit=${limit}`);
    },
    getExecutionTrends(period = 'week'): Promise<DataResponse<{ trends: Array<{ date: string; total: number; success: number; failure: number }> }>> {
      return api.get<DataResponse<{ trends: Array<{ date: string; total: number; success: number; failure: number }> }>>(`/workflow-executions/trends?period=${period}`);
    },
    getSlowExecutions(limit = 10): Promise<DataResponse<WorkflowExecution[]>> {
      return api.get<DataResponse<WorkflowExecution[]>>(`/workflow-executions/slow?limit=${limit}`);
    },

    // ====== Templates ======
    listTemplates(params: ListTemplatesQuery = { limit: 25 }): Promise<ListResponse<WorkflowTemplate>> {
      return api.get<ListResponse<WorkflowTemplate>>(`/workflow-templates${buildQueryString(params as Record<string, unknown>)}`);
    },
    getTemplate(id: string): Promise<DataResponse<WorkflowTemplate>> {
      return api.get<DataResponse<WorkflowTemplate>>(`/workflow-templates/${id}`);
    },
    createTemplate(data: CreateTemplateInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/workflow-templates', data);
    },
    updateTemplate(id: string, data: UpdateTemplateInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/workflow-templates/${id}`, data);
    },
    deleteTemplate(id: string): Promise<void> {
      return api.delete<void>(`/workflow-templates/${id}`);
    },
    getTemplateCategories(): Promise<DataResponse<Array<{ id: string; name: string; count: number }>>> {
      return api.get<DataResponse<Array<{ id: string; name: string; count: number }>>>('/workflow-templates/categories');
    },
    createTemplateFromWorkflow(workflowId: string, data?: { name?: string; description?: string; category?: string }): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>(`/workflow-templates/from-workflow/${workflowId}`, data || {});
    },
    useTemplate(id: string, data?: { name?: string; description?: string; activate?: boolean }): Promise<DataResponse<{ id: string; templateId: string }>> {
      return api.post<DataResponse<{ id: string; templateId: string }>>(`/workflow-templates/${id}/use`, data || {});
    },

    // ====== Schedules ======
    listSchedules(params: ListSchedulesQuery = { limit: 25 }): Promise<ListResponse<WorkflowSchedule>> {
      return api.get<ListResponse<WorkflowSchedule>>(`/workflow-schedules${buildQueryString(params as Record<string, unknown>)}`);
    },
    getSchedule(id: string): Promise<DataResponse<WorkflowSchedule>> {
      return api.get<DataResponse<WorkflowSchedule>>(`/workflow-schedules/${id}`);
    },
    createSchedule(data: CreateScheduleInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/workflow-schedules', data);
    },
    updateSchedule(id: string, data: UpdateScheduleInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/workflow-schedules/${id}`, data);
    },
    deleteSchedule(id: string): Promise<void> {
      return api.delete<void>(`/workflow-schedules/${id}`);
    },
    toggleSchedule(id: string, enabled: boolean): Promise<DataResponse<{ id: string; isEnabled: boolean }>> {
      return api.patch<DataResponse<{ id: string; isEnabled: boolean }>>(`/workflow-schedules/${id}/toggle`, { enabled });
    },

    // ====== Variables ======
    listVariables(params: ListVariablesQuery = { limit: 25, scope: 'all' }): Promise<ListResponse<WorkflowVariable>> {
      return api.get<ListResponse<WorkflowVariable>>(`/workflow-variables${buildQueryString(params as Record<string, unknown>)}`);
    },
    getVariable(id: string): Promise<DataResponse<WorkflowVariable>> {
      return api.get<DataResponse<WorkflowVariable>>(`/workflow-variables/${id}`);
    },
    createVariable(data: CreateVariableInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/workflow-variables', data);
    },
    updateVariable(id: string, data: UpdateVariableInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/workflow-variables/${id}`, data);
    },
    deleteVariable(id: string): Promise<void> {
      return api.delete<void>(`/workflow-variables/${id}`);
    },
    getGlobalVariables(): Promise<DataResponse<WorkflowVariable[]>> {
      return api.get<DataResponse<WorkflowVariable[]>>('/workflow-variables/global');
    },
    getWorkflowVariables(workflowId: string): Promise<DataResponse<Array<{ name: string; type: string; isSecret: boolean; isGlobal: boolean }>>> {
      return api.get<DataResponse<Array<{ name: string; type: string; isSecret: boolean; isGlobal: boolean }>>>(`/workflow-variables/workflow/${workflowId}`);
    },

    // ====== AI Builder ======
    createBuilderDraft(data: CreateBuilderDraftInput = {}): Promise<DataResponse<WorkflowDraft>> {
      return api.post<DataResponse<WorkflowDraft>>('/workflow-builder/drafts', data);
    },
    getBuilderDraft(id: string): Promise<DataResponse<WorkflowDraft>> {
      return api.get<DataResponse<WorkflowDraft>>(`/workflow-builder/drafts/${id}`);
    },
    finalizeBuilderDraft(id: string, data: FinalizeBuilderDraftInput = {}): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>(`/workflow-builder/drafts/${id}/finalize`, data);
    },
  };
}
