/**
 * WeldHost domain tools and time-entry tools. They shared a file with the
 * WeldCommerce product and order tools until those were removed (2026-11-20);
 * the registry keeps them in the same place in the tool order.
 */
import { z } from 'zod';
import { createDomainSchema, updateDomainSchema, listDomainsQuery } from '../../schemas/domains';
import type { ToolDefinition } from '../registry';

// Inline schemas mirroring apps/workers/external-api/src/routes/v1/time-entries/index.ts
const createTimeEntrySchema = z
  .object({
    projectId: z.string().optional(),
    taskId: z.string().optional(),
    userId: z.string().optional(),
    date: z.string(),
    duration: z.union([z.string(), z.number()]),
    description: z.string().optional(),
    activity: z.string().optional(),
    billable: z.boolean().default(true),
    rate: z.union([z.string(), z.number()]).optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    location: z.string().optional(),
    isRemote: z.boolean().default(false),
  })
  .passthrough();

const updateTimeEntrySchema = createTimeEntrySchema.partial();

export const hostAndTimeEntryTools: ToolDefinition[] = [
  // ---- Domains ---------------------------------------------------------------
  {
    name: 'search_domains',
    scope: 'domains:read',
    description: 'List/search WeldHost domains. Cursor-paginated; filter by status or search full domain/name.',
    inputSchema: listDomainsQuery.shape,
    method: 'GET',
    path: '/v1/domains',
  },
  {
    name: 'get_domain',
    scope: 'domains:read',
    description: 'Get full details of a WeldHost domain.',
    inputSchema: {
      id: z.string().describe('The domain — its name, or the id from an earlier search'),
    },
    method: 'GET',
    path: '/v1/domains/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_domain',
    scope: 'domains:write',
    description: 'Create a new WeldHost domain.',
    inputSchema: createDomainSchema.shape,
    method: 'POST',
    path: '/v1/domains',
  },
  {
    name: 'update_domain',
    scope: 'domains:write',
    description: 'Update an existing WeldHost domain.',
    inputSchema: {
      id: z.string().describe('The domain — its name, or the id from an earlier search'),
      ...updateDomainSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/domains/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_domain',
    scope: 'domains:write',
    description: 'Delete a WeldHost domain.',
    inputSchema: {
      id: z.string().describe('The domain — its name, or the id from an earlier search'),
    },
    method: 'DELETE',
    path: '/v1/domains/:id',
    pathParams: { id: 'id' },
  },

  // ---- Time Entries ----------------------------------------------------------
  {
    name: 'search_time_entries',
    scope: 'time_entries:read',
    description: 'List/search time entries. Cursor-paginated; filter by project, task, user, status, billable, and date range.',
    inputSchema: {
      projectId: z.string().optional().describe('Filter by project ID'),
      taskId: z.string().optional().describe('Filter by task ID'),
      userId: z.string().optional().describe('Filter by user ID'),
      status: z.string().optional().describe('Filter by status (draft, submitted, approved, rejected, billed)'),
      billable: z.coerce.boolean().optional().describe('Filter by billable flag'),
      fromDate: z.string().optional().describe('Filter entries on or after this date (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('Filter entries on or before this date (YYYY-MM-DD)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.coerce.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
    },
    method: 'GET',
    path: '/v1/time-entries',
  },
  {
    name: 'get_time_entry',
    scope: 'time_entries:read',
    description: 'Get full details of a time entry.',
    inputSchema: {
      id: z.string().describe('The time entry — its name, or the id from an earlier search'),
    },
    method: 'GET',
    path: '/v1/time-entries/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_time_entry',
    scope: 'time_entries:write',
    description: 'Create a new time entry. userId defaults to the authenticated API user when omitted.',
    inputSchema: createTimeEntrySchema.shape,
    method: 'POST',
    path: '/v1/time-entries',
  },
  {
    name: 'update_time_entry',
    scope: 'time_entries:write',
    description: 'Update an existing time entry.',
    inputSchema: {
      id: z.string().describe('The time entry — its name, or the id from an earlier search'),
      ...updateTimeEntrySchema.shape,
    },
    method: 'PATCH',
    path: '/v1/time-entries/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_time_entry',
    scope: 'time_entries:write',
    description: 'Delete a time entry.',
    inputSchema: {
      id: z.string().describe('The time entry — its name, or the id from an earlier search'),
    },
    method: 'DELETE',
    path: '/v1/time-entries/:id',
    pathParams: { id: 'id' },
  },
];
