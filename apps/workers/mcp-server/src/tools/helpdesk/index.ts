import { z } from 'zod';
import { createTicketSchema } from '../../schemas/tickets';
import {
  createArticleSchema,
  updateArticleSchema,
} from '../../schemas/articles';
import {
  addDeskConversationMessageSchema,
  listConversationsQuerySchema,
  openDeskConversationSchema,
  updateDeskConversationShape,
} from '../../schemas/conversations';
import type { ToolDefinition } from '../registry';

/**
 * WeldDesk works in one inbox of conversations. A support ticket from here
 * opens one of those (`create_ticket` is kept for the name people ask for);
 * reading, answering, closing and assigning all go through the conversation
 * tools. The older `helpdesk_tickets` list has no screen, so no tool writes it.
 */
export const helpdeskTools: ToolDefinition[] = [
  // ---- Tickets ----------------------------------------------------------------

  {
    name: 'create_ticket',
    scope: 'tickets:write',
    description:
      'Open a support ticket: it becomes a conversation in the WeldDesk inbox, where the team picks it up. ' +
      'Pass externalId (e.g. an alert or order id) so a repeat lands on the same conversation instead of a new one. ' +
      'Follow up with the conversation tools (search_conversations, add_conversation_message, update_conversation).',
    inputSchema: {
      ...createTicketSchema.shape,
      externalId: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe('Your own key for what this is about; the same key adds to the same conversation'),
    },
    method: 'POST',
    path: '/v1/tickets',
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
    description: 'Get full details of a knowledge-base article.',
    inputSchema: {
      id: z.string().describe('The article — its name, or the id from an earlier search'),
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
    description: 'Update an existing knowledge-base article.',
    inputSchema: {
      id: z.string().describe('The article — its name, or the id from an earlier search'),
      ...updateArticleSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/articles/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'delete_article',
    scope: 'articles:write',
    description: 'Delete a knowledge-base article.',
    inputSchema: {
      id: z.string().describe('The article — its name, or the id from an earlier search'),
    },
    method: 'DELETE',
    path: '/v1/articles/:id',
    pathParams: { id: 'id' },
  },

  // ---- Conversations ----------------------------------------------------------

  {
    name: 'search_conversations',
    scope: 'conversations:read',
    description:
      'Search the WeldDesk inbox: support conversations and tickets from chat, email, phone and integrations. ' +
      'Filter by state, assignee, channel or customer email; q searches text and numbers (#42).',
    inputSchema: listConversationsQuerySchema.shape,
    method: 'GET',
    path: '/v1/conversations',
  },

  {
    name: 'get_conversation',
    scope: 'conversations:read',
    description: 'Get a WeldDesk inbox conversation, optionally with its whole timeline (messages, notes, events).',
    inputSchema: {
      id: z.string().describe('The conversation — its subject or number, or the id from an earlier search'),
      include: z.enum(['messages']).optional().describe('messages: include the timeline'),
    },
    method: 'GET',
    path: '/v1/conversations/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'create_conversation',
    scope: 'conversations:write',
    description:
      'Open a conversation in the WeldDesk inbox for the team to handle (an alert, a request, a ticket). ' +
      'Pass externalId so a repeat of the same alert adds to that conversation instead of opening another.',
    inputSchema: openDeskConversationSchema.shape,
    method: 'POST',
    path: '/v1/conversations',
  },

  {
    name: 'update_conversation',
    scope: 'conversations:write',
    description: 'Close or reopen a WeldDesk inbox conversation, or assign it to a teammate (null unassigns).',
    inputSchema: {
      id: z.string().describe('The conversation — its subject or number, or the id from an earlier search'),
      ...updateDeskConversationShape,
    },
    method: 'PATCH',
    path: '/v1/conversations/:id',
    pathParams: { id: 'id' },
  },

  {
    name: 'add_conversation_message',
    scope: 'conversations:write',
    description:
      'Add an internal note to a WeldDesk inbox conversation, or reply to the customer (kind=message). ' +
      'Replies work on API and chat conversations; email and phone replies are sent from the inbox.',
    inputSchema: {
      id: z.string().describe('The conversation — its subject or number, or the id from an earlier search'),
      ...addDeskConversationMessageSchema.shape,
    },
    method: 'POST',
    path: '/v1/conversations/:id/messages',
    pathParams: { id: 'id' },
    // A reply reaches the customer: never land it on a near-match by name.
    exactId: true,
  },
];
