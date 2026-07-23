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

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** HTTP status on failure — lets call sites branch on 409 etc. */
  status?: number;
  /** `error.details` from the app-api envelope, when the route supplies one. */
  details?: unknown;
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
    const clerk = (window as any).Clerk;
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
async function appApiPost<T>(path: string, data?: any): Promise<ApiResponse<T>> {
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

async function appApiPatch<T>(path: string, data?: any): Promise<ApiResponse<T>> {
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

async function appApiPut<T>(path: string, data?: any): Promise<ApiResponse<T>> {
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
    appApiGet<any[]>(
      `/project-labels${projectId ? `?projectId=${encodeURIComponent(projectId)}&limit=100` : '?limit=100'}`,
    ),

  create: (data: { name: string; color: string; projectId?: string }) =>
    appApiPost<any>('/project-labels', data),

  update: (id: string, data: { name?: string; color?: string }) =>
    appApiPatch<any>(`/project-labels/${id}`, data),

  delete: (id: string) =>
    appApiDelete<{ success: boolean }>(`/project-labels/${id}`),
};

// ============ PIPELINE STAGES ============

export const stagesApi = {
  list: (projectId: string) =>
    appApiGet<any[]>(`/project-pipeline-stages?projectId=${encodeURIComponent(projectId)}`),

  create: (
    projectId: string,
    data: { id?: string; name: string; color?: string; position?: number; systemStatus?: string },
  ) => appApiPost<any>('/project-pipeline-stages', { projectId, ...data }),

  update: (
    _projectId: string,
    stageId: string,
    data: { name?: string; color?: string; systemStatus?: string },
  ) => appApiPatch<any>(`/project-pipeline-stages/${stageId}`, data),

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
  list: () => appApiGet<any[]>('/projects?limit=100'),

  get: (projectId: string) => appApiGet<any>(`/projects/${projectId}`),

  create: (data: {
    name: string;
    status?: string;
    priority?: string;
    color?: string;
    icon?: string;
  }) => appApiPost<any>('/projects', data),

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
  ) => appApiPatch<any>(`/projects/${projectId}`, data),

  delete: (projectId: string) => appApiDelete<{ deleted: boolean }>(`/projects/${projectId}`),

  getPermissions: (projectId: string) =>
    appApiGet<{ role: string | null; canRead: boolean; canWrite: boolean; isAdmin: boolean }>(
      `/projects/${projectId}/permissions`,
    ),

  search: (query: string) => appApiGet<any[]>(`/projects/search?q=${encodeURIComponent(query)}`),
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
    return appApiGet<any[]>(`/tasks?${qs}`);
  },

  get: (_projectId: string, taskId: string) => appApiGet<any>(`/tasks/${taskId}`),

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
    customFields?: Record<string, any> | null;
  }) => appApiPost<any>(`/tasks/projects/${projectId}`, data),

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
    customFields?: Record<string, any> | null;
    parentTaskId?: string | null;
    dependsOn?: string[];
    blocks?: string[];
    repeat?: { frequency: string; interval?: number; unit?: string } | null;
  }) => appApiPatch<any>(`/tasks/${taskId}`, data),

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
  listAll: () => appApiGet<any[]>('/tasks?limit=1000'),

  getById: (taskId: string) => appApiGet<any>(`/tasks/${taskId}`),

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
  }) => appApiPost<any>('/tasks', data),

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
  }) => appApiPatch<any>(`/tasks/${taskId}`, data),

  deleteById: (taskId: string) =>
    appApiDelete<void>(`/tasks/${taskId}`),

  toggleById: (taskId: string, currentStatus: string) =>
    appApiPatch<{ id: string; status: string; nextTaskId?: string }>(
      `/tasks/${taskId}/toggle`,
      { currentStatus },
    ),

  // Task comments — app-api uses /api/task-comments with taskId query / body
  listComments: (_projectId: string, taskId: string) =>
    appApiGet<any[]>(
      `/task-comments?taskId=${encodeURIComponent(taskId)}&taskType=project&limit=200`,
    ),

  createComment: (_projectId: string, taskId: string, data: { content: string }) =>
    appApiPost<{ id: string }>('/task-comments', { taskId, taskType: 'project', ...data }),

  updateComment: (
    _projectId: string,
    _taskId: string,
    commentId: string,
    data: { content: string },
  ) => appApiPatch<any>(`/task-comments/${commentId}`, data),

  deleteComment: (_projectId: string, _taskId: string, commentId: string) =>
    appApiDelete<{ success: boolean }>(`/task-comments/${commentId}`),

  listSubtasks: (_projectId: string, taskId: string) =>
    appApiGet<any[]>(`/tasks/${taskId}/subtasks`),

  updateDependencies: (
    _projectId: string,
    taskId: string,
    data: { dependsOn?: string[]; blocks?: string[] },
  ) => appApiPut<any>(`/tasks/${taskId}/dependencies`, data),
};

