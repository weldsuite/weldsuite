/**
 * Projects API Client
 *
 * Client-side helper for calling the WeldFlow (projects) surface on app-api
 * (`${VITE_APP_API_URL}/api/*`) through the `appApi*` helpers below, which
 * adapt app-api's `{ data }` envelope to the `{ success, data, error }` shape
 * the call sites expect.
 *
 * The legacy worker-client helpers (`apiGet`/`apiPost`/`apiPut`/`apiPatch`/
 * `apiDelete`, which hit the obsolete api-worker under a `/projects` prefix)
 * have been removed: all 22 API objects below already ran on the `appApi*`
 * helpers, leaving the legacy set with no call sites.
 */

import type { Projects } from '@/lib/api/types/apps/projects.types';
import type { ProjectGoals } from '@/lib/api/domains/weldflow';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** HTTP status on failure — lets call sites branch on 409 etc. */
  status?: number;
  /** `error.details` from the app-api envelope, when the route supplies one. */
  details?: unknown;
}

// ============ SHARED ENTITY TYPES ============
// Model the actual `/api/*` JSON responses consumed by the WeldFlow UI. Where a
// richer typed client already exists (`hooks/queries/use-projects-queries.ts`,
// `Projects.ProjectTask`) these reuse it instead of redeclaring it.

/** `GET /projects` + `GET /projects/:id` row — richer than the app-api-client's
 * `ProjectRow` (adds fields the WeldFlow UI actually reads: priority,
 * health/derived status+progress from the summary view, and the caller's
 * per-project permissions). */
export interface ApiProject {
  id: string;
  workspaceId?: string;
  name: string;
  description?: string | null;
  status: string;
  priority?: string;
  health?: string | null;
  derivedStatus?: string;
  progress?: number;
  derivedProgress?: number;
  color?: string | null;
  icon?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  createdAt: string;
  updatedAt: string;
  canWrite?: boolean;
  isAdmin?: boolean;
  /** Linked customer/client display name, when the project is tied to a CRM record. */
  clientName?: string | null;
}

/** `/tasks` responses also carry `duration`/`repeat`/`customFields` (and,
 * on mutations that complete a recurring task, `nextTaskId`) — fields not
 * modeled on the shared `Projects.ProjectTask` type. All additions are
 * optional so a plain `Projects.ProjectTask` still satisfies it. */
export type ApiTask = Projects.ProjectTask & {
  duration?: number;
  repeat?: { frequency: string; interval?: number; unit?: string } | null;
  customFields?: Record<string, unknown> | null;
  nextTaskId?: string;
};

/** `GET /project-members` — project_members row joined with workspaceMembers. */
export interface ApiProjectMember {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  permissions?: string[];
  isActive: boolean;
  joinedAt: string;
  leftAt?: string;
  allocationPercentage?: number;
  hourlyRate?: number;
  createdAt: string;
  updatedAt: string;
  user?: { id: string; name: string; email: string; avatar?: string };
}

/** `GET /project-members/available` — workspace users not yet on the project. */
export interface ApiAvailableProjectUser {
  id: string;
  name: string;
  email: string;
  image?: string;
}

/** `GET /time-entries` — full `time_entries` row. */
export interface ApiTimeEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  projectId: string | null;
  taskId: string | null;
  userId: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  duration: string;
  description: string | null;
  activity: string | null;
  billable: boolean;
  rate: string | null;
  cost: string | null;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  location: string | null;
  isRemote: boolean | null;
}

export interface ApiTaskComment {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiProjectLabel {
  id: string;
  name: string;
  color: string;
  projectId?: string | null;
}

export interface ApiPipelineStage {
  id: string;
  projectId?: string;
  name: string;
  color?: string | null;
  position?: number;
  systemStatus?: string | null;
}

export interface GanttMilestone {
  id: string;
  projectId?: string;
  name: string;
  dueDate: string;
  description?: string | null;
  status?: string;
}

export interface ApiMemberStats {
  tasksAssigned: number;
  tasksCompleted: number;
  hoursLogged: number;
  recentTasks: { id: string; title: string; status: string; updatedAt?: string }[];
}

export interface WhiteboardElement {
  id: string;
  type: 'rectangle' | 'circle' | 'text' | 'sticky' | 'path' | 'arrow';
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  radiusX?: number;
  radiusY?: number;
  text?: string;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  points?: { x: number; y: number }[];
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textDecoration?: 'none' | 'underline';
  textAlign?: 'left' | 'center' | 'right';
  link?: string;
  locked?: boolean;
  endX?: number;
  endY?: number;
  erasedPaths?: { points: { x: number; y: number }[]; size: number }[];
  arrowType?: 'line' | 'arrow' | 'elbow';
  startElementId?: string;
  startConnectionPoint?: 'top' | 'right' | 'bottom' | 'left';
  endElementId?: string;
  endConnectionPoint?: 'top' | 'right' | 'bottom' | 'left';
  curveControlX?: number;
  curveControlY?: number;
  borderRadius?: number;
}

export interface ApiWhiteboard {
  id: string;
  projectId?: string;
  name: string;
  elements: WhiteboardElement[];
  createdAt: string;
  updatedAt: string;
}

/** `GET /project-files` — full `project_files` row. */
export interface ApiProjectFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  projectId: string | null;
  fileName: string;
  originalName: string | null;
  mimeType: string;
  fileSize: number;
  storagePath: string;
  fileKey: string | null;
  bucket: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  storageProvider: string;
  uploadedById: string | null;
  fileType: string;
  isFolder: boolean;
  isPublic: boolean;
  expiresAt: string | null;
  metadata: Record<string, unknown> | null;
}

/** `GET /project-messages` — full `project_messages` row. */
export interface ApiProjectMessage {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  projectId: string | null;
  conversationId: string;
  senderId: string;
  message: string;
  messageType: string;
  replyToId: string | null;
  attachments?: unknown[];
  editedAt?: string;
  isRead: boolean;
  readBy: string[] | null;
  reactions?: Record<string, string[]>;
  metadata: Record<string, unknown> | null;
}

