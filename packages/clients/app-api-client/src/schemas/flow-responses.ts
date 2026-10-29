/**
 * Response shapes of flow-api (WeldFlow): projects, members, tasks, sprints,
 * milestones, goals, documents, files, messages, time entries and the rest.
 *
 * The platform reads these through TypeScript interfaces; these Zod schemas
 * mirror them so the Rust backend's answers are checked against the same
 * shapes (`packages/core/worker-kit/src/testing/conformance-schemas.ts`).
 * Rows are `.passthrough()`: the routes answer whole table rows, and the
 * schemas pin the fields the clients read.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
const optionalNullableString = z.string().nullable().optional();
/** A Drizzle `numeric` column: a string, or a number where a route defaults it. */
const numericText = z.union([z.string(), z.number()]).nullable();

/** `{ id }`: what a create or update answers. */
export const flowIdResultSchema = z.object({ id: z.string() });

// ── projects ────────────────────────────────────────────────────────────────

/** A project row with the stats computed on read. */
export const flowProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: nullableString,
    status: z.string(),
    code: nullableString,
    priority: nullableString,
    health: nullableString,
    projectManagerId: nullableString,
    customerId: nullableString,
    startDate: nullableString,
    endDate: nullableString,
    color: nullableString,
    icon: nullableString,
    isActive: z.boolean(),
    isBillable: z.boolean(),
    budgetedHours: numericText,
    hourlyRate: numericText,
    settings: z.record(z.unknown()).nullable(),
    totalTasks: z.number().int(),
    completedTasks: z.number().int(),
    openTasks: z.number().int(),
    totalMilestones: z.number().int(),
    completedMilestones: z.number().int(),
    progress: z.string(),
    actualHours: z.string(),
    customFields: z.record(z.unknown()).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: nullableString,
  })
  .passthrough();

/** `GET /api/projects/:id/permissions`. */
export const flowProjectPermissionsSchema = z.object({
  role: nullableString,
  canRead: z.boolean(),
  canWrite: z.boolean(),
  isAdmin: z.boolean(),
});

/** A task on a workload card. */
export const flowWorkloadTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    projectId: nullableString,
    projectName: z.string(),
    estimatedHours: numericText,
    actualHours: numericText,
    priority: z.string(),
    status: z.string(),
    startDate: nullableString,
    dueDate: nullableString,
    number: z.number().int().nullable().optional(),
    key: optionalNullableString,
  })
  .passthrough();

/** One person on a workload view. */
export const flowWorkloadMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  avatar: z.string(),
  initials: z.string(),
  role: z.string(),
  capacity: z.number(),
  tasks: z.array(flowWorkloadTaskSchema),
});

/** `GET /api/projects/workload/overview`. */
export const flowWorkloadOverviewSchema = z.object({
  totalProjects: z.number().int(),
  totalMembers: z.number().int(),
  totalTasks: z.number().int(),
  teamMembers: z.array(flowWorkloadMemberSchema),
  unassigned: z.object({ tasks: z.array(flowWorkloadTaskSchema) }),
});

/** `GET /api/projects/:id/workload`. */
export const flowProjectWorkloadSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  totalMembers: z.number().int(),
  totalTasks: z.number().int(),
  teamMembers: z.array(flowWorkloadMemberSchema),
});

/** `GET /api/projects/:id/gantt/tasks`. */
export const flowGanttTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    projectId: nullableString,
    milestoneId: nullableString,
    parentTaskId: nullableString,
    sprintId: nullableString,
    startDate: nullableString,
    dueDate: nullableString,
    completedDate: nullableString,
    status: z.string(),
    priority: z.string(),
    progress: z.string(),
    assigneeId: nullableString,
    type: nullableString,
    dependsOn: z.array(z.string()).nullable(),
    blocks: z.array(z.string()).nullable(),
    estimatedHours: numericText,
    actualHours: numericText,
  })
  .passthrough();

/** `GET /api/projects/:id/gantt/milestones`. */
export const flowGanttMilestoneSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: nullableString,
    dueDate: z.string(),
    completedAt: nullableString,
    status: z.string(),
    progress: z.string(),
    ownerId: nullableString,
    isKeyMilestone: z.boolean().nullable(),
    dependsOn: z.array(z.string()).nullable(),
    completedTasks: z.number().int(),
    totalTasks: z.number().int(),
    createdAt: z.string(),
  })
  .passthrough();

