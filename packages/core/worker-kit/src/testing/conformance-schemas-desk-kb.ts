/** WeldDesk (desk-api) response schemas: knowledge base: articles, article folders, ticket types, canned responses, changelog, stats. Spread into ROUTES by conformance-schemas.ts. */
import { helpdeskArticleFolderSchema } from '@weldsuite/core-api-client/schemas/article-folders';
import { helpdeskArticleSchema } from '@weldsuite/core-api-client/schemas/articles';
import {
  cannedResponseCategorySchema,
  cannedResponseUseResultSchema,
  helpdeskCannedResponseSchema,
} from '@weldsuite/core-api-client/schemas/canned-responses';
import { deskIdRefSchema } from '@weldsuite/core-api-client/schemas/desk-common';
import { helpdeskChangelogEntrySchema } from '@weldsuite/core-api-client/schemas/helpdesk-changelog';
import { helpdeskStatsSchema } from '@weldsuite/core-api-client/schemas/helpdesk-stats';
import { helpdeskTicketTypeSchema } from '@weldsuite/core-api-client/schemas/ticket-types';
import type { RouteSchema } from './conformance-schemas';

export const DESK_KB_ROUTES: RouteSchema[] = [
  // desk: articles
  { method: 'GET', route: '/api/articles', envelope: 'list', data: helpdeskArticleSchema },
  { method: 'GET', route: '/api/articles/:id', envelope: 'single', data: helpdeskArticleSchema },
  { method: 'POST', route: '/api/articles', envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: '/api/articles/:id', envelope: 'single', data: deskIdRefSchema },
  // desk: article folders
  { method: 'GET', route: '/api/article-folders', envelope: 'list', data: helpdeskArticleFolderSchema },
  { method: 'GET', route: '/api/article-folders/:id', envelope: 'single', data: helpdeskArticleFolderSchema },
  { method: 'POST', route: '/api/article-folders', envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: '/api/article-folders/:id', envelope: 'single', data: deskIdRefSchema },
  // desk: ticket types
  { method: 'GET', route: '/api/ticket-types', envelope: 'list', data: helpdeskTicketTypeSchema },
  { method: 'GET', route: '/api/ticket-types/:id', envelope: 'single', data: helpdeskTicketTypeSchema },
  { method: 'POST', route: '/api/ticket-types', envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: '/api/ticket-types/:id', envelope: 'single', data: deskIdRefSchema },
  // desk: canned responses
  { method: 'GET', route: '/api/canned-responses', envelope: 'list', data: helpdeskCannedResponseSchema },
  { method: 'GET', route: '/api/canned-responses/search', envelope: 'array', data: helpdeskCannedResponseSchema },
  { method: 'GET', route: '/api/canned-responses/categories', envelope: 'array', data: cannedResponseCategorySchema },
  { method: 'GET', route: '/api/canned-responses/:id', envelope: 'single', data: helpdeskCannedResponseSchema },
  { method: 'POST', route: '/api/canned-responses', envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: '/api/canned-responses/:id', envelope: 'single', data: deskIdRefSchema },
  { method: 'POST', route: '/api/canned-responses/:id/use', envelope: 'single', data: cannedResponseUseResultSchema },
  // desk: changelog (offset mode adds `page`, `pageSize`, `totalPages` to the pagination)
  { method: 'GET', route: '/api/helpdesk-changelog', envelope: 'list', data: helpdeskChangelogEntrySchema },
  // desk: stats
  { method: 'GET', route: '/api/helpdesk-stats', envelope: 'single', data: helpdeskStatsSchema },
];