// ============ GANTT ============

export const ganttApi = {
  // Read endpoints — served by app-api.
  getTasks: (projectId: string) => appApiGet<any[]>(`/projects/${projectId}/gantt/tasks`),

  getMilestones: (projectId: string) => appApiGet<any[]>(`/projects/${projectId}/gantt/milestones`),

  // Mutations route through the existing /api/tasks and /api/milestones app-api surfaces.
  createTask: (projectId: string, data: {
    title: string;
    startDate?: string;
    dueDate?: string;
    status?: string;
    priority?: string;
    parentTaskId?: string;
  }) => appApiPost<any>(`/tasks/projects/${projectId}`, data),

  updateTask: (_projectId: string, taskId: string, data: { startDate?: string; dueDate?: string; status?: string }) =>
    appApiPatch<{ id: string }>(`/tasks/${taskId}`, data),

  updateTaskStatus: (taskId: string, status: string) =>
    appApiPatch<{ id: string }>(`/tasks/${taskId}`, { status }),

  updateTaskDates: (_projectId: string, taskId: string, startDate: string, dueDate: string) =>
    appApiPatch<{ id: string }>(`/tasks/${taskId}`, { startDate, dueDate }),

  deleteTask: (_projectId: string, taskId: string) =>
    appApiDelete<{ deleted: boolean }>(`/tasks/${taskId}`),

  createMilestone: (projectId: string, data: { name: string; dueDate: string; description?: string }) =>
    appApiPost<any>('/milestones', { projectId, ...data }),

  updateMilestone: (_projectId: string, milestoneId: string, data: { name?: string; dueDate?: string; status?: string }) =>
    appApiPatch<{ id: string }>(`/milestones/${milestoneId}`, data),

  deleteMilestone: (_projectId: string, milestoneId: string) =>
    appApiDelete<{ deleted: boolean }>(`/milestones/${milestoneId}`),
};

// ============ MEMBERS ============

export const membersApi = {
  list: (projectId: string) =>
    appApiGet<any[]>(`/project-members?projectId=${encodeURIComponent(projectId)}`),

  // `memberId` is a Clerk userId (members-client passes member.userId).
  get: (projectId: string, userId: string) =>
    appApiGet<any>(`/project-members/by-user/${projectId}/${userId}`),

  getStats: (projectId: string, userId: string) =>
    appApiGet<any>(`/project-members/by-user/${projectId}/${userId}/stats`),

  available: (projectId: string) =>
    appApiGet<any[]>(`/project-members/available?projectId=${encodeURIComponent(projectId)}`),

  add: (projectId: string, data: { userId: string; role?: string }) =>
    appApiPost<any>('/project-members', { projectId, ...data }),

  update: (
    projectId: string,
    userId: string,
    data: { role?: string; allocationPercentage?: number },
  ) => appApiPatch<any>(`/project-members/by-user/${projectId}/${userId}`, data),

  remove: (projectId: string, userId: string) =>
    appApiDelete<{ deleted: boolean }>(`/project-members/by-user/${projectId}/${userId}`),
};

// ============ MESSAGES ============

export const messagesApi = {
  list: (projectId: string, limit?: number) => {
    const params = new URLSearchParams({ projectId });
    if (limit) params.set('limit', String(limit));
    return appApiGet<any[]>(`/project-messages?${params}`);
  },

  send: (
    projectId: string,
    data: {
      message: string;
      messageType?: string;
      replyToId?: string;
      attachments?: any[];
      metadata?: Record<string, unknown>;
    },
  ) => appApiPost<any>('/project-messages', { projectId, ...data }),

  update: (_projectId: string, messageId: string, data: { message?: string; isPinned?: boolean }) =>
    appApiPatch<any>(`/project-messages/${messageId}`, data),

  delete: (_projectId: string, messageId: string) =>
    appApiDelete<{ deleted: boolean }>(`/project-messages/${messageId}`),

  addReaction: (_projectId: string, messageId: string, emoji: string) =>
    appApiPost<any>(`/project-messages/${messageId}/reactions`, { emoji }),
};