/** `GET /project-analytics/reports/:id/charts`. */
export interface ApiAnalyticsChart {
  id: string;
  reportId: string;
  title: string;
  description?: string;
  chartType: string;
  entity: string;
  metric: string;
  color: string;
  timeRange?: string;
  groupBy?: string;
  aggregation?: string;
  sortOrder?: string;
  limit?: number;
  compareWith?: string;
  smoothCurve?: boolean;
  fillArea?: boolean;
  showDataLabels?: boolean;
  showLegend?: boolean;
  layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number };
  sortIndex: number;
  createdAt: string;
  updatedAt: string;
}

/** Normalized (`.docx` suffix stripped) row returned by `documentsApi`'s
 * list/create helpers, which wrap the underlying `files` rows. */
export interface DocumentSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  isPinned: boolean;
}

/** Normalized (`.xlsx` suffix stripped) row returned by `tablesApi`'s
 * list/create helpers, which wrap the underlying `files` rows. */
export interface SheetSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Config accepted by `analyticsApi.getChartsData` — one entry per chart. */
export interface ChartDataQueryConfig {
  chartId: string;
  entity: string;
  metric: string;
  timeRange: string;
  groupBy: string;
  aggregation: string;
  sortOrder?: string;
  limit?: number;
  projectId?: string;
}

export interface ChartDataPoint {
  label: string;
  value: number;
  fill?: string;
  [key: string]: string | number | undefined;
}

const APP_API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:8789';

let _getToken: (() => Promise<string | null>) | null = null;

/**
 * Set the token provider for auth headers.
 * Call this once from a component that has access to Clerk's getToken.
 */
export function setProjectsApiTokenProvider(getToken: () => Promise<string | null>) {
  _getToken = getToken;
}

async function getAuthToken(): Promise<string | null> {
  // First try the explicit token provider
  if (_getToken) {
    return _getToken();
  }
  // Fallback: get token from Clerk's global client (available after Clerk loads)
  if (typeof window !== 'undefined') {
    const clerk = (window as unknown as { Clerk?: { session?: { getToken: () => Promise<string | null> } } }).Clerk;
    if (clerk?.session) {
      return clerk.session.getToken();
    }
  }
  return null;
}

/**
 * POST to app-api (`/api/<path>`) and adapt the `{ data }` envelope to the
 * `{ success, data, error }` shape the WeldFlow call sites expect. Used by
 * the create/createGlobal methods which have been migrated off the legacy
 * api-worker `/projects/*` surface.
 */
