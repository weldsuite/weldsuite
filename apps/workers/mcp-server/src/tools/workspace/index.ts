import { z } from 'zod';
import {
  createCalendarSchema,
  updateCalendarSchema,
} from '../../schemas/calendars';
import {
  createCalendarEventSchema,
  updateCalendarEventSchema,
} from '../../schemas/calendar-events';
import {
  createFileSchema,
  updateFileSchema,
} from '../../schemas/files';
import {
  createFolderSchema,
  updateFolderSchema,
} from '../../schemas/folders';
import {
  createWorkflowSchema,
  updateWorkflowSchema,
  listWorkflowsQuery,
} from '../../schemas/weldconnect';
import type { ToolDefinition } from '../registry';

export const workspaceTools: ToolDefinition[] = [
  // ============================================================================
  // Calendars
  // ============================================================================
  {
    name: 'search_calendars',
    scope: 'calendars:read',
    description: 'List/search calendars. Cursor-paginated; filter by owner.',
    inputSchema: {
      search: z.string().optional().describe('Match against calendar name'),
      ownerId: z.string().optional().describe('Filter by owner ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/calendars',
  },
  {
    name: 'get_calendar',
    scope: 'calendars:read',
    description: 'Get full details of a calendar by ID.',
    inputSchema: {
      id: z.string().describe('The calendar ID'),
    },
    method: 'GET',
    path: '/v1/calendars/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_calendar',
    scope: 'calendars:write',
    description: 'Create a new calendar.',
    inputSchema: createCalendarSchema.shape,
    method: 'POST',
    path: '/v1/calendars',
  },
  {
    name: 'update_calendar',
    scope: 'calendars:write',
    description: 'Update an existing calendar by ID.',
    inputSchema: {
      id: z.string().describe('The calendar ID'),
      ...updateCalendarSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/calendars/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_calendar',
    scope: 'calendars:write',
    description: 'Soft-delete a calendar by ID.',
    inputSchema: {
      id: z.string().describe('The calendar ID'),
    },
    method: 'DELETE',
    path: '/v1/calendars/:id',
    pathParams: { id: 'id' },
  },

  // ============================================================================
  // Calendar Events
  // ============================================================================
  {
    name: 'search_calendar_events',
    scope: 'calendar_events:read',
    description: 'List/search calendar events. Cursor-paginated; filter by calendar.',
    inputSchema: {
      search: z.string().optional().describe('Match against event title'),
      calendarId: z.string().optional().describe('Filter by calendar ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/calendar-events',
  },
  {
    name: 'get_calendar_event',
    scope: 'calendar_events:read',
    description: 'Get full details of a calendar event by ID.',
    inputSchema: {
      id: z.string().describe('The calendar event ID'),
    },
    method: 'GET',
    path: '/v1/calendar-events/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_calendar_event',
    scope: 'calendar_events:write',
    description: 'Create a new calendar event.',
    inputSchema: createCalendarEventSchema.shape,
    method: 'POST',
    path: '/v1/calendar-events',
  },
  {
    name: 'update_calendar_event',
    scope: 'calendar_events:write',
    description: 'Update an existing calendar event by ID.',
    inputSchema: {
      id: z.string().describe('The calendar event ID'),
      ...updateCalendarEventSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/calendar-events/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_calendar_event',
    scope: 'calendar_events:write',
    description: 'Soft-delete a calendar event by ID.',
    inputSchema: {
      id: z.string().describe('The calendar event ID'),
    },
    method: 'DELETE',
    path: '/v1/calendar-events/:id',
    pathParams: { id: 'id' },
  },

  // ============================================================================
  // Files
  // ============================================================================
  {
    name: 'search_files',
    scope: 'files:read',
    description: 'List/search files. Filter by name, type, or folder.',
    inputSchema: {
      search: z.string().optional().describe('Match against file name'),
      type: z.string().optional().describe('Filter by file type (e.g. image, pdf, document)'),
      folderId: z.string().optional().describe('Filter by folder ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/files',
  },
  {
    name: 'get_file',
    scope: 'files:read',
    description: 'Get full metadata of a file by ID.',
    inputSchema: {
      id: z.string().describe('The file ID'),
    },
    method: 'GET',
    path: '/v1/files/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_file',
    scope: 'files:write',
    description: 'Create a new file metadata record.',
    inputSchema: createFileSchema.shape,
    method: 'POST',
    path: '/v1/files',
  },
  {
    name: 'update_file',
    scope: 'files:write',
    description: 'Update an existing file record by ID.',
    inputSchema: {
      id: z.string().describe('The file ID'),
      ...updateFileSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/files/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_file',
    scope: 'files:write',
    description: 'Soft-delete a file by ID.',
    inputSchema: {
      id: z.string().describe('The file ID'),
    },
    method: 'DELETE',
    path: '/v1/files/:id',
    pathParams: { id: 'id' },
  },

  // ============================================================================
  // Folders
  // ============================================================================
  {
    name: 'search_folders',
    scope: 'folders:read',
    description: 'List/search folders. Filter by parent folder.',
    inputSchema: {
      parentId: z.string().optional().describe('Filter by parent folder ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/folders',
  },
  {
    name: 'get_folder',
    scope: 'folders:read',
    description: 'Get full details of a folder by ID.',
    inputSchema: {
      id: z.string().describe('The folder ID'),
    },
    method: 'GET',
    path: '/v1/folders/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_folder',
    scope: 'folders:write',
    description: 'Create a new folder.',
    inputSchema: createFolderSchema.shape,
    method: 'POST',
    path: '/v1/folders',
  },
  {
    name: 'update_folder',
    scope: 'folders:write',
    description: 'Update an existing folder by ID.',
    inputSchema: {
      id: z.string().describe('The folder ID'),
      ...updateFolderSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/folders/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_folder',
    scope: 'folders:write',
    description: 'Soft-delete a folder by ID.',
    inputSchema: {
      id: z.string().describe('The folder ID'),
    },
    method: 'DELETE',
    path: '/v1/folders/:id',
    pathParams: { id: 'id' },
  },

  // ============================================================================
  // Drive (read-only aggregation)
  // ============================================================================
  {
    name: 'get_drive_all',
    scope: 'drive:read',
    description: 'Paginated list of all non-deleted files in the drive (metadata only). Filter by name, type, or folder.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.coerce.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
      search: z.string().optional().describe('Match against file name'),
      type: z.string().optional().describe('Filter by file type (e.g. image, pdf, document)'),
      folderId: z.string().optional().describe('Filter by folder ID'),
    },
    method: 'GET',
    path: '/v1/drive/all',
  },
  {
    name: 'get_drive_stats',
    scope: 'drive:read',
    description: 'Get drive statistics: per-fileType counts, total file count, and total folder count.',
    inputSchema: {},
    method: 'GET',
    path: '/v1/drive/stats',
  },

  // ============================================================================
  // Settings (read-only)
  // ============================================================================
  {
    name: 'get_settings',
    scope: 'settings:read',
    description: 'Get the workspace-level settings (appearance, localization, business info, branding, notifications).',
    inputSchema: {},
    method: 'GET',
    path: '/v1/settings/workspace',
  },
  {
    name: 'get_settings_members',
    scope: 'settings:read',
    description: 'List workspace members. Cursor-paginated.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/settings/members',
  },
  {
    name: 'get_settings_member',
    scope: 'settings:read',
    description: 'Get a single workspace member by ID.',
    inputSchema: {
      id: z.string().describe('The workspace member ID'),
    },
    method: 'GET',
    path: '/v1/settings/members/:id',
    pathParams: { id: 'id' },
  },

  // ============================================================================
  // Webhooks
  // ============================================================================
  {
    name: 'search_webhooks',
    scope: 'webhooks:read',
    description: 'List/search workflow webhooks. Filter by workflowId or enabled status.',
    inputSchema: {
      workflowId: z.string().optional().describe('Filter by workflow ID'),
      isEnabled: z.boolean().optional().describe('Filter by enabled status'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/webhooks',
  },
  {
    name: 'get_webhook',
    scope: 'webhooks:read',
    description: 'Get full details of a workflow webhook by ID.',
    inputSchema: {
      id: z.string().describe('The webhook ID'),
    },
    method: 'GET',
    path: '/v1/webhooks/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_webhook',
    scope: 'webhooks:write',
    description: 'Create a new workflow webhook.',
    inputSchema: {
      name: z.string().min(1).max(255),
      description: z.string().optional(),
      // workflowId is NOT NULL in workflow_webhooks — require it so we never write
      // a placeholder row that can't be linked to a real workflow.
      workflowId: z.string().min(1),
      url: z.string().url(),
      isEnabled: z.boolean().optional(),
      allowedMethods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).optional(),
      headers: z.record(z.string()).optional(),
    },
    method: 'POST',
    path: '/v1/webhooks',
  },
  {
    name: 'update_webhook',
    scope: 'webhooks:write',
    description: 'Update an existing workflow webhook by ID.',
    inputSchema: {
      id: z.string().describe('The webhook ID'),
      name: z.string().min(1).max(255).optional(),
      description: z.string().optional(),
      workflowId: z.string().optional(),
      url: z.string().url().optional(),
      isEnabled: z.boolean().optional(),
      allowedMethods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).optional(),
      headers: z.record(z.string()).optional(),
    },
    method: 'PATCH',
    path: '/v1/webhooks/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_webhook',
    scope: 'webhooks:write',
    description: 'Soft-delete a workflow webhook by ID.',
    inputSchema: {
      id: z.string().describe('The webhook ID'),
    },
    method: 'DELETE',
    path: '/v1/webhooks/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'get_webhook_events',
    scope: 'webhooks:read',
    description: 'List all subscribable entity events that can trigger a webhook (dotted form: entity.action).',
    inputSchema: {},
    method: 'GET',
    path: '/v1/webhooks/events',
  },

  // ============================================================================
  // Workflows
  // ============================================================================
  {
    name: 'search_workflows',
    scope: 'workflows:read',
    description: 'List/search workflows. Cursor-paginated; filter by status or folder.',
    inputSchema: listWorkflowsQuery.shape,
    method: 'GET',
    path: '/v1/workflows',
  },
  {
    name: 'get_workflow',
    scope: 'workflows:read',
    description: 'Get full details of a workflow by ID.',
    inputSchema: {
      id: z.string().describe('The workflow ID'),
    },
    method: 'GET',
    path: '/v1/workflows/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_workflow',
    scope: 'workflows:write',
    description: 'Create a new workflow.',
    inputSchema: createWorkflowSchema.shape,
    method: 'POST',
    path: '/v1/workflows',
  },
  {
    name: 'update_workflow',
    scope: 'workflows:write',
    description: 'Update an existing workflow by ID.',
    inputSchema: {
      id: z.string().describe('The workflow ID'),
      ...updateWorkflowSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/workflows/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_workflow',
    scope: 'workflows:write',
    description: 'Soft-delete a workflow by ID.',
    inputSchema: {
      id: z.string().describe('The workflow ID'),
    },
    method: 'DELETE',
    path: '/v1/workflows/:id',
    pathParams: { id: 'id' },
  },
];
