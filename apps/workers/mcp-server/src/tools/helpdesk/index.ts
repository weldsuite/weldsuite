import { z } from 'zod';
import {
  createTicketSchema,
  updateTicketSchema,
  listTicketsQuery,
} from '../../schemas/tickets';
import {
  createArticleSchema,
  updateArticleSchema,
} from '../../schemas/articles';
import {
  createConversationSchema,
  updateConversationSchema,
} from '../../schemas/conversations';
import type { ToolDefinition } from '../registry';

export const helpdeskTools: ToolDefinition[] = [
  // ---- Tickets ----------------------------------------------------------------

  {
    name: 'search_tickets',
    scope: 'tickets:read',
    description: 'Search helpdesk support tickets by subject, status, priority, or assignee.',
    inputSchema: listTicketsQuery.shape,
    method: 'GET',
    path: '/v1/tickets',
  },

  {
    name: 'get_ticket',
    scope: 'tickets:read',
    description: 'Get full details of a specific helpdesk ticket by ID, including metadata and SLA information.',
    inputSchema: {
      ticketId: z.string().describe('The ticket ID'),
    },
    method: 'GET',
    path: '/v1/tickets/:id',
    pathParams: { id: 'ticketId' },
  },

  {
    name: 'create_ticket',
    scope: 'tickets:write',
    description: 'Create a new helpdesk support ticket.',
    inputSchema: createTicketSchema.shape,
    method: 'POST',
    path: '/v1/tickets',
  },

  {
    name: 'update_ticket_status',
    scope: 'tickets:write',
    description: 'Update the status, priority, or assignment of a helpdesk ticket.',
    inputSchema: {
      ticketId: z.string().describe('The ticket ID to update'),
      ...updateTicketSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/tickets/:id',
    pathParams: { id: 'ticketId' },
  },

  {
    name: 'add_ticket_reply',
    scope: 'tickets:write',
    description: 'Add a reply or internal note to a helpdesk ticket conversation.',
    inputSchema: {
      ticketId: z.string().describe('The ticket ID to reply to'),
      body: z.string().describe('The message body (plain text or HTML)'),
      type: z.enum(['reply', 'note']).default('reply').optional().describe('Message type: reply (visible to customer) or note (internal only)'),
      authorName: z.string().describe('Name of the message author'),
      authorEmail: z.string().email().describe('Email address of the message author'),
      authorId: z.string().optional().describe('ID of the message author'),
    },
    method: 'POST',
    path: '/v1/tickets/:id/messages',
    pathParams: { id: 'ticketId' },
  },

  {
    name: 'update_ticket',
    scope: 'tickets:write',
    description: 'Update an existing helpdesk ticket by ID (general PATCH — any field).',
    inputSchema: {
      ticketId: z.string().describe('The ticket ID'),
      ...updateTicketSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/tickets/:id',
    pathParams: { id: 'ticketId' },
  },

  {
    name: 'delete_ticket',
    scope: 'tickets:write',
    description: 'Soft-delete a helpdesk ticket by ID.',
    inputSchema: {
      ticketId: z.string().describe('The ticket ID'),
    },
    method: 'DELETE',
    path: '/v1/tickets/:id',
    pathParams: { id: 'ticketId' },
  },

  // ---- Articles ---------------------------------------------------------------

  {
    name: 'search_articles',
    scope: 'articles:read',
    description: 'Search knowledge base articles by title or content.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.coerce.number().min(1).max(200).optional().describe('Page size (1-200)'),
      search: z.string().optional().describe('Search text (matches title, excerpt, content)'),
      status: z.string().optional().describe('Filter by article status (published, draft, review, archived, outdated)'),
      authorId: z.string().optional().describe('Filter by author ID'),
    },
    method: 'GET',
    path: '/v1/articles',
  },

  {
    name: 'get_article',
    scope: 'articles:read',
    description: 'Get full details of a knowledge-base article by ID.',
    inputSchema: {
      id: z.string().describe('The article ID'),
    },
    method: 'GET',
    path: '/v1/articles/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'create_article',
    scope: 'articles:write',
    description: 'Create a new knowledge-base article.',
    inputSchema: createArticleSchema.shape,
    method: 'POST',
    path: '/v1/articles',
  },

  {
    name: 'update_article',
    scope: 'articles:write',
    description: 'Update an existing knowledge-base article by ID.',
    inputSchema: {
      id: z.string().describe('The article ID'),
      ...updateArticleSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/articles/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_article',
    scope: 'articles:write',
    description: 'Soft-delete a knowledge-base article by ID.',
    inputSchema: {
      id: z.string().describe('The article ID'),
    },
    method: 'DELETE',
    path: '/v1/articles/:id',
    pathParams: { id: 'id' },
  },

  // ---- Conversations ----------------------------------------------------------

  {
    name: 'search_conversations',
    scope: 'conversations:read',
    description: 'List/search helpdesk conversations. Cursor-paginated; filter by status, assignee, or department.',
    inputSchema: {
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.coerce.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
      search: z.string().optional().describe('Match against subject, customer email, or customer name'),
      status: z.string().optional().describe('Filter by conversation status'),
      assigneeId: z.string().optional().describe('Filter by assignee ID'),
      departmentId: z.string().optional().describe('Filter by department ID'),
    },
    method: 'GET',
    path: '/v1/conversations',
  },

  {
    name: 'get_conversation',
    scope: 'conversations:read',
    description: 'Get full details of a helpdesk conversation by ID.',
    inputSchema: {
      id: z.string().describe('The conversation ID'),
    },
    method: 'GET',
    path: '/v1/conversations/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'create_conversation',
    scope: 'conversations:write',
    description: 'Create a new helpdesk conversation.',
    inputSchema: createConversationSchema.shape,
    method: 'POST',
    path: '/v1/conversations',
  },

  {
    name: 'update_conversation',
    scope: 'conversations:write',
    description: 'Update an existing helpdesk conversation by ID.',
    inputSchema: {
      id: z.string().describe('The conversation ID'),
      ...updateConversationSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/conversations/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_conversation',
    scope: 'conversations:write',
    description: 'Soft-delete a helpdesk conversation by ID.',
    inputSchema: {
      id: z.string().describe('The conversation ID'),
    },
    method: 'DELETE',
    path: '/v1/conversations/:id',
    pathParams: { id: 'id' },
  },
];
