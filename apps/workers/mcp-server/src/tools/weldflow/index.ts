import { z } from 'zod';
import {
  createProjectDocumentSchema,
  updateProjectDocumentSchema,
} from '../../schemas/project-documents';
import {
  createProjectFileSchema,
  updateProjectFileSchema,
} from '../../schemas/project-files';
import {
  createProjectLabelSchema,
  updateProjectLabelSchema,
} from '../../schemas/project-labels';
import {
  createProjectMemberSchema,
  updateProjectMemberSchema,
} from '../../schemas/project-members';
import {
  createProjectMessageSchema,
  updateProjectMessageSchema,
} from '../../schemas/project-messages';
import {
  createWhiteboardSchema,
  updateWhiteboardSchema,
} from '../../schemas/whiteboards';
import type { ToolDefinition } from '../registry';

export const weldflowTools: ToolDefinition[] = [
  // ── project-documents ──────────────────────────────────────────────────────

  {
    name: 'search_project_documents',
    scope: 'project_documents:read',
    description: 'List/search project documents. Cursor-paginated; filter by project or parent document.',
    inputSchema: {
      search: z.string().optional().describe('Match against document title'),
      projectId: z.string().optional().describe('Filter by project ID'),
      parentId: z.string().optional().describe('Filter by parent document ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/project-documents',
  },

  {
    name: 'get_project_document',
    scope: 'project_documents:read',
    description: 'Get full details of a project document by ID.',
    inputSchema: {
      id: z.string().describe('The project document ID'),
    },
    method: 'GET',
    path: '/v1/project-documents/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'create_project_document',
    scope: 'project_documents:write',
    description: 'Create a new project document.',
    inputSchema: createProjectDocumentSchema.shape,
    method: 'POST',
    path: '/v1/project-documents',
  },

  {
    name: 'update_project_document',
    scope: 'project_documents:write',
    description: 'Update an existing project document by ID.',
    inputSchema: {
      id: z.string().describe('The project document ID'),
      ...updateProjectDocumentSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/project-documents/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_project_document',
    scope: 'project_documents:write',
    description: 'Soft-delete a project document by ID.',
    inputSchema: {
      id: z.string().describe('The project document ID'),
    },
    method: 'DELETE',
    path: '/v1/project-documents/:id',
    pathParams: { id: 'id' },
  },

  // ── project-files ──────────────────────────────────────────────────────────

  {
    name: 'search_project_files',
    scope: 'project_files:read',
    description: 'List/search project files. Cursor-paginated; filter by project or file type.',
    inputSchema: {
      search: z.string().optional().describe('Match against file name'),
      projectId: z.string().optional().describe('Filter by project ID'),
      fileType: z.string().optional().describe('Filter by file type'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/project-files',
  },

  {
    name: 'get_project_file',
    scope: 'project_files:read',
    description: 'Get full details of a project file by ID.',
    inputSchema: {
      id: z.string().describe('The project file ID'),
    },
    method: 'GET',
    path: '/v1/project-files/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'create_project_file',
    scope: 'project_files:write',
    description: 'Create a new project file record.',
    inputSchema: createProjectFileSchema.shape,
    method: 'POST',
    path: '/v1/project-files',
  },

  {
    name: 'update_project_file',
    scope: 'project_files:write',
    description: 'Update an existing project file by ID.',
    inputSchema: {
      id: z.string().describe('The project file ID'),
      ...updateProjectFileSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/project-files/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_project_file',
    scope: 'project_files:write',
    description: 'Soft-delete a project file by ID.',
    inputSchema: {
      id: z.string().describe('The project file ID'),
    },
    method: 'DELETE',
    path: '/v1/project-files/:id',
    pathParams: { id: 'id' },
  },

  // ── project-labels ─────────────────────────────────────────────────────────

  {
    name: 'search_project_labels',
    scope: 'project_labels:read',
    description: 'List/search project labels. Cursor-paginated; filter by project.',
    inputSchema: {
      search: z.string().optional().describe('Match against label name'),
      projectId: z.string().optional().describe('Filter by project ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/project-labels',
  },

  {
    name: 'get_project_label',
    scope: 'project_labels:read',
    description: 'Get full details of a project label by ID.',
    inputSchema: {
      id: z.string().describe('The project label ID'),
    },
    method: 'GET',
    path: '/v1/project-labels/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'create_project_label',
    scope: 'project_labels:write',
    description: 'Create a new project label.',
    inputSchema: createProjectLabelSchema.shape,
    method: 'POST',
    path: '/v1/project-labels',
  },

  {
    name: 'update_project_label',
    scope: 'project_labels:write',
    description: 'Update an existing project label by ID.',
    inputSchema: {
      id: z.string().describe('The project label ID'),
      ...updateProjectLabelSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/project-labels/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_project_label',
    scope: 'project_labels:write',
    description: 'Soft-delete a project label by ID.',
    inputSchema: {
      id: z.string().describe('The project label ID'),
    },
    method: 'DELETE',
    path: '/v1/project-labels/:id',
    pathParams: { id: 'id' },
  },

  // ── project-members ────────────────────────────────────────────────────────

  {
    name: 'search_project_members',
    scope: 'project_members:read',
    description: 'List/search project members. Cursor-paginated; filter by project, user, or role.',
    inputSchema: {
      projectId: z.string().optional().describe('Filter by project ID'),
      userId: z.string().optional().describe('Filter by user ID'),
      role: z.string().optional().describe('Filter by member role'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/project-members',
  },

  {
    name: 'get_project_member',
    scope: 'project_members:read',
    description: 'Get full details of a project member by ID.',
    inputSchema: {
      id: z.string().describe('The project member ID'),
    },
    method: 'GET',
    path: '/v1/project-members/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'create_project_member',
    scope: 'project_members:write',
    description: 'Add a member to a project.',
    inputSchema: createProjectMemberSchema.shape,
    method: 'POST',
    path: '/v1/project-members',
  },

  {
    name: 'update_project_member',
    scope: 'project_members:write',
    description: 'Update an existing project member by ID.',
    inputSchema: {
      id: z.string().describe('The project member ID'),
      ...updateProjectMemberSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/project-members/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_project_member',
    scope: 'project_members:write',
    description: 'Soft-delete (remove) a project member by ID.',
    inputSchema: {
      id: z.string().describe('The project member ID'),
    },
    method: 'DELETE',
    path: '/v1/project-members/:id',
    pathParams: { id: 'id' },
  },

  // ── project-messages ───────────────────────────────────────────────────────

  {
    name: 'search_project_messages',
    scope: 'project_messages:read',
    description: 'List/search project messages. Cursor-paginated; filter by project.',
    inputSchema: {
      search: z.string().optional().describe('Match against message body'),
      projectId: z.string().optional().describe('Filter by project ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/project-messages',
  },

  {
    name: 'get_project_message',
    scope: 'project_messages:read',
    description: 'Get full details of a project message by ID.',
    inputSchema: {
      id: z.string().describe('The project message ID'),
    },
    method: 'GET',
    path: '/v1/project-messages/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'create_project_message',
    scope: 'project_messages:write',
    description: 'Create a new project message.',
    inputSchema: createProjectMessageSchema.shape,
    method: 'POST',
    path: '/v1/project-messages',
  },

  {
    name: 'update_project_message',
    scope: 'project_messages:write',
    description: 'Update an existing project message by ID.',
    inputSchema: {
      id: z.string().describe('The project message ID'),
      ...updateProjectMessageSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/project-messages/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_project_message',
    scope: 'project_messages:write',
    description: 'Soft-delete a project message by ID.',
    inputSchema: {
      id: z.string().describe('The project message ID'),
    },
    method: 'DELETE',
    path: '/v1/project-messages/:id',
    pathParams: { id: 'id' },
  },

  // ── project-sheets (read-only) ─────────────────────────────────────────────

  {
    name: 'search_project_sheets',
    scope: 'project_sheets:read',
    description: 'List project spreadsheet files (sheets). Cursor-paginated; optionally filter by project ID.',
    inputSchema: {
      projectId: z.string().optional().describe('Filter by project ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/project-sheets',
  },

  // ── whiteboards ────────────────────────────────────────────────────────────

  {
    name: 'search_whiteboards',
    scope: 'whiteboards:read',
    description: 'List/search project whiteboards. Cursor-paginated; filter by project.',
    inputSchema: {
      search: z.string().optional().describe('Match against whiteboard name'),
      projectId: z.string().optional().describe('Filter by project ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/whiteboards',
  },

  {
    name: 'get_whiteboard',
    scope: 'whiteboards:read',
    description: 'Get full details of a project whiteboard by ID.',
    inputSchema: {
      id: z.string().describe('The whiteboard ID'),
    },
    method: 'GET',
    path: '/v1/whiteboards/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'create_whiteboard',
    scope: 'whiteboards:write',
    description: 'Create a new project whiteboard.',
    inputSchema: createWhiteboardSchema.shape,
    method: 'POST',
    path: '/v1/whiteboards',
  },

  {
    name: 'update_whiteboard',
    scope: 'whiteboards:write',
    description: 'Update an existing project whiteboard by ID.',
    inputSchema: {
      id: z.string().describe('The whiteboard ID'),
      ...updateWhiteboardSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/whiteboards/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_whiteboard',
    scope: 'whiteboards:write',
    description: 'Soft-delete a project whiteboard by ID.',
    inputSchema: {
      id: z.string().describe('The whiteboard ID'),
    },
    method: 'DELETE',
    path: '/v1/whiteboards/:id',
    pathParams: { id: 'id' },
  },
];
