import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  Project,
  ProjectTask,
  ProjectTaskWithProject,
  ProjectMember,
  ProjectLabel,
  CreateProjectInput,
  UpdateProjectInput,
  ListProjectsQuery,
  CreateTaskInput,
  UpdateTaskInput,
  UpdateTaskStatusInput,
  ListTasksQuery,
  ListMyTasksQuery,
  CreateLabelInput,
} from '../schemas/weldflow';

export function createWeldflowApi(api: ClientApi) {
  return {
    listProjects(params: ListProjectsQuery = { limit: 25 }): Promise<ListResponse<Project>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<Project>>(`/weldflow/projects${query}`);
    },

    getProject(id: string): Promise<DataResponse<Project>> {
      return api.get<DataResponse<Project>>(`/weldflow/projects/${id}`);
    },

    createProject(data: CreateProjectInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/weldflow/projects', data);
    },

    updateProject(id: string, data: UpdateProjectInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/weldflow/projects/${id}`, data);
    },

    deleteProject(id: string): Promise<void> {
      return api.delete<void>(`/weldflow/projects/${id}`);
    },

    listProjectMembers(projectId: string): Promise<ListResponse<ProjectMember>> {
      return api.get<ListResponse<ProjectMember>>(`/weldflow/projects/${projectId}/members`);
    },

    listProjectTasks(
      projectId: string,
      params: ListTasksQuery = { limit: 50 },
    ): Promise<ListResponse<ProjectTask>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<ProjectTask>>(`/weldflow/projects/${projectId}/tasks${query}`);
    },

    getTask(projectId: string, taskId: string): Promise<DataResponse<ProjectTask>> {
      return api.get<DataResponse<ProjectTask>>(`/weldflow/projects/${projectId}/tasks/${taskId}`);
    },

    createTask(projectId: string, data: CreateTaskInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>(
        `/weldflow/projects/${projectId}/tasks`,
        data,
      );
    },

    updateTask(
      projectId: string,
      taskId: string,
      data: UpdateTaskInput,
    ): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(
        `/weldflow/projects/${projectId}/tasks/${taskId}`,
        data,
      );
    },

    updateTaskStatus(
      projectId: string,
      taskId: string,
      data: UpdateTaskStatusInput,
    ): Promise<DataResponse<{ id: string; status: string }>> {
      return api.patch<DataResponse<{ id: string; status: string }>>(
        `/weldflow/projects/${projectId}/tasks/${taskId}/status`,
        data,
      );
    },

    deleteTask(projectId: string, taskId: string): Promise<void> {
      return api.delete<void>(`/weldflow/projects/${projectId}/tasks/${taskId}`);
    },

    listMyTasks(params: ListMyTasksQuery = { limit: 50 }): Promise<ListResponse<ProjectTaskWithProject>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<ProjectTaskWithProject>>(`/weldflow/my-tasks${query}`);
    },

    listLabels(): Promise<ListResponse<ProjectLabel>> {
      return api.get<ListResponse<ProjectLabel>>('/weldflow/labels');
    },

    createLabel(data: CreateLabelInput): Promise<DataResponse<ProjectLabel>> {
      return api.post<DataResponse<ProjectLabel>>('/weldflow/labels', data);
    },

    deleteLabel(id: string): Promise<void> {
      return api.delete<void>(`/weldflow/labels/${id}`);
    },
  };
}