/** `POST /api/projects/:projectId/tasks/import-jobs`. */
export const flowImportJobStartedSchema = z.object({
  jobId: z.string(),
  total: z.number().int(),
  status: z.string(),
});

/** `GET /api/projects/:projectId/tasks/import-jobs/:jobId`. */
export const flowImportJobStatusSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  total: z.number().int(),
  processed: z.number().int(),
  imported: z.number().int(),
  updated: z.number().int(),
  failed: z.number().int(),
  errors: z.array(z.object({ row: z.number(), title: z.string(), error: z.string() }).passthrough()),
  errorMessage: nullableString,
  createdAt: z.string(),
  completedAt: nullableString,
});

// ── project members ────────────────────────────────────────────────────────

const memberUserSchema = z
  .object({ id: nullableString, name: nullableString, email: nullableString, avatar: nullableString })
  .nullable();

/** A project member, with their workspace profile where the route joins it. */
export const flowProjectMemberSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    userId: z.string(),
    role: z.string(),
    permissions: z.array(z.string()).nullable(),
    isActive: z.boolean(),
    joinedAt: z.string(),
    leftAt: nullableString,
    allocationPercentage: nullableString,
    hourlyRate: nullableString,
    user: memberUserSchema.optional(),
  })
  .passthrough();

/** `GET /api/project-members/available`. */
export const flowAvailableUserSchema = z.object({
  id: z.string(),
  name: nullableString,
  email: nullableString,
  image: nullableString,
});

/** `GET /api/project-members/by-user/:projectId/:userId/stats`. */
export const flowMemberStatsSchema = z.object({
  tasksAssigned: z.number(),
  tasksCompleted: z.number(),
  hoursLogged: z.number(),
  overdue: z.number(),
});

/** `PATCH /api/project-members/by-user/:projectId/:userId`: the change, echoed. */
export const flowMemberUpdateSchema = z
  .object({
    projectId: z.string(),
    userId: z.string(),
    role: z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
    permissions: z.array(z.string()).optional(),
    allocationPercentage: z.string().optional(),
    hourlyRate: z.string().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

// ── sprints, milestones, goals, whiteboards ────────────────────────────────

/** A sprint row. */
export const flowSprintSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    goal: nullableString,
    status: z.string(),
    startDate: nullableString,
    endDate: nullableString,
    startedAt: nullableString,
    completedAt: nullableString,
    velocity: z.number().int().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** A milestone row with its task counters computed on read. */
export const flowMilestoneSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    description: nullableString,
    dueDate: z.string(),
    completedAt: nullableString,
    status: z.string(),
    progress: z.string(),
    totalTasks: z.number().int(),
    completedTasks: z.number().int(),
    ownerId: nullableString,
    isKeyMilestone: z.boolean().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** A `project_goals` row (one project's goals canvas). */
export const flowGoalRowSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    mission: z.unknown(),
    goals: z.array(z.unknown()).nullable(),
    lastEditedBy: nullableString,
    createdAt: nullableString,
    updatedAt: nullableString,
  })
  .passthrough();

/** `GET /api/goals/by-project/:projectId`. */
export const flowGoalsCanvasSchema = z.object({ mission: z.unknown(), goals: z.array(z.unknown()) });

/** `POST /api/goals`: the canvas row and the new card. */
export const flowGoalCreatedSchema = z.object({ id: z.string(), goalId: z.string() });

/** A whiteboard row. */
export const flowWhiteboardSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    elements: z.array(z.unknown()).nullable(),
    version: z.number().int(),
    lastEditedBy: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

// ── labels, pipeline stages, messages ──────────────────────────────────────

/** A project label row (`usageCount` on the list). */
export const flowLabelSchema = z
  .object({
    id: z.string(),
    projectId: nullableString,
    name: z.string(),
    color: z.string(),
    usageCount: z.number().int().optional(),
    createdAt: z.string(),
  })
  .passthrough();

/** What a label create or update echoes. */
export const flowLabelWriteSchema = z
  .object({ id: z.string(), name: z.string().optional(), color: z.string().optional(), projectId: nullableString.optional() })
  .passthrough();

/** A pipeline stage row (`usageCount` on the list). */
export const flowStageSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    color: nullableString,
    position: z.number().int(),
    systemStatus: z.string(),
    usageCount: z.number().int().optional(),
    createdAt: z.string(),
  })
  .passthrough();

