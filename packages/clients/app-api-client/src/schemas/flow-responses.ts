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
