import { z } from 'zod';
import {
  createKnowledgeSpaceSchema,
  updateKnowledgeSpaceSchema,
  createKnowledgePageSchema,
  updateKnowledgePageSchema,
  moveKnowledgePageSchema,
} from '../../schemas/knowledge';
import type { ToolDefinition } from '../registry';

export const knowledgeTools: ToolDefinition[] = [
  // ---- Spaces -------------------------------------------------------------

  {
    name: 'list_knowledge_spaces',
    scope: 'knowledge:read',
    description:
      'List the knowledge-base (WeldKnow wiki) spaces in the workspace. Spaces are the top-level sections that contain nested pages.',
    inputSchema: {},
    method: 'GET',
    path: '/v1/knowledge-spaces',
  },

  {
    name: 'create_knowledge_space',
    scope: 'knowledge:write',
    description: 'Create a new knowledge-base space (a top-level wiki section that holds pages).',
    inputSchema: createKnowledgeSpaceSchema.shape,
    method: 'POST',
    path: '/v1/knowledge-spaces',
  },

  {
    name: 'update_knowledge_space',
    scope: 'knowledge:write',
    description: 'Update a knowledge-base space (name, description, icon, visibility, sort order).',
    inputSchema: {
      id: z.string().describe('The space ID'),
      ...updateKnowledgeSpaceSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/knowledge-spaces/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_knowledge_space',
    scope: 'knowledge:write',
    description: 'Soft-delete a knowledge-base space and all pages inside it (recoverable from trash).',
    inputSchema: {
      id: z.string().describe('The space ID'),
    },
    method: 'DELETE',
    path: '/v1/knowledge-spaces/:id',
    pathParams: { id: 'id' },
  },

  // ---- Pages --------------------------------------------------------------

  {
    name: 'get_knowledge_page_tree',
    scope: 'knowledge:read',
    description:
      'Get the page hierarchy of the knowledge base as a flat list (id, spaceId, parentId, position, title, icon). Rebuild the tree from parentId; children sort by position. Use this first to understand the existing wiki structure.',
    inputSchema: {
      spaceId: z.string().optional().describe('Limit to one space'),
    },
    method: 'GET',
    path: '/v1/knowledge-pages/tree',
  },

  {
    name: 'search_knowledge_pages',
    scope: 'knowledge:read',
    description: 'Search knowledge-base pages by title or body text. Cursor-paginated.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.coerce.number().min(1).max(200).optional().describe('Page size (1-200)'),
      search: z.string().optional().describe('Search text (matches title and page content)'),
      spaceId: z.string().optional().describe('Filter by space ID'),
      parentId: z.string().optional().describe('Filter by parent page ID (direct children only)'),
    },
    method: 'GET',
    path: '/v1/knowledge-pages',
  },

  {
    name: 'get_knowledge_page',
    scope: 'knowledge:read',
    description:
      'Get a knowledge-base page by ID, including its full content (BlockNote block JSON in contentJson, plain text in contentText).',
    inputSchema: {
      id: z.string().describe('The page ID'),
    },
    method: 'GET',
    path: '/v1/knowledge-pages/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'create_knowledge_page',
    scope: 'knowledge:write',
    description:
      'Create a knowledge-base page. Write the body in the `content` field as plain text / light markdown (# headings, - bullets, 1. numbered lists); it is converted to rich-text blocks automatically. Nest under a parent page via parentId.',
    inputSchema: createKnowledgePageSchema.shape,
    method: 'POST',
    path: '/v1/knowledge-pages',
  },

  {
    name: 'update_knowledge_page',
    scope: 'knowledge:write',
    description:
      'Update a knowledge-base page. Setting `content` REPLACES the whole page body (plain text / light markdown). Can also rename, set icon/cover, or lock/unlock.',
    inputSchema: {
      id: z.string().describe('The page ID'),
      ...updateKnowledgePageSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/knowledge-pages/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'move_knowledge_page',
    scope: 'knowledge:write',
    description:
      'Move a knowledge-base page to a new parent, position, or space. The whole subtree moves along; moving a page under its own descendant is rejected.',
    inputSchema: {
      id: z.string().describe('The page ID to move'),
      ...moveKnowledgePageSchema.shape,
    },
    method: 'POST',
    path: '/v1/knowledge-pages/:id/move',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_knowledge_page',
    scope: 'knowledge:write',
    description: 'Soft-delete a knowledge-base page and all its sub-pages (recoverable from trash in the platform).',
    inputSchema: {
      id: z.string().describe('The page ID'),
    },
    method: 'DELETE',
    path: '/v1/knowledge-pages/:id',
    pathParams: { id: 'id' },
  },
];
