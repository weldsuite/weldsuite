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
  /** When running inside a WeldChat room reply. */
  channelId?: string;
  env?: import('../../types').Env;
  agentHop?: number;
  maxAgentHops?: number;
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

const messageAgentParams = z.object({
  agentId: z.string().min(1).max(30),
  message: z.string().min(1).max(4000),
});

const createAgentGroupChatParams = z.object({
  name: z.string().min(1).max(255),
  agentIds: z.array(z.string().min(1).max(30)).min(1).max(20),
  openingMessage: z.string().min(1).max(4000).optional(),
  replyPolicy: z.enum(['mentions', 'always', 'none']).optional(),
});

const computerExecParams = z.object({
  command: z.string().min(1).max(8000).describe('Shell command to run in the workspace computer'),
  cwd: z.string().max(500).optional().describe('Working directory under /workspace'),
});

const computerPathParams = z.object({
  path: z.string().min(1).max(500).describe('Absolute path under /workspace or relative path'),
});

const computerWriteParams = computerPathParams.extend({
  content: z.string().max(500_000),
});

const computerCodeParams = z.object({
  code: z.string().min(1).max(100_000),
  language: z.enum(['python', 'javascript']).optional(),
});

const browserOpenParams = z.object({
  url: z.string().url().max(2000),
});

const browserActParams = z.object({
  action: z.enum(['goto', 'click', 'type', 'press', 'wait', 'screenshot', 'extract', 'live_view']),
  url: z.string().url().max(2000).optional(),
  selector: z.string().max(500).optional(),
  text: z.string().max(5000).optional(),
  key: z.string().max(50).optional(),
  waitMs: z.number().int().min(0).max(30_000).optional(),
});

const saveAgentSetupParams = z.object({
  name: z
    .string()
    .min(2)
    .max(80)
    .describe('Short display name for this agent based on its purpose (e.g. "Lead Qualifier", "Support Digest").'),
  systemPrompt: z
    .string()
    .min(20)
    .max(10000)
    .describe('Lasting instructions: purpose, when to act, and what steps to take.'),
  description: z.string().max(500).optional().describe('Short one-line summary of what this agent does.'),
  activate: z
    .boolean()
    .optional()
    .describe(
      'Set true ONLY if the user explicitly asked to activate / go live. Otherwise omit or set false (stay draft).',
    ),
});

