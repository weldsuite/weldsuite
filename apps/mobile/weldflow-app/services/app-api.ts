/**
 * app-api client for WeldFlow mobile.
 *
 * Wires the WeldFlow mobile app to the unified app-api (`/api`) — the
 * successor to the obsolete core-api `/api/weldflow/*` surface. A module-level
 * token getter is wired from `app/_layout.tsx` using Clerk credentials (see
 * `setAppApiTokenGetter`) — the client re-reads the token on every request, so
 * no rebuild is needed when it refreshes.
 *
 * The `weldflow` wrapper below keeps the legacy method names/signatures the
 * hooks were built around, but maps each call onto app-api's flat object
 * routes:
 *
 *   listProjects/getProject          → /api/projects
 *   listProjectTasks/getTask/...     → /api/tasks (+ /projects/:projectId create,
 *                                       /:id/status)
 *   listMyTasks                      → /api/my-tasks (offset page/pageSize)
 *   listProjectMembers               → /api/project-members?projectId=
 *   listLabels/createLabel           → /api/project-labels
 *
 * The raw `@weldsuite/app-api-client` projects/tasks domain clients are not
 * used here because their row/query types are narrower than what the WeldFlow
 * screens need (e.g. `isActive` filter, `totalTasks`/`progress` columns).
 *
 * Responses use the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and the client THROWS on non-2xx
 * (204 → `{}`).
 */

import { createClientApi, buildQueryString } from '@weldsuite/api-client/client';
import type {
  DataResponse,
  ListResponse,
  Project,
  ProjectTask,
  ProjectTaskWithProject,
  ProjectMember,
  ProjectLabel,
  ListProjectsQuery,
  ListTasksQuery,
  ListMyTasksQuery,
  CreateTaskInput,
  UpdateTaskInput,
  UpdateTaskStatusInput,
  CreateLabelInput,
} from '@/types/weldflow';

/** app-api base URL. Defaults to the local wrangler dev port (`apps/workers/app-api`). */
export const APP_API_URL = process.env.EXPO_PUBLIC_APP_API_URL || 'http://localhost:8789';

let tokenGetter: () => Promise<string | null> = async () => null;

/** Wire the Clerk token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

const client = createClientApi({
  baseUrl: APP_API_URL,
  getToken: () => tokenGetter(),
});

const weldflow = {
  listProjects(params: ListProjectsQuery = { limit: 25 }): Promise<ListResponse<Project>> {
    return client.get<ListResponse<Project>>(
      `/projects${buildQueryString(params as Record<string, unknown>)}`,
    );
  },

  getProject(id: string): Promise<DataResponse<Project>> {
    return client.get<DataResponse<Project>>(`/projects/${id}`);
  },

  /** Note: app-api returns `{ data }` without pagination for this surface. */
  listProjectMembers(projectId: string): Promise<{ data: ProjectMember[] }> {
    return client.get<{ data: ProjectMember[] }>(
      `/project-members?projectId=${encodeURIComponent(projectId)}`,
    );
  },

  listProjectTasks(
    projectId: string,
    params: ListTasksQuery = { limit: 50 },
  ): Promise<ListResponse<ProjectTask>> {
    // Project-scoped /api/tasks uses offset pagination (pageSize), so mirror
    // the legacy `limit` into `pageSize`. Only top-level tasks are returned
    // (subtasks live under their parent), matching the platform WeldFlow UI.
    const query = buildQueryString({
      ...params,
      projectId,
      pageSize: params.limit,
    } as Record<string, unknown>);
    return client.get<ListResponse<ProjectTask>>(`/tasks${query}`);
  },

  getTask(_projectId: string, taskId: string): Promise<DataResponse<ProjectTask>> {
    return client.get<DataResponse<ProjectTask>>(`/tasks/${taskId}`);
  },

  createTask(projectId: string, data: CreateTaskInput): Promise<DataResponse<ProjectTask>> {
    return client.post<DataResponse<ProjectTask>>(`/tasks/projects/${projectId}`, data);
  },

  updateTask(
    _projectId: string,
    taskId: string,
    data: UpdateTaskInput,
  ): Promise<DataResponse<ProjectTask>> {
    return client.patch<DataResponse<ProjectTask>>(`/tasks/${taskId}`, data);
  },

  updateTaskStatus(
    _projectId: string,
    taskId: string,
    data: UpdateTaskStatusInput,
  ): Promise<DataResponse<{ id: string; status: string }>> {
    return client.patch<DataResponse<{ id: string; status: string }>>(
      `/tasks/${taskId}/status`,
      data,
    );
  },

  listMyTasks(
    params: ListMyTasksQuery = { limit: 50 },
  ): Promise<ListResponse<ProjectTaskWithProject>> {
    // /api/my-tasks is offset-paginated (page/pageSize); map the legacy
    // `limit` onto `pageSize`. The screen fetches a single page, so `cursor`
    // is intentionally dropped.
    const query = buildQueryString({
      pageSize: params.limit,
      search: params.search,
      status: params.status,
      priority: params.priority,
      projectId: params.projectId,
    } as Record<string, unknown>);
    return client.get<ListResponse<ProjectTaskWithProject>>(`/my-tasks${query}`);
  },

  listLabels(): Promise<ListResponse<ProjectLabel>> {
    return client.get<ListResponse<ProjectLabel>>('/project-labels');
  },

  createLabel(data: CreateLabelInput): Promise<DataResponse<ProjectLabel>> {
    return client.post<DataResponse<ProjectLabel>>('/project-labels', data);
  },
};

export const appApi = {
  weldflow,
};

/**
 * Raw client for surfaces without a dedicated wrapper yet. Returns the same
 * `{ data }` / `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
