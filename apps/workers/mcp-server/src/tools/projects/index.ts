import { z } from 'zod';
import {
  createProjectSchema,
  updateProjectSchema,
} from '../../schemas/projects';
import {
  createTaskSchema,
  updateTaskSchema,
} from '../../schemas/tasks';
import {
  createTaskCommentSchema,
  updateTaskCommentSchema,
} from '../../schemas/task-comments';
import {
  createTaskTagSchema,
  updateTaskTagSchema,
} from '../../schemas/task-tags';
import {
  createSprintSchema,
  updateSprintSchema,
} from '../../schemas/sprints';
import {
  createMilestoneSchema,
  updateMilestoneSchema,
} from '../../schemas/milestones';
import {
  createGoalSchema,
  updateGoalSchema,
} from '../../schemas/goals';
import type { ToolDefinition } from '../registry';

export const projectsTools: ToolDefinition[] = [
  // ── Projects ──────────────────────────────────────────────────────────────
  {
    name: 'search_projects',
    scope: 'projects:read',
    description: 'Search WeldFlow projects by name, code, or description. Returns matching projects with key details.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
      search: z.string().optional().describe('Search text (matches name)'),
      status: z.string().optional().describe('Filter by status (e.g. Planning, Active, OnHold, Completed, Cancelled)'),
      ownerId: z.string().optional().describe('Filter by project manager / owner user ID'),
      isActive: z.boolean().optional().describe('If true, only return projects with isActive=true'),
    },
    method: 'GET',
    path: '/v1/projects',
  },
  {
    name: 'get_project',
    scope: 'projects:read',
    description: 'Get a WeldFlow project by ID, including budget, counters, and customization fields.',
    inputSchema: {
      projectId: z.string().describe('The project ID'),
    },
    method: 'GET',
    path: '/v1/projects/:id',
    pathParams: { id: 'projectId' },
  },
  {
    name: 'create_project',
    scope: 'projects:write',
    description: 'Create a new WeldFlow project.',
    inputSchema: createProjectSchema.shape,
    method: 'POST',
    path: '/v1/projects',
  },
  {
    name: 'update_project',
    scope: 'projects:write',
    description: 'Update an existing WeldFlow project.',
    inputSchema: {
      projectId: z.string().describe('The project ID to update'),
      ...updateProjectSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/projects/:id',
    pathParams: { id: 'projectId' },
  },
  {
    name: 'delete_project',
    scope: 'projects:write',
    description: 'Soft-delete a WeldFlow project by ID.',
    inputSchema: {
      projectId: z.string().describe('The project ID'),
    },
    method: 'DELETE',
    path: '/v1/projects/:id',
    pathParams: { id: 'projectId' },
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  {
    name: 'search_tasks',
    scope: 'tasks:read',
    description: 'Search WeldFlow tasks by project, assignee, status, or priority.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
      search: z.string().optional().describe('Search text (matches title, description)'),
      projectId: z.string().optional().describe('Filter by project ID'),
      assigneeId: z.string().optional().describe('Filter by assignee user ID'),
      status: z.string().optional().describe('Filter by status'),
      priority: z.string().optional().describe('Filter by priority'),
      type: z.string().optional().describe('Filter by task type'),
      sprintId: z.string().optional().describe('Filter by sprint ID'),
      milestoneId: z.string().optional().describe('Filter by milestone ID'),
      parentTaskId: z.string().optional().describe('Filter by parent task ID'),
      dueDateFrom: z.string().optional().describe('Filter by due date range start (ISO 8601)'),
      dueDateTo: z.string().optional().describe('Filter by due date range end (ISO 8601)'),
    },
    method: 'GET',
    path: '/v1/tasks',
  },
  {
    name: 'get_task',
    scope: 'tasks:read',
    description: 'Get a WeldFlow task by ID, including all fields (description, tags, dependencies, custom fields).',
    inputSchema: {
      taskId: z.string().describe('The task ID'),
    },
    method: 'GET',
    path: '/v1/tasks/:id',
    pathParams: { id: 'taskId' },
  },
  {
    name: 'create_task',
    scope: 'tasks:write',
    description: 'Create a new WeldFlow task. Can be standalone or linked to a project, parent task, sprint, or CRM customer/contact.',
    inputSchema: createTaskSchema.shape,
    method: 'POST',
    path: '/v1/tasks',
  },
  {
    name: 'update_task',
    scope: 'tasks:write',
    description: 'Update an existing WeldFlow task. Any subset of fields can be updated; unspecified fields are left unchanged.',
    inputSchema: {
      taskId: z.string().describe('The task ID to update'),
      ...updateTaskSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/tasks/:id',
    pathParams: { id: 'taskId' },
  },
  {
    name: 'delete_task',
    scope: 'tasks:write',
    description: 'Soft-delete a WeldFlow task by ID.',
    inputSchema: {
      taskId: z.string().describe('The task ID'),
    },
    method: 'DELETE',
    path: '/v1/tasks/:id',
    pathParams: { id: 'taskId' },
  },

  // ── Task Comments ─────────────────────────────────────────────────────────
  {
    name: 'search_task_comments',
    scope: 'task_comments:read',
    description: 'List/search task comments. Cursor-paginated; filter by task or search content.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
      search: z.string().optional().describe('Match against comment content'),
      taskId: z.string().optional().describe('Filter by task ID'),
    },
    method: 'GET',
    path: '/v1/task-comments',
  },
  {
    name: 'get_task_comment',
    scope: 'task_comments:read',
    description: 'Get full details of a task comment by ID.',
    inputSchema: {
      id: z.string().describe('The task comment ID'),
    },
    method: 'GET',
    path: '/v1/task-comments/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_task_comment',
    scope: 'task_comments:write',
    description: 'Create a new task comment.',
    inputSchema: createTaskCommentSchema.shape,
    method: 'POST',
    path: '/v1/task-comments',
  },
  {
    name: 'update_task_comment',
    scope: 'task_comments:write',
    description: 'Update an existing task comment by ID.',
    inputSchema: {
      id: z.string().describe('The task comment ID'),
      ...updateTaskCommentSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/task-comments/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_task_comment',
    scope: 'task_comments:write',
    description: 'Soft-delete a task comment by ID.',
    inputSchema: {
      id: z.string().describe('The task comment ID'),
    },
    method: 'DELETE',
    path: '/v1/task-comments/:id',
    pathParams: { id: 'id' },
  },

  // ── Task Tags ─────────────────────────────────────────────────────────────
  {
    name: 'search_task_tags',
    scope: 'task_tags:read',
    description: 'List/search task tags. Cursor-paginated; filter by name or owner.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
      search: z.string().optional().describe('Match against tag name'),
      userId: z.string().optional().describe('Filter by owner user ID'),
    },
    method: 'GET',
    path: '/v1/task-tags',
  },
  {
    name: 'get_task_tag',
    scope: 'task_tags:read',
    description: 'Get full details of a task tag by ID.',
    inputSchema: {
      id: z.string().describe('The task tag ID'),
    },
    method: 'GET',
    path: '/v1/task-tags/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_task_tag',
    scope: 'task_tags:write',
    description: 'Create a new task tag.',
    inputSchema: createTaskTagSchema.shape,
    method: 'POST',
    path: '/v1/task-tags',
  },
  {
    name: 'update_task_tag',
    scope: 'task_tags:write',
    description: 'Update an existing task tag by ID.',
    inputSchema: {
      id: z.string().describe('The task tag ID'),
      ...updateTaskTagSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/task-tags/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_task_tag',
    scope: 'task_tags:write',
    description: 'Soft-delete a task tag by ID.',
    inputSchema: {
      id: z.string().describe('The task tag ID'),
    },
    method: 'DELETE',
    path: '/v1/task-tags/:id',
    pathParams: { id: 'id' },
  },

  // ── Sprints ───────────────────────────────────────────────────────────────
  {
    name: 'search_sprints',
    scope: 'sprints:read',
    description: 'List/search sprints. Cursor-paginated; filter by project or status.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
      search: z.string().optional().describe('Match against sprint name'),
      projectId: z.string().optional().describe('Filter by project ID'),
      status: z.string().optional().describe('Filter by sprint status (planned, active, completed, cancelled)'),
    },
    method: 'GET',
    path: '/v1/sprints',
  },
  {
    name: 'get_sprint',
    scope: 'sprints:read',
    description: 'Get full details of a sprint by ID.',
    inputSchema: {
      id: z.string().describe('The sprint ID'),
    },
    method: 'GET',
    path: '/v1/sprints/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_sprint',
    scope: 'sprints:write',
    description: 'Create a new sprint.',
    inputSchema: createSprintSchema.shape,
    method: 'POST',
    path: '/v1/sprints',
  },
  {
    name: 'update_sprint',
    scope: 'sprints:write',
    description: 'Update an existing sprint by ID.',
    inputSchema: {
      id: z.string().describe('The sprint ID'),
      ...updateSprintSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/sprints/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_sprint',
    scope: 'sprints:write',
    description: 'Soft-delete a sprint by ID.',
    inputSchema: {
      id: z.string().describe('The sprint ID'),
    },
    method: 'DELETE',
    path: '/v1/sprints/:id',
    pathParams: { id: 'id' },
  },

  // ── Milestones ────────────────────────────────────────────────────────────
  {
    name: 'search_milestones',
    scope: 'milestones:read',
    description: 'List/search milestones. Cursor-paginated; filter by project or status.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
      search: z.string().optional().describe('Match against milestone name'),
      projectId: z.string().optional().describe('Filter by project ID'),
      status: z.string().optional().describe('Filter by milestone status (pending, in_progress, completed, missed, postponed)'),
    },
    method: 'GET',
    path: '/v1/milestones',
  },
  {
    name: 'get_milestone',
    scope: 'milestones:read',
    description: 'Get full details of a milestone by ID.',
    inputSchema: {
      id: z.string().describe('The milestone ID'),
    },
    method: 'GET',
    path: '/v1/milestones/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_milestone',
    scope: 'milestones:write',
    description: 'Create a new project milestone.',
    inputSchema: createMilestoneSchema.shape,
    method: 'POST',
    path: '/v1/milestones',
  },
  {
    name: 'update_milestone',
    scope: 'milestones:write',
    description: 'Update an existing milestone by ID.',
    inputSchema: {
      id: z.string().describe('The milestone ID'),
      ...updateMilestoneSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/milestones/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_milestone',
    scope: 'milestones:write',
    description: 'Soft-delete a milestone by ID.',
    inputSchema: {
      id: z.string().describe('The milestone ID'),
    },
    method: 'DELETE',
    path: '/v1/milestones/:id',
    pathParams: { id: 'id' },
  },

  // ── Goals ─────────────────────────────────────────────────────────────────
  {
    name: 'search_goals',
    scope: 'goals:read',
    description: 'List/search project goals. Cursor-paginated; filter by project.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
      projectId: z.string().optional().describe('Filter by project ID'),
    },
    method: 'GET',
    path: '/v1/goals',
  },
  {
    name: 'get_goal',
    scope: 'goals:read',
    description: 'Get full details of a project goal by ID.',
    inputSchema: {
      id: z.string().describe('The goal ID'),
    },
    method: 'GET',
    path: '/v1/goals/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_goal',
    scope: 'goals:write',
    description: 'Create a new project goal.',
    inputSchema: createGoalSchema.shape,
    method: 'POST',
    path: '/v1/goals',
  },
  {
    name: 'update_goal',
    scope: 'goals:write',
    description: 'Update an existing project goal by ID.',
    inputSchema: {
      id: z.string().describe('The goal ID'),
      ...updateGoalSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/goals/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_goal',
    scope: 'goals:write',
    description: 'Soft-delete a project goal by ID.',
    inputSchema: {
      id: z.string().describe('The goal ID'),
    },
    method: 'DELETE',
    path: '/v1/goals/:id',
    pathParams: { id: 'id' },
  },
];