// ============ FILES ============

export const filesApi = {
  list: (
    projectId: string,
    params?: { page?: number; limit?: number; search?: string; fileType?: string },
  ) => {
    const searchParams = new URLSearchParams();
    searchParams.set('projectId', projectId);
    if (params?.limit) searchParams.set('limit', String(params.limit));
    return appApiGet<any>(`/project-files?${searchParams}`);
  },

  get: (_projectId: string, fileId: string) =>
    appApiGet<any>(`/project-files/${fileId}`),

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
        return { success: false, error: message } as ApiResponse<any>;
      }
      const f = body.file;
      return appApiPost<any>('/project-files', {
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
      } as ApiResponse<any>;
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
    if (!res.success || !res.data) return res as ApiResponse<any[]>;
    return {
      success: true,
      data: res.data.map((f) => ({
        id: f.id,
        name: stripDocx(f.fileName),
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        isPinned: f.isPinned ?? false,
      })),
    } as ApiResponse<any[]>;
  },

  createDocument: async (projectId: string, data: { name: string }) => {
    const res = await appApiPost<DocumentFileRow>(`/project-documents/${projectId}`, {
      name: data.name,
    });
    if (!res.success || !res.data) return res as ApiResponse<any>;
    return {
      success: true,
      data: {
        id: res.data.id,
        name: stripDocx(res.data.fileName),
        createdAt: res.data.createdAt,
        updatedAt: res.data.updatedAt,
      },
    } as ApiResponse<any>;
  },

  updateDocument: async (_projectId: string, fileId: string, data: { name?: string }) => {
    if (data.name === undefined) return { success: true } as ApiResponse<any>;
    const fileName = data.name.endsWith('.docx') ? data.name : `${data.name}.docx`;
    return appApiPatch<any>(`/files/${fileId}`, { fileName });
  },

  deleteDocument: (_projectId: string, fileId: string) =>
    appApiDelete<{ success: boolean }>(`/files/${fileId}`),

  /** Toggle the workspace-wide pin. Returns the resulting pin state. */
  pinDocument: (_projectId: string, fileId: string) =>
    appApiPost<{ isPinned: boolean }>(`/files/${fileId}/pin`, {}),
};

// ============ GOALS ============

export const goalsApi = {
  get: (projectId: string) => appApiGet<any>(`/goals/by-project/${projectId}`),

  save: (projectId: string, data: { mission?: any; goals: any[] }) =>
    appApiPut<{ saved: boolean }>(`/goals/by-project/${projectId}`, data),
};

// ============ WHITEBOARD ============