export const PLATFORM_TOOLS: PlatformToolDefinition[] = [
  {
    id: 'agent.save_setup',
    name: 'save_agent_setup',
    description:
      'Save purpose + routines + display name AFTER interviewing the user. ' +
      'Do not call this after only a preset click — you must have clarified routines first. ' +
      'Never claim you are active unless activate=true and the user asked for that.',
    requiredPermissions: [],
    parameters: saveAgentSetupParams,
    async execute(ctx, raw) {
      const args = saveAgentSetupParams.parse(raw);
      const { updateAgent, getAgent } = await import('./agents');
      const { extractEventSubscriptions } = await import('./subscriptions');

      const existing = await getAgent(ctx.db, ctx.agentId);
      if (!existing) return { error: 'Agent not found' };

      const prompt = args.systemPrompt.trim();
      // Lightweight guard: lasting instructions must mention when/how the agent acts.
      const mentionsRoutine =
        /\b(when|whenever|schedule|daily|weekly|ticket|contact|order|chat|trigger|routine|event|listen)\b/i.test(
          prompt,
        );
      if (!mentionsRoutine) {
        return {
          error:
            'systemPrompt is missing routines (when to act). Ask the user about triggers/routines, then try again.',
        };
      }

      const eventSubscriptions = extractEventSubscriptions(prompt);
      const nextName = args.name.trim();
      const updated = await updateAgent(ctx.db, ctx.agentId, {
        name: nextName,
        systemPrompt: prompt,
        description: args.description?.trim() || existing.description,
        eventSubscriptions,
        ...(args.activate ? { status: 'active' as const } : { status: 'draft' as const }),
      });
      if (!updated) return { error: 'Failed to save agent setup' };

      return {
        ok: true,
        agentId: updated.id,
        name: updated.name,
        status: updated.status,
        description: updated.description,
        eventSubscriptions: updated.eventSubscriptions,
        hint: args.activate
          ? 'Setup saved and activated. Confirm briefly with the user.'
          : 'Setup saved as draft. Confirm briefly; ask if they want you activated.',
      };
    },
  },
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
  {
    id: 'chat.message_agent',
    name: 'message_agent',
    description:
      'Mention another workspace agent in the current WeldChat room so they can reply. Requires an active channel context.',
    requiredPermissions: [],
    parameters: messageAgentParams,
    async execute(ctx, raw) {
      const args = messageAgentParams.parse(raw);
      if (!ctx.channelId) {
        return { error: 'No active channel — this tool only works inside a WeldChat room reply.' };
      }
      if (!args.agentId.startsWith('agt_')) {
        return { error: 'agentId must be a workspace agent id (agt_…)' };
      }
      if (args.agentId === ctx.agentId) {
        return { error: 'Cannot message yourself' };
      }
      const hop = (ctx.agentHop ?? 0) + 1;
      const maxHops = ctx.maxAgentHops ?? 2;
      if (hop > maxHops) {
        return { error: `Agent hop limit reached (${maxHops})` };
      }

      const { chatChannelMembers, weldagentAgents } = schema;
      const [membership] = await ctx.db
        .select({ id: chatChannelMembers.id })
        .from(chatChannelMembers)
        .where(
          and(
            eq(chatChannelMembers.channelId, ctx.channelId),
            eq(chatChannelMembers.userId, args.agentId),
            eq(chatChannelMembers.memberType, 'agent'),
          ),
        )
        .limit(1);
      if (!membership) {
        return { error: 'Target agent is not a member of this channel' };
      }

      const [target] = await ctx.db
        .select({ id: weldagentAgents.id, name: weldagentAgents.name, status: weldagentAgents.status })
        .from(weldagentAgents)
        .where(and(eq(weldagentAgents.id, args.agentId), isNull(weldagentAgents.deletedAt)))
        .limit(1);
      if (!target || target.status !== 'active') {
        return { error: 'Target agent not found or not active' };
      }

      // Return a mention token the model should include; actual dispatch happens
      // when the reply is posted and scanned for <@agt_…> mentions.
      return {
        ok: true,
        mentionToken: `<@${args.agentId}>`,
        agentName: target.name,
        hint: `Include ${`<@${args.agentId}>`} in your reply text to ping ${target.name}. Message draft: ${args.message}`,
        draft: args.message,
      };
    },
  },
  {
    id: 'chat.create_agent_group',
    name: 'create_agent_group_chat',
    description:
      'Create a private WeldChat room with the current agent, other agents, and the human who invoked this run.',
    requiredPermissions: [],
    parameters: createAgentGroupChatParams,
    async execute(ctx, raw) {
      const args = createAgentGroupChatParams.parse(raw);
      if (!ctx.env) {
        return { error: 'Chat environment unavailable' };
      }

      const agentIds = Array.from(new Set([ctx.agentId, ...args.agentIds]));
      const { weldagentAgents } = schema;
      const active = await ctx.db
        .select({ id: weldagentAgents.id, name: weldagentAgents.name })
        .from(weldagentAgents)
        .where(and(eq(weldagentAgents.status, 'active'), isNull(weldagentAgents.deletedAt)));
      const activeIds = new Set(active.map((a) => a.id));
      const missing = agentIds.filter((id) => !activeIds.has(id));
      if (missing.length > 0) {
        return { error: `Unknown or inactive agent(s): ${missing.join(', ')}` };
      }

      const { createChannel } = await import('../chat/create-channel');
      const { addChannelMembers } = await import('../chat/channel-members');
      const { mergeAgentRoomPolicy } = await import('../chat/agent-room-policy');
      const { postAgentChatMessage } = await import('../chat/post-agent-message');
      const { dispatchAgentRoomReplies } = await import('../chat/agent-mention-dispatch');

      const { channel } = await createChannel(ctx.db, ctx.actorUserId, {
        name: args.name,
        type: 'private',
        memberIds: [ctx.actorUserId],
        metadata: mergeAgentRoomPolicy(null, {
          agentReplyPolicy: args.replyPolicy ?? 'mentions',
          agentMaxHops: 2,
        }),
      });

      const addResult = await addChannelMembers(ctx.db, {
        channelId: channel.id,
        userIds: agentIds,
        memberType: 'agent',
      });
      if (!addResult.ok) {
        return { error: addResult.message };
      }

      const self = active.find((a) => a.id === ctx.agentId);
      let openingMessageId: string | null = null;
      if (args.openingMessage?.trim()) {
        const posted = await postAgentChatMessage(
          {
            db: ctx.db,
            env: ctx.env,
            orgId: ctx.workspaceId,
            channelId: channel.id,
            agentId: ctx.agentId,
            agentName: self?.name ?? 'Agent',
            invokerUserId: ctx.actorUserId,
          },
          {
            content: args.openingMessage.trim(),
            hop: 0,
          },
        );
        openingMessageId = posted.id;

        const mentioned = args.agentIds.filter((id) => id !== ctx.agentId);
        if (mentioned.length > 0) {
          await dispatchAgentRoomReplies(
            {
              db: ctx.db,
              env: ctx.env,
              orgId: ctx.workspaceId,
              invokerUserId: ctx.actorUserId,
            },
            {
              channelId: channel.id,
              messageId: posted.id,
              messageContent: args.openingMessage.trim(),
              authorId: ctx.agentId,
              authorType: 'agent',
              authorName: self?.name ?? 'Agent',
              mentionedAgentIds: mentioned,
              hop: 1,
              maxHops: 2,
              replyPolicy: args.replyPolicy ?? 'mentions',
            },
          );
        }
      }

      return {
        ok: true,
        channelId: channel.id,
        channelName: channel.name,
        agentMemberCount: addResult.addedCount,
        openingMessageId,
      };
    },
  },
  {
    id: 'computer.exec',
    name: 'computer_exec',
    description:
      'Run a shell command on the workspace cloud computer (Linux sandbox). Prefer platform tools for CRM/tickets; use this for scripts, files, and general compute.',
    requiredPermissions: ['computer:use'],
    parameters: computerExecParams,
    async execute(ctx, raw) {
      if (!ctx.env) return { error: 'Computer runtime unavailable' };
      const args = computerExecParams.parse(raw);
      const { computerExec } = await import('./computer-client');
      return computerExec(ctx.env, {
        workspaceId: ctx.workspaceId,
        command: args.command,
        cwd: args.cwd,
      });
    },
  },
  {
    id: 'computer.read_file',
    name: 'computer_read_file',
    description: 'Read a file from the workspace cloud computer under /workspace.',
    requiredPermissions: ['computer:use'],
    parameters: computerPathParams,
    async execute(ctx, raw) {
      if (!ctx.env) return { error: 'Computer runtime unavailable' };
      const args = computerPathParams.parse(raw);
      const { computerReadFile } = await import('./computer-client');
      return computerReadFile(ctx.env, { workspaceId: ctx.workspaceId, path: args.path });
    },
  },
  {
    id: 'computer.write_file',
    name: 'computer_write_file',
    description: 'Write a file on the workspace cloud computer under /workspace.',
    requiredPermissions: ['computer:use'],
    parameters: computerWriteParams,
    async execute(ctx, raw) {
      if (!ctx.env) return { error: 'Computer runtime unavailable' };
      const args = computerWriteParams.parse(raw);
      const { computerWriteFile } = await import('./computer-client');
      return computerWriteFile(ctx.env, {
        workspaceId: ctx.workspaceId,
        path: args.path,
        content: args.content,
      });
    },
  },
  {
    id: 'computer.list_files',
    name: 'computer_list_files',
    description: 'List files in a directory on the workspace cloud computer.',
    requiredPermissions: ['computer:use'],
    parameters: computerPathParams,
    async execute(ctx, raw) {
      if (!ctx.env) return { error: 'Computer runtime unavailable' };
      const args = computerPathParams.parse(raw);
      const { computerListFiles } = await import('./computer-client');
      return computerListFiles(ctx.env, { workspaceId: ctx.workspaceId, path: args.path });
    },
  },
  {
    id: 'computer.run_code',
    name: 'computer_run_code',
    description: 'Run Python or JavaScript on the workspace cloud computer.',
    requiredPermissions: ['computer:use'],
    parameters: computerCodeParams,
    async execute(ctx, raw) {
      if (!ctx.env) return { error: 'Computer runtime unavailable' };
      const args = computerCodeParams.parse(raw);
      const { computerRunCode } = await import('./computer-client');
      return computerRunCode(ctx.env, {
        workspaceId: ctx.workspaceId,
        code: args.code,
        language: args.language,
      });
    },
  },
  {
    id: 'browser.open',
    name: 'browser_open',
    description:
      'Open a URL in the cloud browser for this agent. Returns title, text extract, screenshot, and optional Live View URL. Prefer connectors/platform tools when available.',
    requiredPermissions: ['browser:use'],
    parameters: browserOpenParams,
    async execute(ctx, raw) {
      if (!ctx.env) return { error: 'Browser runtime unavailable' };
      const args = browserOpenParams.parse(raw);
      const { browserOpen } = await import('./computer-client');
      return browserOpen(ctx.env, {
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        url: args.url,
      });
    },
  },
  {
    id: 'browser.act',
    name: 'browser_act',
    description:
      'Continue a cloud browser session: goto, click, type, press, wait, screenshot, extract, or live_view.',
    requiredPermissions: ['browser:use'],
    parameters: browserActParams,
    async execute(ctx, raw) {
      if (!ctx.env) return { error: 'Browser runtime unavailable' };
      const args = browserActParams.parse(raw);
      const { browserAct } = await import('./computer-client');
      return browserAct(ctx.env, {
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        ...args,
      });
    },
  },
  {
    id: 'browser.close',
    name: 'browser_close',
    description: 'Close this agent’s cloud browser session.',
    requiredPermissions: ['browser:use'],
    parameters: z.object({}),
    async execute(ctx) {
      if (!ctx.env) return { error: 'Browser runtime unavailable' };
      const { browserClose } = await import('./computer-client');
      return browserClose(ctx.env, {
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
      });
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
 * `agent.save_setup` is always available so unfinished agents can finish onboarding.
 */
export function resolveAgentTools(
  agentPermissions: string[],
  enabledTools: string[] = [],
): PlatformToolDefinition[] {
  return PLATFORM_TOOLS.filter((tool) => {
    if (tool.id === 'agent.save_setup') return true;
    if (enabledTools.length > 0 && !enabledTools.includes(tool.id)) return false;
    return agentHasGrants(agentPermissions, tool.requiredPermissions);
  });
}

export { agentHasGrants };