/** `PATCH /api/project-pipeline-stages/reorder`. */
export const flowReorderedSchema = z.object({ reordered: z.literal(true) });

/** A project message row. */
export const flowMessageSchema = z
  .object({
    id: z.string(),
    projectId: nullableString,
    conversationId: z.string(),
    senderId: z.string(),
    message: z.string(),
    messageType: z.string(),
    replyToId: nullableString,
    editedAt: nullableString,
    isRead: z.boolean(),
    reactions: z.record(z.array(z.string())).nullable(),
    createdAt: z.string(),
  })
  .passthrough();

/** `POST /api/project-messages`. */
export const flowMessageCreatedSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  senderId: z.string(),
  message: z.string(),
});

/** `PATCH /api/project-messages/:id`: the change, echoed. */
export const flowMessageUpdatedSchema = z
  .object({ id: z.string(), message: z.string().optional(), isPinned: z.boolean().optional() })
  .strict();

/** `POST /api/project-messages/:id/reactions`. */
export const flowMessageReactionsSchema = z.object({ id: z.string(), reactions: z.record(z.array(z.string())) });

// ── files and documents ────────────────────────────────────────────────────

/** A `project_files` row (a file or a folder). */
export const flowProjectFileSchema = z
  .object({
    id: z.string(),
    projectId: nullableString,
    parentId: nullableString,
    fileName: z.string(),
    mimeType: z.string(),
    fileSize: z.number().int(),
    storagePath: z.string(),
    fileType: z.string(),
    isFolder: z.boolean(),
    createdAt: z.string(),
  })
  .passthrough();

/** A drive `files` row (project documents and sheets). */
export const flowDriveFileSchema = z
  .object({
    id: z.string(),
    fileName: z.string(),
    mimeType: z.string(),
    fileSize: z.number().int(),
    fileType: z.string(),
    folderId: nullableString,
    entityType: nullableString,
    entityId: nullableString,
    createdAt: z.string(),
  })
  .passthrough();

/** A `docs` row (BlockNote JSON of a document from before WeldDocs). */
export const flowDocSchema = z
  .object({
    id: z.string(),
    fileId: z.string(),
    content: z.array(z.record(z.unknown())).nullable(),
    updatedById: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** A document version in the history list. */
export const flowDocVersionSummarySchema = z.object({
  id: z.string(),
  fileId: z.string(),
  label: nullableString,
  createdById: nullableString,
  createdAt: z.string(),
});

/** A whole document version. */
export const flowDocVersionSchema = flowDocVersionSummarySchema.extend({
  content: z.array(z.record(z.unknown())),
});

// ── personal lists, digest settings ────────────────────────────────────────

/** One of the caller's task tags. */
export const flowTaskTagSchema = z
  .object({ id: z.string(), userId: z.string(), name: z.string(), color: nullableString, createdAt: z.string() })
  .passthrough();

/** One of the caller's saved task projects. */
export const flowTaskProjectSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    description: nullableString,
    color: nullableString,
    createdAt: z.string(),
  })
  .passthrough();

/** The workspace's task digest settings (`id` null before any are saved). */
export const flowDigestSettingsSchema = z.object({
  id: nullableString,
  enabled: z.boolean(),
  sendHour: z.number().int().min(0).max(23),
  taskTypes: z.object({ projectTasks: z.boolean(), personalTasks: z.boolean() }),
  sections: z.object({ overdue: z.boolean(), dueToday: z.boolean(), dueThisWeek: z.boolean() }),
  createdAt: nullableString,
  updatedAt: nullableString,
});

// ── tasks ───────────────────────────────────────────────────────────────────

/** A workspace member on a task (`assignee`, `assignees`). */
const flowTaskAssigneeSchema = z.object({
  id: z.string(),
  name: nullableString,
  email: nullableString,
  avatar: nullableString,
});