async function appApiPost<T>(path: string, data?: unknown): Promise<ApiResponse<T>> {
  try {
    const token = await getAuthToken();
    const res = await fetch(`${APP_API_URL}/api${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body?.error?.message || body?.error || `Request failed (${res.status})`;
      return {
        success: false,
        error: typeof message === 'string' ? message : 'Request failed',
        status: res.status,
        details: body?.error?.details,
      };
    }
    const body = (await res.json()) as { data: T };
    return { success: true, data: body.data };
  } catch (error) {
    console.error('[Projects API Client] app-api error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Network error' };
  }
}

// app-api GET / PATCH / DELETE helpers — used by the file-backed sheets surface.
async function appApiGet<T>(path: string): Promise<ApiResponse<T>> {
  try {
    const token = await getAuthToken();
    const res = await fetch(`${APP_API_URL}/api${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body?.error?.message || body?.error || `Request failed (${res.status})`;
      return { success: false, error: typeof message === 'string' ? message : 'Request failed' };
    }
    const body = (await res.json()) as { data: T };
    return { success: true, data: body.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Network error' };
  }
}

async function appApiPatch<T>(path: string, data?: unknown): Promise<ApiResponse<T>> {
  try {
    const token = await getAuthToken();
    const res = await fetch(`${APP_API_URL}/api${path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body?.error?.message || body?.error || `Request failed (${res.status})`;
      return { success: false, error: typeof message === 'string' ? message : 'Request failed' };
    }
    const body = (await res.json()) as { data: T };
    return { success: true, data: body.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Network error' };
  }
}

async function appApiPut<T>(path: string, data?: unknown): Promise<ApiResponse<T>> {
  try {
    const token = await getAuthToken();
    const res = await fetch(`${APP_API_URL}/api${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body?.error?.message || body?.error || `Request failed (${res.status})`;
      return { success: false, error: typeof message === 'string' ? message : 'Request failed' };
    }
    const body = (await res.json()) as { data: T };
    return { success: true, data: body.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Network error' };
  }
}

async function appApiDelete<T>(path: string): Promise<ApiResponse<T>> {
  try {
    const token = await getAuthToken();
    const res = await fetch(`${APP_API_URL}/api${path}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok && res.status !== 204) {
      return { success: false, error: `Request failed (${res.status})` };
    }
    return { success: true } as ApiResponse<T>;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Network error' };
  }
}

// Fetch the xlsx binary for a sheet file as an ArrayBuffer. 404 means the file
// row exists but no R2 object yet (freshly-created sheet) — caller should
// treat that as an empty workbook.
export async function fetchSheetContent(fileId: string): Promise<ArrayBuffer | null> {
  const token = await getAuthToken();
  const res = await fetch(`${APP_API_URL}/api/files/${fileId}/content`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load sheet (${res.status})`);
  return res.arrayBuffer();
}

// Overwrite the xlsx file in R2. Used by the spreadsheet editor's debounced
// auto-save. Returns the updated file row.
export async function putSheetContent(fileId: string, body: ArrayBuffer): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch(`${APP_API_URL}/api/files/${fileId}/content`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Failed to save sheet (${res.status})`);
  }
}

// Fetch the DOCX binary for a document file as an ArrayBuffer. 404 means the
// file row exists but no R2 object yet (freshly-created document) — caller
// should treat that as an empty document.
export async function fetchDocumentContent(fileId: string): Promise<ArrayBuffer | null> {
  const token = await getAuthToken();
  const res = await fetch(`${APP_API_URL}/api/files/${fileId}/content`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load document (${res.status})`);
  return res.arrayBuffer();
}

// Overwrite the DOCX file in R2. Used by the document editor's debounced
// auto-save.
export async function putDocumentContent(fileId: string, body: ArrayBuffer): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch(`${APP_API_URL}/api/files/${fileId}/content`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Failed to save document (${res.status})`);
  }
}

// ---------------------------------------------------------------------------
// JSON document content (Phase 1 source of truth — the `docs` table).
//
// `content` is the BlockNote block JSON. A `null` result means there is no
// `docs` row yet (a document created before Phase 1, not yet imported) — the
// caller falls back to the legacy DOCX path for those.
// ---------------------------------------------------------------------------

type DocRow = { content: Record<string, unknown>[] } | null;

export async function fetchDocumentJson(
  fileId: string,
): Promise<Record<string, unknown>[] | null> {
  const res = await appApiGet<DocRow>(`/documents/${fileId}`);
  if (!res.success) throw new Error(res.error || 'Failed to load document');
  return res.data?.content ?? null;
}

export async function putDocumentJson(
  fileId: string,
  content: Record<string, unknown>[],
): Promise<void> {
  const res = await appApiPut<unknown>(`/documents/${fileId}/content`, { content });
  if (!res.success) throw new Error(res.error || 'Failed to save document');
}

// ============ LABELS ============

export const labelsApi = {
  // Pass projectId for per-project views; omit for cross-project views (my-tasks, CRM).
  // app-api also returns workspace-wide labels (projectId IS NULL) when projectId is set,
  // matching the legacy behaviour the UI depends on.
  list: (projectId?: string) =>
    appApiGet<ApiProjectLabel[]>(
      `/project-labels${projectId ? `?projectId=${encodeURIComponent(projectId)}&limit=100` : '?limit=100'}`,
    ),

  create: (data: { name: string; color: string; projectId?: string }) =>
    appApiPost<ApiProjectLabel>('/project-labels', data),

  update: (id: string, data: { name?: string; color?: string }) =>
    appApiPatch<ApiProjectLabel>(`/project-labels/${id}`, data),

  delete: (id: string) =>
    appApiDelete<{ success: boolean }>(`/project-labels/${id}`),
};

// ============ PIPELINE STAGES ============

export const stagesApi = {
  list: (projectId: string) =>
    appApiGet<ApiPipelineStage[]>(`/project-pipeline-stages?projectId=${encodeURIComponent(projectId)}`),

  create: (
    projectId: string,
    data: { id?: string; name: string; color?: string; position?: number; systemStatus?: string },
  ) => appApiPost<ApiPipelineStage>('/project-pipeline-stages', { projectId, ...data }),

  update: (
    _projectId: string,
    stageId: string,
    data: { name?: string; color?: string; systemStatus?: string },
  ) => appApiPatch<ApiPipelineStage>(`/project-pipeline-stages/${stageId}`, data),

  delete: (_projectId: string, stageId: string, moveTasksToStageId?: string) => {
    const qs = moveTasksToStageId
      ? `?moveTasksToStageId=${encodeURIComponent(moveTasksToStageId)}`
      : '';
    return appApiDelete<{ success: boolean }>(`/project-pipeline-stages/${stageId}${qs}`);
  },

  // projectId is unused (app-api derives scope from the stageIds), kept in
  // the signature so call sites don't churn.
  reorder: (_projectId: string, stageIds: string[]) =>
    appApiPatch<{ success: boolean }>('/project-pipeline-stages/reorder', { stageIds }),
};

// ============ PROJECTS ============

export const projectsApi = {
  list: () => appApiGet<ApiProject[]>('/projects?limit=100'),

  get: (projectId: string) => appApiGet<ApiProject>(`/projects/${projectId}`),

  create: (data: {
    name: string;
    status?: string;
    priority?: string;
    color?: string;
    icon?: string;
  }) => appApiPost<ApiProject>('/projects', data),

  update: (
    projectId: string,
    data: {
      name?: string;
      status?: string;
      priority?: string;
      description?: string;
      color?: string;
      icon?: string;
      startDate?: string | null;
      endDate?: string | null;
    },
  ) => appApiPatch<ApiProject>(`/projects/${projectId}`, data),

  delete: (projectId: string) => appApiDelete<{ deleted: boolean }>(`/projects/${projectId}`),

  getPermissions: (projectId: string) =>
    appApiGet<{ role: string | null; canRead: boolean; canWrite: boolean; isAdmin: boolean }>(
      `/projects/${projectId}/permissions`,
    ),

  search: (query: string) => appApiGet<ApiProject[]>(`/projects/search?q=${encodeURIComponent(query)}`),
};

// ============ TASKS ============

export const tasksApi = {
  // Project-scoped task operations — all now served by app-api /api/tasks/*
  list: (projectId: string, params?: {
    status?: string;
    priority?: string;
    assigneeId?: string;
    sprintId?: string;
    milestoneId?: string;
    search?: string;
    dueDateBucket?: string;
    sortField?: string;
    sortDirection?: string;
    includeSubtasks?: boolean;
    page?: number;
    pageSize?: number;
  }) => {
    const qs = new URLSearchParams({ projectId });
    if (params?.status) qs.set('status', params.status);
    if (params?.priority) qs.set('priority', params.priority);
    if (params?.assigneeId) qs.set('assigneeId', params.assigneeId);
    if (params?.sprintId) qs.set('sprintId', params.sprintId);
    if (params?.milestoneId) qs.set('milestoneId', params.milestoneId);
    if (params?.search) qs.set('search', params.search);
    if (params?.dueDateBucket) qs.set('dueDateBucket', params.dueDateBucket);
    if (params?.sortField) qs.set('sortField', params.sortField);
    if (params?.sortDirection) qs.set('sortDirection', params.sortDirection);
    if (params?.includeSubtasks) qs.set('includeSubtasks', 'true');
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    return appApiGet<ApiTask[]>(`/tasks?${qs}`);
  },

  get: (_projectId: string, taskId: string) => appApiGet<ApiTask>(`/tasks/${taskId}`),

  create: (projectId: string, data: {
    title: string;
    description?: string;
    status?: string;
    stageId?: string;
    priority?: string;
    startDate?: string;
    dueDate?: string;
    duration?: number;
    assigneeId?: string;
    assigneeIds?: string[];
    tags?: string[];
    labels?: string[];
    parentTaskId?: string;
    repeat?: { frequency: string; interval?: number; unit?: string };
    customFields?: Record<string, unknown> | null;
  }) => appApiPost<ApiTask>(`/tasks/projects/${projectId}`, data),

  update: (_projectId: string, taskId: string, data: {
    title?: string;
    description?: string;
    status?: string;
    stageId?: string | null;
    priority?: string;
    startDate?: string;
    dueDate?: string;
    duration?: number;
    assigneeId?: string;
    assigneeIds?: string[] | null;
    customerId?: string | null;
    tags?: string[];
    labels?: string[];
    customFields?: Record<string, unknown> | null;
    parentTaskId?: string | null;
    dependsOn?: string[];
    blocks?: string[];
    repeat?: { frequency: string; interval?: number; unit?: string } | null;
  }) => appApiPatch<ApiTask>(`/tasks/${taskId}`, data),

  delete: (_projectId: string, taskId: string) =>
    appApiDelete<void>(`/tasks/${taskId}`),

  toggle: (_projectId: string, taskId: string, currentStatus: string) =>
    appApiPatch<{ id: string; status: string; nextTaskId?: string }>(
      `/tasks/${taskId}/toggle`,
      { currentStatus },
    ),

  updatePosition: (
    _projectId: string,
    taskId: string,
    data: { position?: number; boardPosition?: number; status?: string },
  ) => appApiPatch<{ id: string }>(`/tasks/${taskId}/position`, data),

  reorderTasks: (projectId: string, taskIds: string[]) =>
    appApiPatch<{ success: boolean }>(
      `/tasks/reorder?projectId=${encodeURIComponent(projectId)}`,
      { taskIds },
    ),

  // Global task operations (across all projects)
  listAll: () => appApiGet<ApiTask[]>('/tasks?limit=1000'),

  getById: (taskId: string) => appApiGet<ApiTask>(`/tasks/${taskId}`),

  createGlobal: (data: {
    projectId?: string;
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    startDate?: string;
    dueDate?: string;
    duration?: number;
    assigneeId?: string;
    assigneeIds?: string[];
    tags?: string[];
    labels?: string[];
    parentTaskId?: string;
    repeat?: { frequency: string; interval?: number; unit?: string } | null;
  }) => appApiPost<ApiTask>('/tasks', data),

  // `nextTaskId` (on `ApiTask`) is present when this update completed a
  // recurring task (server-side creation of the next occurrence).
  updateById: (taskId: string, data: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    startDate?: string;
    dueDate?: string;
    assigneeId?: string;
    tags?: string[];
    labels?: string[];
    repeat?: { frequency: string; interval?: number; unit?: string } | null;
  }) => appApiPatch<ApiTask>(`/tasks/${taskId}`, data),

  deleteById: (taskId: string) =>
    appApiDelete<void>(`/tasks/${taskId}`),

  toggleById: (taskId: string, currentStatus: string) =>
    appApiPatch<{ id: string; status: string; nextTaskId?: string }>(
      `/tasks/${taskId}/toggle`,
      { currentStatus },
    ),

  // Task comments — app-api uses /api/task-comments with taskId query / body
  listComments: (_projectId: string, taskId: string) =>
    appApiGet<ApiTaskComment[]>(
      `/task-comments?taskId=${encodeURIComponent(taskId)}&taskType=project&limit=200`,
    ),

  createComment: (_projectId: string, taskId: string, data: { content: string }) =>
    appApiPost<{ id: string }>('/task-comments', { taskId, taskType: 'project', ...data }),

  updateComment: (
    _projectId: string,
    _taskId: string,
    commentId: string,
    data: { content: string },
  ) => appApiPatch<ApiTaskComment>(`/task-comments/${commentId}`, data),

  deleteComment: (_projectId: string, _taskId: string, commentId: string) =>
    appApiDelete<{ success: boolean }>(`/task-comments/${commentId}`),

  listSubtasks: (_projectId: string, taskId: string) =>
    appApiGet<ApiTask[]>(`/tasks/${taskId}/subtasks`),

  updateDependencies: (
    _projectId: string,
    taskId: string,
    data: { dependsOn?: string[]; blocks?: string[] },
  ) => appApiPut<ApiTask>(`/tasks/${taskId}/dependencies`, data),
};

// ============ GANTT ============

export const ganttApi = {
  // Read endpoints — served by app-api.
  getTasks: (projectId: string) => appApiGet<ApiTask[]>(`/projects/${projectId}/gantt/tasks`),

  getMilestones: (projectId: string) => appApiGet<GanttMilestone[]>(`/projects/${projectId}/gantt/milestones`),

  // Mutations route through the existing /api/tasks and /api/milestones app-api surfaces.
  createTask: (projectId: string, data: {
    title: string;
    startDate?: string;
    dueDate?: string;
    status?: string;
    priority?: string;
    parentTaskId?: string;
  }) => appApiPost<ApiTask>(`/tasks/projects/${projectId}`, data),

  updateTask: (_projectId: string, taskId: string, data: { startDate?: string; dueDate?: string; status?: string }) =>
    appApiPatch<{ id: string }>(`/tasks/${taskId}`, data),

  updateTaskStatus: (taskId: string, status: string) =>
    appApiPatch<{ id: string }>(`/tasks/${taskId}`, { status }),

  updateTaskDates: (_projectId: string, taskId: string, startDate: string, dueDate: string) =>
    appApiPatch<{ id: string }>(`/tasks/${taskId}`, { startDate, dueDate }),

  deleteTask: (_projectId: string, taskId: string) =>
    appApiDelete<{ deleted: boolean }>(`/tasks/${taskId}`),

  createMilestone: (projectId: string, data: { name: string; dueDate: string; description?: string }) =>
    appApiPost<GanttMilestone>('/milestones', { projectId, ...data }),

  updateMilestone: (_projectId: string, milestoneId: string, data: { name?: string; dueDate?: string; status?: string }) =>
    appApiPatch<{ id: string }>(`/milestones/${milestoneId}`, data),

  deleteMilestone: (_projectId: string, milestoneId: string) =>
    appApiDelete<{ deleted: boolean }>(`/milestones/${milestoneId}`),
};

// ============ MEMBERS ============

export const membersApi = {
  list: (projectId: string) =>
    appApiGet<ApiProjectMember[]>(`/project-members?projectId=${encodeURIComponent(projectId)}`),

  // `memberId` is a Clerk userId (members-client passes member.userId).
  get: (projectId: string, userId: string) =>
    appApiGet<ApiProjectMember>(`/project-members/by-user/${projectId}/${userId}`),

  getStats: (projectId: string, userId: string) =>
    appApiGet<ApiMemberStats>(`/project-members/by-user/${projectId}/${userId}/stats`),

  available: (projectId: string) =>
    appApiGet<ApiAvailableProjectUser[]>(`/project-members/available?projectId=${encodeURIComponent(projectId)}`),

  add: (projectId: string, data: { userId: string; role?: string; allocationPercentage?: number }) =>
    appApiPost<ApiProjectMember>('/project-members', { projectId, ...data }),

  update: (
    projectId: string,
    userId: string,
    data: { role?: string; allocationPercentage?: number },
  ) => appApiPatch<ApiProjectMember>(`/project-members/by-user/${projectId}/${userId}`, data),

  remove: (projectId: string, userId: string) =>
    appApiDelete<{ deleted: boolean }>(`/project-members/by-user/${projectId}/${userId}`),
};

// ============ MESSAGES ============

export const messagesApi = {
  list: (projectId: string, limit?: number) => {
    const params = new URLSearchParams({ projectId });
    if (limit) params.set('limit', String(limit));
    return appApiGet<ApiProjectMessage[]>(`/project-messages?${params}`);
  },

  send: (
    projectId: string,
    data: {
      message: string;
      messageType?: string;
      replyToId?: string;
      attachments?: unknown[];
      metadata?: Record<string, unknown>;
    },
  ) => appApiPost<ApiProjectMessage>('/project-messages', { projectId, ...data }),

  update: (_projectId: string, messageId: string, data: { message?: string; isPinned?: boolean }) =>
    appApiPatch<ApiProjectMessage>(`/project-messages/${messageId}`, data),

  delete: (_projectId: string, messageId: string) =>
    appApiDelete<{ deleted: boolean }>(`/project-messages/${messageId}`),

  addReaction: (_projectId: string, messageId: string, emoji: string) =>
    appApiPost<ApiProjectMessage>(`/project-messages/${messageId}/reactions`, { emoji }),
};

// ============ FILES ============

export const filesApi = {
  // The response shape here is intentionally loose: callers (`files-component.tsx`)
  // already handle both a bare array and an `{ items }` envelope, and read
  // either the legacy `contentType`/`size` fields or the raw `project_files`
  // row's `mimeType`/`fileSize` — the same pre-existing legacy-shape gap noted
  // in `hooks/queries/use-projects-queries.ts`'s `useProjectFiles`.
  list: (
    projectId: string,
    params?: { page?: number; limit?: number; search?: string; fileType?: string },
  ) => {
    const searchParams = new URLSearchParams();
    searchParams.set('projectId', projectId);
    if (params?.limit) searchParams.set('limit', String(params.limit));
    return appApiGet<Record<string, unknown>[] | { items: Record<string, unknown>[]; total?: number }>(`/project-files?${searchParams}`);
  },

  get: (_projectId: string, fileId: string) =>
    appApiGet<ApiProjectFile>(`/project-files/${fileId}`),

  // The app-api storage flow is workspace-scoped; entityType+entityId tag the
  // upload so a follow-up confirmUpload can find it. Same shape as the
  // api-worker `/projects/:id/files/upload` token the UI was already using.
  //
  // Like `/api/storage/confirm-upload` below, `/api/storage/generate-upload-url`
  // returns the non-standard FLAT `{ success, uploadUrl, uploadToken, fileKey }`
  // shape (every other caller — weldmail, weldchat, welddesk, settings — reads
  // it that way), so this uses a raw fetch instead of the `appApi*` helpers that
  // unwrap the standard `{ data }` envelope. Routing it through `appApiPost`
  // yielded `data: undefined` and failed every upload at "Failed to prepare
  // upload for <name>" before the PUT was ever attempted.
  generateUploadUrl: async (
    projectId: string,
    data: {
      fileName: string;
      contentType: string;
      fileSize: number;
      folder?: string;
      isPublic?: boolean;
    },
  ): Promise<ApiResponse<{ uploadUrl: string; uploadToken: string; fileKey: string }>> => {
    try {
      const token = await getAuthToken();
      const res = await fetch(`${APP_API_URL}/api/storage/generate-upload-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          ...data,
          folder: data.folder ?? 'project-files',
          entityType: 'project',
          entityId: projectId,
          isPublic: data.isPublic ?? false,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        uploadUrl?: string;
        uploadToken?: string;
        fileKey?: string;
        error?: unknown;
      };
      if (!res.ok || !body?.success || !body.uploadUrl || !body.uploadToken || !body.fileKey) {
        const raw = (body?.error as { message?: string } | string | undefined) ?? undefined;
        const message =
          (typeof raw === 'string' ? raw : raw?.message) ??
          `Failed to generate upload URL (${res.status})`;
        return { success: false, error: message };
      }
      return {
        success: true,
        data: { uploadUrl: body.uploadUrl, uploadToken: body.uploadToken, fileKey: body.fileKey },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  },

  // Two-step confirm: storage confirms the R2 object exists, then we create
  // the project_files row pointing at it. The legacy api-worker did both in
  // one handler; on app-api they're separate endpoints, so glue them here.
  //
  // `/api/storage/confirm-upload` returns the non-standard `{ success, file }`
  // shape (kept for backwards compat with welddesk/weldchat/weldagent
  // callers), so this call uses a raw fetch instead of the `appApi*` helpers
  // that unwrap the standard `{ data }` envelope.
  confirmUpload: async (
    projectId: string,
    data: { uploadToken: string; fileKey: string; etag?: string },
  ) => {
    try {
      const token = await getAuthToken();
      const res = await fetch(`${APP_API_URL}/api/storage/confirm-upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ uploadToken: data.uploadToken, fileKey: data.fileKey }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        file?: {
          id: string;
          fileName: string;
          fileKey: string;
          fileSize: number;
          mimeType: string;
          url: string;
          isPublic: boolean;
        };
        error?: unknown;
      };
      if (!res.ok || !body?.success || !body.file) {
        const message =
          (body && typeof body.error === 'string' ? body.error : null) ??
          `Upload confirmation failed (${res.status})`;
        return { success: false, error: message } as ApiResponse<ApiProjectFile>;
      }
      const f = body.file;
      return appApiPost<ApiProjectFile>('/project-files', {
        projectId,
        fileName: f.fileName,
        originalName: f.fileName,
        mimeType: f.mimeType,
        fileSize: f.fileSize,
        storagePath: f.fileKey,
        fileKey: f.fileKey,
        url: f.url,
        storageProvider: 'r2',
        isPublic: f.isPublic,
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Network error',
      } as ApiResponse<ApiProjectFile>;
    }
  },

  delete: (_projectId: string, fileId: string) =>
    appApiDelete<{ deleted: boolean }>(`/project-files/${fileId}`),
};

// ============ DOCUMENTS (file-backed DOCX) ============
//
// Documents are .docx files in R2, registered in the `files` table with
// entityType='project' + fileType='document'. Content (DOCX binary) is
// fetched/written via fetchDocumentContent / putDocumentContent above;
// list/create/rename/delete go through the /api/project-documents and
// /api/files routes here.

interface DocumentFileRow {
  id: string;
  fileName: string;
  fileSize: number;
  createdAt: string;
  updatedAt: string;
  isPinned?: boolean;
}

const stripDocx = (name: string) => name.replace(/\.docx$/i, '');

export const documentsApi = {
  listDocuments: async (projectId: string) => {
    const res = await appApiGet<DocumentFileRow[]>(`/project-documents/${projectId}`);
    if (!res.success || !res.data) return res as unknown as ApiResponse<DocumentSummary[]>;
    return {
      success: true,
      data: res.data.map((f) => ({
        id: f.id,
        name: stripDocx(f.fileName),
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        isPinned: f.isPinned ?? false,
      })),
    } as ApiResponse<DocumentSummary[]>;
  },

  createDocument: async (projectId: string, data: { name: string }) => {
    const res = await appApiPost<DocumentFileRow>(`/project-documents/${projectId}`, {
      name: data.name,
    });
    if (!res.success || !res.data) return res as unknown as ApiResponse<DocumentSummary>;
    return {
      success: true,
      data: {
        id: res.data.id,
        name: stripDocx(res.data.fileName),
        createdAt: res.data.createdAt,
        updatedAt: res.data.updatedAt,
        isPinned: res.data.isPinned ?? false,
      },
    } as ApiResponse<DocumentSummary>;
  },

  updateDocument: async (_projectId: string, fileId: string, data: { name?: string }) => {
    if (data.name === undefined) return { success: true } as ApiResponse<DocumentSummary>;
    const fileName = data.name.endsWith('.docx') ? data.name : `${data.name}.docx`;
    return appApiPatch<DocumentSummary>(`/files/${fileId}`, { fileName });
  },

  deleteDocument: (_projectId: string, fileId: string) =>
    appApiDelete<{ success: boolean }>(`/files/${fileId}`),

  /** Toggle the workspace-wide pin. Returns the resulting pin state. */
  pinDocument: (_projectId: string, fileId: string) =>
    appApiPost<{ isPinned: boolean }>(`/files/${fileId}/pin`, {}),
};

// ============ GOALS ============

export const goalsApi = {
  get: (projectId: string) => appApiGet<ProjectGoals>(`/goals/by-project/${projectId}`),

  save: (projectId: string, data: { mission?: ProjectGoals['mission']; goals: unknown[] }) =>
    appApiPut<{ saved: boolean }>(`/goals/by-project/${projectId}`, data),
};

// ============ WHITEBOARD ============

export const whiteboardApi = {
  /** @deprecated Use list + get by ID instead — kept for compat with the
   *  old single-whiteboard-per-project shape. Returns the first whiteboard. */
  get: async (projectId: string) => {
    const res = await appApiGet<ApiWhiteboard[]>(
      `/whiteboards?projectId=${encodeURIComponent(projectId)}&limit=1`,
    );
    if (!res.success || !res.data || res.data.length === 0) {
      return { success: true, data: { elements: [] } } as ApiResponse<{ elements: WhiteboardElement[] }>;
    }
    return { success: true, data: { elements: res.data[0].elements ?? [] } } as ApiResponse<{
      elements: WhiteboardElement[];
    }>;
  },

  /** @deprecated Use saveById instead */
  save: async (projectId: string, elements: WhiteboardElement[]) => {
    const list = await appApiGet<ApiWhiteboard[]>(
      `/whiteboards?projectId=${encodeURIComponent(projectId)}&limit=1`,
    );
    const first = list.success && list.data?.[0];
    if (first) {
      return appApiPatch<{ saved: boolean }>(`/whiteboards/${first.id}`, { elements });
    }
    return appApiPost<{ saved: boolean }>('/whiteboards', { projectId, name: 'Whiteboard', elements });
  },

  // Multi-whiteboard endpoints
  list: (projectId: string) =>
    appApiGet<ApiWhiteboard[]>(`/whiteboards?projectId=${encodeURIComponent(projectId)}&limit=100`),

  create: (projectId: string, data: { name: string }) =>
    appApiPost<ApiWhiteboard>('/whiteboards', { projectId, ...data }),

  getById: (_projectId: string, whiteboardId: string) =>
    appApiGet<ApiWhiteboard>(`/whiteboards/${whiteboardId}`),

  saveById: (_projectId: string, whiteboardId: string, elements: WhiteboardElement[]) =>
    appApiPatch<{ id: string }>(`/whiteboards/${whiteboardId}`, { elements }),

  rename: (_projectId: string, whiteboardId: string, name: string) =>
    appApiPatch<ApiWhiteboard>(`/whiteboards/${whiteboardId}`, { name }),

  delete: (_projectId: string, whiteboardId: string) =>
    appApiDelete<{ success: boolean }>(`/whiteboards/${whiteboardId}`),
};

// ============ TIME ENTRIES ============

export const timeEntriesApi = {
  list: (projectId: string, params?: { page?: number; limit?: number; search?: string }) => {
    const searchParams = new URLSearchParams();
    searchParams.set('projectId', projectId);
    if (params?.page) searchParams.set('page', String(params.page));
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.search) searchParams.set('search', params.search);
    return appApiGet<ApiTimeEntry[] | { items: ApiTimeEntry[]; total?: number }>(`/time-entries?${searchParams}`);
  },

  create: (
    projectId: string,
    data: {
      taskId?: string;
      description?: string;
      date: string;
      startTime?: string;
      endTime?: string;
      durationMinutes: number;
      isBillable?: boolean;
      hourlyRate?: number;
    },
  ) =>
    appApiPost<ApiTimeEntry>('/time-entries', {
      projectId,
      taskId: data.taskId,
      description: data.description,
      date: data.date,
      startTime: data.startTime,
      endTime: data.endTime,
      duration: String(data.durationMinutes),
      billable: data.isBillable ?? true,
      rate: data.hourlyRate ? String(data.hourlyRate) : undefined,
    }),

  update: (
    _projectId: string,
    entryId: string,
    data: {
      description?: string;
      date?: string;
      startTime?: string;
      endTime?: string;
      durationMinutes?: number;
      isBillable?: boolean;
      hourlyRate?: number;
    },
  ) =>
    appApiPatch<ApiTimeEntry>(`/time-entries/${entryId}`, {
      description: data.description,
      date: data.date,
      startTime: data.startTime,
      endTime: data.endTime,
      duration: data.durationMinutes !== undefined ? String(data.durationMinutes) : undefined,
      billable: data.isBillable,
      rate: data.hourlyRate ? String(data.hourlyRate) : undefined,
    }),

  delete: (_projectId: string, entryId: string) =>
    appApiDelete<{ deleted: boolean }>(`/time-entries/${entryId}`),

  approve: (_projectId: string, entryId: string) =>
    appApiPatch<ApiTimeEntry>(`/time-entries/${entryId}/approve`),
};

// ============ RUNNING TIMER ============
//
// Server-backed, one per user. The running timer lives in `active_timers`;
// stopping it writes a normal time entry. Because it is server state, it
// survives refresh, navigation, and switching devices.

export interface RunningTimer {
  id: string;
  projectId: string | null;
  taskId: string | null;
  userId: string;
  startedAt: string;
  description: string | null;
  activity: string | null;
  billable: boolean;
  rate: string | null;
}

export interface StartTimerInput {
  projectId?: string;
  taskId?: string;
  description?: string;
  activity?: string;
  billable?: boolean;
  rate?: number;
}

export const timerApi = {
  /** The caller's running timer, or `null` when nothing is running. */
  get: () => appApiGet<RunningTimer | null>('/time-entries/timer'),

  /**
   * Start a timer. Responds 409 with `details.timer` when one is already
   * running, so the caller can offer to stop it first.
   */
  start: (data: StartTimerInput) =>
    appApiPost<RunningTimer>('/time-entries/timer/start', {
      ...data,
      rate: data.rate !== undefined ? String(data.rate) : undefined,
    }),

  /** Stop the timer and record a time entry. Fields here override the ones it started with. */
  stop: (overrides: StartTimerInput = {}) =>
    appApiPost<{ id: string; duration: string; startTime: string; endTime: string }>(
      '/time-entries/timer/stop',
      {
        ...overrides,
        rate: overrides.rate !== undefined ? String(overrides.rate) : undefined,
      },
    ),

  /** Throw the timer away without recording anything. */
  discard: () => appApiDelete<void>('/time-entries/timer'),
};

// ============ WORKLOAD ============

export interface ApiTeamMemberWorkload {
  userId: string;
  name: string;
  email: string;
  avatar: string;
  initials: string;
  role: string;
  capacity: number;
  tasks: {
    id: string;
    title: string;
    projectId: string | null;
    projectName: string;
    estimatedHours: number;
    actualHours: number;
    priority: string;
    status: string;
    startDate: string | null;
    dueDate: string | null;
  }[];
}

export interface ApiWorkloadOverview {
  startDate: string;
  endDate: string;
  totalCapacity: number;
  totalAllocated: number;
  utilization: number;
  overallocatedCount: number;
  teamMembers: ApiTeamMemberWorkload[];
}

export const workloadApi = {
  // Both endpoints are now served by app-api.
  getOverview: () => appApiGet<ApiWorkloadOverview>('/projects/workload/overview'),

  getProject: (projectId: string) => appApiGet<ApiTeamMemberWorkload[]>(`/projects/${projectId}/workload`),
};

// ============ TABLES (Spreadsheet workbooks) ============
//
// Each "table" in the WeldFlow UI is now an .xlsx file in WeldDrive, stored
// as a row in the `files` table (`entityType='project'`, `entityId=projectId`,
// `fileType='spreadsheet'`). The xlsx binary lives in R2 and is fetched /
// overwritten via `fetchSheetContent` / `putSheetContent`. Workbook contents
// (sheets / columns / rows / cell formatting) are managed entirely on the
// client — the server only sees opaque xlsx bytes.

interface SheetFileRow {
  id: string;
  fileName: string;
  fileSize: number;
  createdAt: string;
  updatedAt: string;
  entityType: string | null;
  entityId: string | null;
  fileType: string;
}

const stripXlsx = (name: string) => name.replace(/\.xlsx$/i, '');

export const tablesApi = {
  listTables: async (projectId: string) => {
    const res = await appApiGet<SheetFileRow[]>(`/project-sheets/${projectId}`);
    if (!res.success || !res.data) return res as unknown as ApiResponse<SheetSummary[]>;
    return {
      success: true,
      data: res.data.map((f) => ({
        id: f.id,
        name: stripXlsx(f.fileName),
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    } as ApiResponse<SheetSummary[]>;
  },

  createTable: async (projectId: string, data: { name: string }) => {
    const res = await appApiPost<SheetFileRow>(`/project-sheets/${projectId}`, data);
    if (!res.success || !res.data) return res as unknown as ApiResponse<SheetSummary>;
    return {
      success: true,
      data: {
        id: res.data.id,
        name: stripXlsx(res.data.fileName),
        createdAt: res.data.createdAt,
        updatedAt: res.data.updatedAt,
      },
    } as ApiResponse<SheetSummary>;
  },

  updateTable: async (
    _projectId: string,
    fileId: string,
    data: { name?: string; position?: number; settings?: Record<string, unknown> },
  ) => {
    if (data.name === undefined) return { success: true } as ApiResponse<SheetSummary>;
    const fileName = data.name.endsWith('.xlsx') ? data.name : `${data.name}.xlsx`;
    return appApiPatch<SheetSummary>(`/files/${fileId}`, { fileName });
  },

  deleteTable: (_projectId: string, fileId: string) =>
    appApiDelete<{ success: boolean }>(`/files/${fileId}`),

  // No-op for now — reordering xlsx files would require a new column on `files`
  // (e.g. listPosition). Kept on the API (with its real signature) so future
  // call sites can adopt it without an API shape change.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  reorderTables: async (_projectId: string, _fileIds: string[]) =>
    ({ success: true, data: { reordered: true } }) as ApiResponse<{ reordered: boolean }>,
};

// ============ ANALYTICS ============
// Rewired to app-api (/api/project-analytics/*). Exported signature is
// unchanged so all call sites compile without modification.

// Report/chart create+update payload — mirrors `ApiAnalyticsChart` minus
// the server-assigned fields.
export type ChartInput = Omit<ApiAnalyticsChart, 'id' | 'reportId' | 'layout' | 'sortIndex' | 'createdAt' | 'updatedAt'>;

export const analyticsApi = {
  // getReports/getReport/createReport/updateReport/getCharts/createChart/
  // updateChartLayouts/duplicateChart: the only consumer outside this module
  // (`app/weldflow/project/[projectId]/analytics/**`) declares its own local
  // `AnalyticsReport`/`AnalyticsChart` types with `createdAt`/`updatedAt` typed
  // as `Date` (the wire shape is actually `string`, same pre-existing
  // legacy-shape gap noted in `hooks/queries/use-projects-queries.ts`) — typing
  // these precisely here would surface a type error in that file, which is
  // outside this pass's scope.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getReports: () => appApiGet<any[]>('/project-analytics/reports'),

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getReport: (reportId: string) => appApiGet<any>(`/project-analytics/reports/${reportId}`),

  createReport: (data: { title: string; description?: string }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appApiPost<any>('/project-analytics/reports', data),

  updateReport: (reportId: string, data: { title?: string; description?: string }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appApiPut<any>(`/project-analytics/reports/${reportId}`, data),

  deleteReport: (reportId: string) =>
    appApiDelete<{ deleted: boolean }>(`/project-analytics/reports/${reportId}`),

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCharts: (reportId: string) => appApiGet<any[]>(`/project-analytics/reports/${reportId}/charts`),

  createChart: (reportId: string, data: ChartInput) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appApiPost<any>(`/project-analytics/reports/${reportId}/charts`, data),

  deleteChart: (reportId: string, chartId: string) =>
    appApiDelete<{ deleted: boolean }>(
      `/project-analytics/reports/${reportId}/charts/${chartId}`,
    ),

  getChartData: (reportId: string, config: ChartDataQueryConfig) =>
    appApiPost<Record<string, ChartDataPoint[]>>(`/project-analytics/reports/${reportId}/charts-data`, config),

  getChartsData: (reportId: string, configs: ChartDataQueryConfig[]) =>
    appApiPost<Record<string, ChartDataPoint[]>>(
      `/project-analytics/reports/${reportId}/charts-data`,
      { charts: configs },
    ),

  updateChartLayouts: (
    reportId: string,
    layouts: Array<{ chartId: string; layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number } }>,
  ) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appApiPatch<any>(
      `/project-analytics/reports/${reportId}/charts/layouts`,
      { layouts },
    ),

  duplicateChart: (reportId: string, chartId: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appApiPost<any>(
      `/project-analytics/reports/${reportId}/charts/${chartId}/duplicate`,
      {},
    ),
};
