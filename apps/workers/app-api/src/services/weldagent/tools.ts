/**
 * WeldAgent platform tool registry.
 *
 * Each tool wraps in-process tenant DB / service calls (not external-api).
 * Tools declare `requiredPermissions`; the executor only registers tools whose
 * requirements are covered by the agent's grant list.
 */

import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { hasPermission } from '@weldsuite/permissions';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import { listPeople, createPerson, getPerson } from '../people';
import type { Variables } from '../../types';

export type AgentDb = Variables['tenantDb'];

export interface ToolContext {
  db: AgentDb;
  /** Agent principal id (for audit / ownership attribution). */
  agentId: string;
  /** Human who triggered the run (chat user or event actor). */
  actorUserId: string;
  workspaceId: string;
}

export interface PlatformToolDefinition {
  id: string;
  name: string;
  description: string;
  requiredPermissions: string[];
  parameters: z.ZodTypeAny;
  execute: (ctx: ToolContext, args: unknown) => Promise<unknown>;
}

function agentHasGrants(agentPermissions: string[], required: string[]): boolean {
  return required.every((req) => hasPermission(agentPermissions, req));
}

const listPeopleParams = z.object({
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const getPersonParams = z.object({
  id: z.string().min(1).max(30),
});

const createPersonParams = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().email().optional(),
  title: z.string().max(100).optional(),
  mobilePhone: z.string().max(50).optional(),
});