/** A task's linked CRM company or person. */
const flowLinkedRecordSchema = z.object({ id: z.string(), name: nullableString, avatar: nullableString });

/** A task row (`TaskRow`) with what the lists add to it. */
export const flowTaskSchema = z
  .object({
    id: z.string(),
    number: z.number().int().nullable().optional(),
    title: z.string(),
    description: optionalNullableString,
    projectId: optionalNullableString,
    sprintId: optionalNullableString,
    milestoneId: optionalNullableString,
    parentTaskId: optionalNullableString,
    stageId: optionalNullableString,
    customerId: optionalNullableString,
    contactId: optionalNullableString,
    personId: optionalNullableString,
    status: z.string(),
    priority: z.string(),
    type: optionalNullableString,
    tags: z.array(z.string()).nullable().optional(),
    labels: z.array(z.string()).nullable().optional(),
    assigneeId: optionalNullableString,
    assigneeIds: z.array(z.string()).nullable().optional(),
    reporterId: optionalNullableString,
    startDate: optionalNullableString,
    dueDate: optionalNullableString,
    completedDate: optionalNullableString,
    estimatedHours: numericText.optional(),
    actualHours: numericText.optional(),
    duration: z.number().nullable().optional(),
    storyPoints: z.number().nullable().optional(),
    dependsOn: z.array(z.string()).nullable().optional(),
    blocks: z.array(z.string()).nullable().optional(),
    position: z.number().optional(),
    boardPosition: z.number().nullable().optional(),
    repeat: z
      .object({ frequency: z.string(), interval: z.number().optional(), unit: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
    customFields: z.record(z.unknown()).nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    assignee: flowTaskAssigneeSchema.nullable().optional(),
    assignees: z.array(flowTaskAssigneeSchema).optional(),
    scheduledStart: optionalNullableString,
    scheduledEnd: optionalNullableString,
    autoScheduled: z.boolean().nullable().optional(),
    linkedCompany: flowLinkedRecordSchema.nullable().optional(),
    linkedPerson: flowLinkedRecordSchema.nullable().optional(),
    subtaskCount: z.number().int().optional(),
    completedSubtaskCount: z.number().int().optional(),
    attachmentsCount: z.number().int().optional(),
    children: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** A task attachment (`TaskAttachmentRow`). */
export const flowTaskAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileKey: z.string(),
  fileSize: z.number().int(),
  mimeType: z.string(),
  url: z.string(),
});

/** `GET /api/tasks/:id`: the task with its counts and attachments. */
export const flowTaskDetailSchema = flowTaskSchema.extend({
  subtaskCount: z.number().int(),
  completedSubtaskCount: z.number().int(),
  attachments: z.array(flowTaskAttachmentSchema),
});

/** A My Tasks row: the task with its project's summary. */
export const flowMyTaskSchema = flowTaskSchema.extend({
  project: z
    .object({ id: z.string(), name: z.string(), color: nullableString, icon: nullableString, status: nullableString })
    .nullable(),
});

/** `PATCH /api/tasks/:id`: the id and the fields the body set. */
export const flowTaskUpdatedSchema = z
  .object({ id: z.string(), nextTaskId: z.string().optional() })
  .passthrough();

/** `PATCH /api/tasks/:id/status` and `/toggle`. */
export const flowTaskStatusSchema = z.object({
  id: z.string(),
  status: z.string(),
  stageId: nullableString,
  nextTaskId: z.string().optional(),
});

/** `PATCH /api/tasks/:id/position`. */
export const flowTaskPositionSchema = z.object({
  id: z.string(),
  position: z.number().optional(),
  status: z.string().optional(),
  nextTaskId: z.string().optional(),
});

/** `PUT /api/tasks/:id/dependencies`. */
export const flowTaskDependenciesSchema = z.object({
  id: z.string(),
  dependsOn: z.array(z.string()),
  blocks: z.array(z.string()),
});

/** `POST /api/tasks/:id/move`. */
export const flowTaskMovedSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  movedSubtaskCount: z.number().int(),
});

/** `{ success: true }`. */
export const flowSuccessSchema = z.object({ success: z.literal(true) });