export const whiteboardApi = {
  /** @deprecated Use list + get by ID instead — kept for compat with the
   *  old single-whiteboard-per-project shape. Returns the first whiteboard. */
  get: async (projectId: string) => {
    const res = await appApiGet<any[]>(
      `/whiteboards?projectId=${encodeURIComponent(projectId)}&limit=1`,
    );
    if (!res.success || !res.data || res.data.length === 0) {
      return { success: true, data: { elements: [] } } as ApiResponse<{ elements: any[] }>;
    }
    return { success: true, data: { elements: res.data[0].elements ?? [] } } as ApiResponse<{
      elements: any[];
    }>;
  },

  /** @deprecated Use saveById instead */
  save: async (projectId: string, elements: any[]) => {
    const list = await appApiGet<any[]>(
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
    appApiGet<any[]>(`/whiteboards?projectId=${encodeURIComponent(projectId)}&limit=100`),

  create: (projectId: string, data: { name: string }) =>
    appApiPost<any>('/whiteboards', { projectId, ...data }),

  getById: (_projectId: string, whiteboardId: string) =>
    appApiGet<any>(`/whiteboards/${whiteboardId}`),

  saveById: (_projectId: string, whiteboardId: string, elements: any[]) =>
    appApiPatch<{ id: string }>(`/whiteboards/${whiteboardId}`, { elements }),

  rename: (_projectId: string, whiteboardId: string, name: string) =>
    appApiPatch<any>(`/whiteboards/${whiteboardId}`, { name }),

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
    return appApiGet<any>(`/time-entries?${searchParams}`);
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
    appApiPost<any>('/time-entries', {
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
    appApiPatch<any>(`/time-entries/${entryId}`, {
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
    appApiPatch<any>(`/time-entries/${entryId}/approve`),
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

export const workloadApi = {
  // Both endpoints are now served by app-api.
  getOverview: () => appApiGet<any>('/projects/workload/overview'),

  getProject: (projectId: string) => appApiGet<any>(`/projects/${projectId}/workload`),
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
    if (!res.success || !res.data) return res as ApiResponse<any[]>;
    return {
      success: true,
      data: res.data.map((f) => ({
        id: f.id,
        name: stripXlsx(f.fileName),
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    } as ApiResponse<any[]>;
  },

  createTable: async (projectId: string, data: { name: string }) => {
    const res = await appApiPost<SheetFileRow>(`/project-sheets/${projectId}`, data);
    if (!res.success || !res.data) return res as ApiResponse<any>;
    return {
      success: true,
      data: {
        id: res.data.id,
        name: stripXlsx(res.data.fileName),
        createdAt: res.data.createdAt,
        updatedAt: res.data.updatedAt,
      },
    } as ApiResponse<any>;
  },

  updateTable: async (
    _projectId: string,
    fileId: string,
    data: { name?: string; position?: number; settings?: any },
  ) => {
    if (data.name === undefined) return { success: true } as ApiResponse<any>;
    const fileName = data.name.endsWith('.xlsx') ? data.name : `${data.name}.xlsx`;
    return appApiPatch<any>(`/files/${fileId}`, { fileName });
  },

  deleteTable: (_projectId: string, fileId: string) =>
    appApiDelete<{ success: boolean }>(`/files/${fileId}`),

  // No-op for now — reordering xlsx files would require a new column on `files`
  // (e.g. listPosition). Kept on the API so call sites don't break.
  reorderTables: async (_projectId: string, _fileIds: string[]) =>
    ({ success: true, data: { reordered: true } }) as ApiResponse<{ reordered: boolean }>,
};

// ============ ANALYTICS ============
// Rewired to app-api (/api/project-analytics/*). Exported signature is
// unchanged so all call sites compile without modification.

export const analyticsApi = {
  getReports: () => appApiGet<any[]>('/project-analytics/reports'),

  getReport: (reportId: string) =>
    appApiGet<any>(`/project-analytics/reports/${reportId}`),

  createReport: (data: { title: string; description?: string }) =>
    appApiPost<any>('/project-analytics/reports', data),

  updateReport: (reportId: string, data: { title?: string; description?: string }) =>
    appApiPut<any>(`/project-analytics/reports/${reportId}`, data),

  deleteReport: (reportId: string) =>
    appApiDelete<{ deleted: boolean }>(`/project-analytics/reports/${reportId}`),

  getCharts: (reportId: string) =>
    appApiGet<any[]>(`/project-analytics/reports/${reportId}/charts`),

  createChart: (reportId: string, data: any) =>
    appApiPost<any>(`/project-analytics/reports/${reportId}/charts`, data),

  deleteChart: (reportId: string, chartId: string) =>
    appApiDelete<{ deleted: boolean }>(
      `/project-analytics/reports/${reportId}/charts/${chartId}`,
    ),

  getChartData: (reportId: string, config: any) =>
    appApiPost<any>(`/project-analytics/reports/${reportId}/charts-data`, config),

  getChartsData: (reportId: string, configs: any[]) =>
    appApiPost<Record<string, any[]>>(
      `/project-analytics/reports/${reportId}/charts-data`,
      { charts: configs },
    ),

  updateChartLayouts: (
    reportId: string,
    layouts: Array<{ chartId: string; layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number } }>,
  ) =>
    appApiPatch<any>(
      `/project-analytics/reports/${reportId}/charts/layouts`,
      { layouts },
    ),

  duplicateChart: (reportId: string, chartId: string) =>
    appApiPost<any>(
      `/project-analytics/reports/${reportId}/charts/${chartId}/duplicate`,
      {},
    ),
};