const listTicketsParams = z.object({
  search: z.string().max(200).optional(),
  status: z.string().max(30).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const createTicketParams = z.object({
  subject: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  customerName: z.string().min(1).max(255),
  customerEmail: z.string().email(),
  priority: z.enum(['low', 'medium', 'high', 'urgent', 'critical']).optional(),
  status: z.enum(['new', 'open', 'pending', 'on_hold', 'in_progress', 'resolved', 'closed']).optional(),
});

const listTasksParams = z.object({
  search: z.string().max(200).optional(),
  status: z.string().max(30).optional(),
  projectId: z.string().max(30).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const createTaskParams = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  projectId: z.string().max(30).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  status: z.string().max(30).optional(),
});

export const PLATFORM_TOOLS: PlatformToolDefinition[] = [
  {
    id: 'people.list',
    name: 'list_people',
    description: 'Search or list people (CRM contacts) in the workspace.',
    requiredPermissions: ['people:read'],
    parameters: listPeopleParams,
    async execute(ctx, raw) {
      const args = listPeopleParams.parse(raw);
      const result = await listPeople(ctx.db, {
        search: args.search,
        limit: args.limit ?? 20,
      });
      return {
        totalCount: result.totalCount,
        people: result.data.map((p) => ({
          id: p.id,
          fullName: p.fullName,
          email: p.email,
          title: p.title,
          status: p.status,
        })),
      };
    },
  },
  {
    id: 'people.get',
    name: 'get_person',
    description: 'Get a single person by id.',
    requiredPermissions: ['people:read'],
    parameters: getPersonParams,
    async execute(ctx, raw) {
      const args = getPersonParams.parse(raw);
      const person = await getPerson(ctx.db, args.id);
      if (!person) return { error: 'Person not found' };
      return {
        id: person.id,
        fullName: person.fullName,
        email: person.email,
        title: person.title,
        mobilePhone: person.mobilePhone,
        status: person.status,
      };
    },
  },
  {
    id: 'people.create',
    name: 'create_person',
    description: 'Create a new person (CRM contact) in the workspace.',
    requiredPermissions: ['people:create'],
    parameters: createPersonParams,
    async execute(ctx, raw) {
      const args = createPersonParams.parse(raw);
      const person = await createPerson(ctx.db, {
        ...args,
        ownerId: ctx.actorUserId,
        inCrm: true,
      });
      return {
        id: person.id,
        fullName: person.fullName,
        email: person.email,
      };
    },
  },
  {
    id: 'tickets.list',
    name: 'list_tickets',
    description: 'List helpdesk tickets, optionally filtered by status or search.',
    requiredPermissions: ['tickets:read'],
    parameters: listTicketsParams,
    async execute(ctx, raw) {
      const args = listTicketsParams.parse(raw);
      const { helpdeskTickets: t } = schema;
      const limit = args.limit ?? 20;
      const conditions = [isNull(t.deletedAt)];
      if (args.status) conditions.push(eq(t.status, args.status));
      if (args.search) {
        const q = `%${args.search}%`;
        conditions.push(
          or(ilike(t.subject, q), ilike(t.customerName, q), ilike(t.customerEmail, q))!,
        );
      }
      const rows = await ctx.db
        .select({
          id: t.id,
          ticketNumber: t.ticketNumber,
          subject: t.subject,
          status: t.status,
          priority: t.priority,
          customerName: t.customerName,
          customerEmail: t.customerEmail,
        })
        .from(t)
        .where(and(...conditions))
        .orderBy(desc(t.createdAt))
        .limit(limit);
      return { tickets: rows };
    },
  },
  {
    id: 'tickets.create',
    name: 'create_ticket',
    description: 'Create a new helpdesk ticket.',
    requiredPermissions: ['tickets:create'],
    parameters: createTicketParams,
    async execute(ctx, raw) {
      const args = createTicketParams.parse(raw);
      const { helpdeskTickets: t } = schema;
      const id = generateId('tkt');
      const now = new Date();
      const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await ctx.db.insert(t).values({
        id,
        ticketNumber,
        subject: args.subject,
        description: args.description ?? null,
        customerName: args.customerName,
        customerEmail: args.customerEmail,
        status: args.status ?? 'new',
        priority: args.priority ?? 'medium',
        category: 'general_inquiry',
        channel: 'api',
        type: 'question',
        createdAt: now,
        updatedAt: now,
      });
      return { id, ticketNumber, subject: args.subject, status: args.status ?? 'new' };
    },
  },
  {
    id: 'tasks.list',
    name: 'list_tasks',
    description: 'List project tasks, optionally filtered by status, project, or search.',
    requiredPermissions: ['tasks:read'],
    parameters: listTasksParams,
    async execute(ctx, raw) {
      const args = listTasksParams.parse(raw);
      const { tasks: t } = schema;
      const limit = args.limit ?? 20;
      const conditions = [isNull(t.deletedAt)];
      if (args.status) conditions.push(eq(t.status, args.status));
      if (args.projectId) conditions.push(eq(t.projectId, args.projectId));
      if (args.search) conditions.push(ilike(t.title, `%${args.search}%`));
      const rows = await ctx.db
        .select({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          projectId: t.projectId,
          dueDate: t.dueDate,
        })
        .from(t)
        .where(and(...conditions))
        .orderBy(desc(t.createdAt))
        .limit(limit);
      return { tasks: rows };
    },
  },
  {
    id: 'tasks.create',
    name: 'create_task',
    description: 'Create a new project/personal task.',
    requiredPermissions: ['tasks:create'],
    parameters: createTaskParams,
    async execute(ctx, raw) {
      const args = createTaskParams.parse(raw);
      const { tasks: t } = schema;
      const id = generateId('task');
      const now = new Date();
      const [{ next }] = await ctx.db
        .select({
          next: sql<number>`coalesce(max(${t.number}), 0) + 1`,
        })
        .from(t);
      await ctx.db.insert(t).values({
        id,
        number: next ?? 1,
        title: args.title,
        description: args.description ?? null,
        projectId: args.projectId ?? null,
        status: args.status ?? 'todo',
        priority: args.priority ?? 'medium',
        type: 'task',
        reporterId: ctx.actorUserId,
        position: 0,
        createdAt: now,
        updatedAt: now,
      });
      return { id, title: args.title, status: args.status ?? 'todo' };
    },
  },
];

export function listToolCatalog(): Array<{
  id: string;
  name: string;
  description: string;
  requiredPermissions: string[];
}> {
  return PLATFORM_TOOLS.map(({ id, name, description, requiredPermissions }) => ({
    id,
    name,
    description,
    requiredPermissions,
  }));
}

/**
 * Filter the registry to tools the agent may use given its grants and optional
 * explicit enabledTools allow-list.
 */
export function resolveAgentTools(
  agentPermissions: string[],
  enabledTools: string[] = [],
): PlatformToolDefinition[] {
  return PLATFORM_TOOLS.filter((tool) => {
    if (enabledTools.length > 0 && !enabledTools.includes(tool.id)) return false;
    return agentHasGrants(agentPermissions, tool.requiredPermissions);
  });
}

export { agentHasGrants };
