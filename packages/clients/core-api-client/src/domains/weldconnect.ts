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
    listWorkflows(params: ListWorkflowsQuery = {}): Promise<ListResponse<Workflow>> {
      return api.get<ListResponse<Workflow>>(`/weldconnect/workflows${buildQueryString(params as Record<string, unknown>)}`);
    },
    getWorkflow(id: string): Promise<DataResponse<Workflow>> {
      return api.get<DataResponse<Workflow>>(`/weldconnect/workflows/${id}`);
    },
    createWorkflow(data: CreateWorkflowInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/weldconnect/workflows', data);
    },
    updateWorkflow(id: string, data: UpdateWorkflowInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/weldconnect/workflows/${id}`, data);
    },
    updateWorkflowStatus(id: string, status: string): Promise<DataResponse<{ id: string; status: string }>> {
      return api.patch<DataResponse<{ id: string; status: string }>>(`/weldconnect/workflows/${id}/status`, { status });
    },
    duplicateWorkflow(id: string, name?: string): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>(`/weldconnect/workflows/${id}/duplicate`, { name });
    },
    deleteWorkflow(id: string): Promise<void> {
      return api.delete<void>(`/weldconnect/workflows/${id}`);
    },
    getWorkflowStats(): Promise<DataResponse<DashboardStats>> {
      return api.get<DataResponse<DashboardStats>>('/weldconnect/workflows/stats');
    },
    listWorkflowsForChaining(excludeId?: string): Promise<DataResponse<Array<{ id: string; name: string; status: string }>>> {
      const query = excludeId ? `?exclude=${excludeId}` : '';
      return api.get<DataResponse<Array<{ id: string; name: string; status: string }>>>(`/weldconnect/workflows/for-chaining${query}`);
    },
    testWorkflow(id: string, data: TriggerWorkflowInput = {}): Promise<DataResponse<{ executionId: string; instanceId: string }>> {
      return api.post<DataResponse<{ executionId: string; instanceId: string }>>(`/weldconnect/workflows/${id}/test`, data);
    },
    triggerWorkflow(id: string, data: TriggerWorkflowInput = {}): Promise<DataResponse<{ executionId: string; instanceId: string }>> {
      return api.post<DataResponse<{ executionId: string; instanceId: string }>>(`/weldconnect/workflows/${id}/trigger`, data);
    },

    // ====== Executions ======
    listExecutions(params: ListExecutionsQuery = {}): Promise<ListResponse<WorkflowExecution>> {
      return api.get<ListResponse<WorkflowExecution>>(`/weldconnect/executions${buildQueryString(params as Record<string, unknown>)}`);
    },
    getExecution(id: string): Promise<DataResponse<WorkflowExecution>> {
      return api.get<DataResponse<WorkflowExecution>>(`/weldconnect/executions/${id}`);
    },
    getExecutionSteps(executionId: string): Promise<DataResponse<ExecutionStep[]>> {
      return api.get<DataResponse<ExecutionStep[]>>(`/weldconnect/executions/${executionId}/steps`);
    },
    getExecutionLogs(executionId: string): Promise<DataResponse<Array<{ timestamp: string; level: string; message: string; stepId?: string; stepName?: string }>>> {
      return api.get<DataResponse<Array<{ timestamp: string; level: string; message: string; stepId?: string; stepName?: string }>>>(`/weldconnect/executions/${executionId}/logs`);
    },
    cancelExecution(id: string): Promise<DataResponse<{ id: string; status: string }>> {
      return api.patch<DataResponse<{ id: string; status: string }>>(`/weldconnect/executions/${id}/cancel`, {});
    },
    retryExecution(id: string): Promise<DataResponse<{ id: string; instanceId: string; retryOf: string }>> {
      return api.post<DataResponse<{ id: string; instanceId: string; retryOf: string }>>(`/weldconnect/executions/${id}/retry`, {});
    },
    resumeExecution(id: string, data: ResumeExecutionInput): Promise<DataResponse<{ resumed: boolean; executionId: string }>> {
      return api.post<DataResponse<{ resumed: boolean; executionId: string }>>(`/weldconnect/executions/${id}/resume`, data);
    },
    getRecentExecutions(limit = 10): Promise<DataResponse<WorkflowExecution[]>> {
      return api.get<DataResponse<WorkflowExecution[]>>(`/weldconnect/executions/recent?limit=${limit}`);
    },
    getExecutionTrends(period = 'week'): Promise<DataResponse<{ trends: Array<{ date: string; total: number; success: number; failure: number }> }>> {
      return api.get<DataResponse<{ trends: Array<{ date: string; total: number; success: number; failure: number }> }>>(`/weldconnect/executions/trends?period=${period}`);
    },
    getSlowExecutions(limit = 10): Promise<DataResponse<WorkflowExecution[]>> {
      return api.get<DataResponse<WorkflowExecution[]>>(`/weldconnect/executions/slow?limit=${limit}`);
    },

    // ====== Templates ======
    listTemplates(params: ListTemplatesQuery = {}): Promise<ListResponse<WorkflowTemplate>> {
      return api.get<ListResponse<WorkflowTemplate>>(`/weldconnect/templates${buildQueryString(params as Record<string, unknown>)}`);
    },
    getTemplate(id: string): Promise<DataResponse<WorkflowTemplate>> {
      return api.get<DataResponse<WorkflowTemplate>>(`/weldconnect/templates/${id}`);
    },
    createTemplate(data: CreateTemplateInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/weldconnect/templates', data);
    },
    updateTemplate(id: string, data: UpdateTemplateInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/weldconnect/templates/${id}`, data);
    },
    deleteTemplate(id: string): Promise<void> {
      return api.delete<void>(`/weldconnect/templates/${id}`);
    },
    getTemplateCategories(): Promise<DataResponse<Array<{ id: string; name: string; count: number }>>> {
      return api.get<DataResponse<Array<{ id: string; name: string; count: number }>>>('/weldconnect/templates/categories');
    },
    createTemplateFromWorkflow(workflowId: string, data?: { name?: string; description?: string; category?: string }): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>(`/weldconnect/templates/from-workflow/${workflowId}`, data || {});
    },
    useTemplate(id: string, data?: { name?: string; description?: string; activate?: boolean }): Promise<DataResponse<{ id: string; templateId: string }>> {
      return api.post<DataResponse<{ id: string; templateId: string }>>(`/weldconnect/templates/${id}/use`, data || {});
    },

    // ====== Schedules ======
    listSchedules(params: ListSchedulesQuery = {}): Promise<ListResponse<WorkflowSchedule>> {
      return api.get<ListResponse<WorkflowSchedule>>(`/weldconnect/schedules${buildQueryString(params as Record<string, unknown>)}`);
    },
    getSchedule(id: string): Promise<DataResponse<WorkflowSchedule>> {
      return api.get<DataResponse<WorkflowSchedule>>(`/weldconnect/schedules/${id}`);
    },
    createSchedule(data: CreateScheduleInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/weldconnect/schedules', data);
    },
    updateSchedule(id: string, data: UpdateScheduleInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/weldconnect/schedules/${id}`, data);
    },
    deleteSchedule(id: string): Promise<void> {
      return api.delete<void>(`/weldconnect/schedules/${id}`);
    },
    toggleSchedule(id: string, enabled: boolean): Promise<DataResponse<{ id: string; isEnabled: boolean }>> {
      return api.patch<DataResponse<{ id: string; isEnabled: boolean }>>(`/weldconnect/schedules/${id}/toggle`, { enabled });
    },

    // ====== Variables ======
    listVariables(params: ListVariablesQuery = {}): Promise<ListResponse<WorkflowVariable>> {
      return api.get<ListResponse<WorkflowVariable>>(`/weldconnect/variables${buildQueryString(params as Record<string, unknown>)}`);
    },
    getVariable(id: string): Promise<DataResponse<WorkflowVariable>> {
      return api.get<DataResponse<WorkflowVariable>>(`/weldconnect/variables/${id}`);
    },
    createVariable(data: CreateVariableInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/weldconnect/variables', data);
    },
    updateVariable(id: string, data: UpdateVariableInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/weldconnect/variables/${id}`, data);
    },
    deleteVariable(id: string): Promise<void> {
      return api.delete<void>(`/weldconnect/variables/${id}`);
    },
    getGlobalVariables(): Promise<DataResponse<WorkflowVariable[]>> {
      return api.get<DataResponse<WorkflowVariable[]>>('/weldconnect/variables/global');
    },
    getWorkflowVariables(workflowId: string): Promise<DataResponse<Array<{ name: string; type: string; isSecret: boolean; isGlobal: boolean }>>> {
      return api.get<DataResponse<Array<{ name: string; type: string; isSecret: boolean; isGlobal: boolean }>>>(`/weldconnect/variables/workflow/${workflowId}`);
    },

    // ====== AI Builder ======
    createBuilderDraft(data: CreateBuilderDraftInput = {}): Promise<DataResponse<WorkflowDraft>> {
      return api.post<DataResponse<WorkflowDraft>>('/weldconnect/builder/drafts', data);
    },
    getBuilderDraft(id: string): Promise<DataResponse<WorkflowDraft>> {
      return api.get<DataResponse<WorkflowDraft>>(`/weldconnect/builder/drafts/${id}`);
    },
    finalizeBuilderDraft(id: string, data: FinalizeBuilderDraftInput = {}): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>(`/weldconnect/builder/drafts/${id}/finalize`, data);
    },
  };
}
