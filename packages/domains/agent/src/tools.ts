/**
 * WeldAgent platform tool registry.
 *
 * Each tool wraps in-process tenant DB / service calls (not external-api).
 * Tools declare `requiredPermissions`; the executor only registers tools whose
 * requirements are covered by the agent's grant list.
 */

import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, lt, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { hasAppPermission, hasPermission } from '@weldsuite/permissions';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { publishEntityEventRaw, type EntityType } from '@weldsuite/entity-events';
import { listPeople, createPerson, getPerson, isValidWorkspaceMember } from '@weldsuite/crm-domain/people';
import { allocateTaskNumber } from '@weldsuite/flow-domain/task-numbering';
import { getWorkspaceTimezone } from '@weldsuite/flow-domain/day-boundaries';
import { ASK_USER_TOOL_NAME, agentQuestionSchema } from '@weldsuite/app-api-client/schemas/weldagent-questions';
import { reindexAgentRoutines, routineIndexSync } from './routine-index';
import { SHEET_TOOLS } from './sheets-tools';
import { PROJECT_TOOLS } from './projects-tools';
import {
  CLOSED_TASK_STATUSES,
  accessibleProjectIds,
  dueCutoff,
  memberNames,
  projectNames,
  taskAssigneeIds,
} from './read-helpers';
import {
  extractEventSubscriptions,
  hasExplicitTriggers,
  normalizeExplicitTriggers,
  withExplicitTriggersFlag,
} from './subscriptions';
import type { Database } from '@weldsuite/worker-kit/db';

export type AgentDb = Database;

export interface ToolContext {
  db: AgentDb;
  /** Agent principal id (for audit / ownership attribution). */
  agentId: string;
  /** Human who triggered the run (chat user or event actor). */
  actorUserId: string;
  workspaceId: string;
  /** When running inside a WeldChat room reply. */
  channelId?: string;
  /** When running inside a WeldAgent conversation (chat panel / new-chat). */
  conversationId?: string;
  env?: import('./env').WeldAgentEnv;
  /** The chatting user's IANA timezone; routines default to it. */
  userTimezone?: string | null;
  /** The chatting user's permissions: setup may grant the agent only what they hold. */
  actorPermissions?: string[] | null;
  /**
   * False when the person driving this turn may not change the agent (not its
   * owner or a manager): the setup, routine, skill and memory tools refuse.
   * Unset for unattended runs, which keep maintaining their own agent.
   */
  actorCanEdit?: boolean;
  agentHop?: number;
  maxAgentHops?: number;
  /**
   * Row-level boundary of the person the tools act for. Set where they run on
   * a person's own behalf (the default WeldAgent), so a read tool never shows
   * what that person could not open themselves. Unset for workspace agents,
   * whose grants alone decide.
   */
  rowScope?: ToolRowScope;
}

export interface ToolRowScope {
  userId: string;
  /** Holds `people:scope:all`; otherwise only the people they own are visible. */
  allPeople: boolean;
  /** Holds `projects:scope:all`; otherwise only projects they manage or belong to are visible. */
  allProjects: boolean;
}

/**
 * Tools that change the agent itself. Its routes are owner-only
 * (`canEditAgent`), so a teammate chatting with it gets none of these.
 */
export const AGENT_EDIT_TOOL_IDS: ReadonlySet<string> = new Set([
  'agent.save_setup',
  'agent.save_skill',
  'agent.remember',
  'agent.create_routine',
  'agent.update_routine',
]);

const NOT_EDITOR = { error: "Only this agent's owner can change it." };

export interface PlatformToolDefinition {
  id: string;
  name: string;
  description: string;
  requiredPermissions: string[];
  parameters: z.ZodTypeAny;
  execute: (ctx: ToolContext, args: unknown) => Promise<unknown>;
}

/**
 * Publish the entity event for a record an agent created, so audit logs,
 * workflows, analytics and realtime see it like any other mutation. The
 * `triggeredByAgentId` marker stops agents from re-triggering on it.
 */
async function emitAgentEntityEvent(
  ctx: ToolContext,
  entityType: EntityType,
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!ctx.env) return;
  try {
    await publishEntityEventRaw({
      env: ctx.env as never,
      workspaceId: ctx.workspaceId,
      userId: ctx.actorUserId,
      entityType,
      action: 'created',
      entityId,
      data: { ...data, createdBy: ctx.actorUserId, triggeredByAgentId: ctx.agentId },
    });
  } catch (err) {
    console.warn(`[weldagent/tools] ${entityType}.created event failed:`, err);
  }
}

/** The owner a people read is limited to: the person the tools act for, unless they may see everyone's. */
function peopleOwnerScope(ctx: ToolContext): string | undefined {
  return ctx.rowScope && !ctx.rowScope.allPeople ? ctx.rowScope.userId : undefined;
}

/** A task assigned to `userId`, as its primary assignee or one of several. */
function assignedTo(userId: string): SQL {
  const { tasks: t } = schema;
  return or(eq(t.assigneeId, userId), sql`${t.assigneeIds}::jsonb @> ${JSON.stringify([userId])}::jsonb`)!;
}

/**
 * The row boundary of a task read: without `projects:scope:all`, tasks of the
 * projects the person manages or belongs to, tasks assigned to them (My Tasks
 * shows those whatever the project), and personal tasks they reported.
 * Undefined: no boundary.
 */
async function taskRowScope(ctx: ToolContext): Promise<SQL | undefined> {
  if (!ctx.rowScope || ctx.rowScope.allProjects) return undefined;
  const { tasks: t } = schema;
  const { userId } = ctx.rowScope;
  const projectIds = await accessibleProjectIds(ctx.db, userId);
  const own: SQL[] = [assignedTo(userId), and(isNull(t.projectId), eq(t.reporterId, userId))!];
  if (projectIds.length > 0) own.unshift(inArray(t.projectId, projectIds));
  return or(...own);
}

/** `length` random base36 characters from the Web Crypto RNG. */
function randomBase36(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/**
 * An agent works across apps, so an app-scoped grant counts when ANY app
 * gives it (`weldcrm:people:read` satisfies `people:read`). Agent grants
 * are stored unqualified (the builder offers catalog keys) and are not part of
 * the per-app data rewrite, so a plain match is checked first — it keeps them
 * valid once the unqualified-grant fallback is switched off.
 */
function agentHasGrants(agentPermissions: string[], required: string[]): boolean {
  return required.every(
    (req) =>
      hasPermission(agentPermissions, req) ||
      hasAppPermission({ permissions: agentPermissions }, req, null),
  );
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
  search: z.string().max(200).optional().describe('Part of the task title'),
  status: z.string().max(30).optional().describe('One exact status, such as todo, in_progress or done'),
  projectId: z.string().max(30).optional().describe('Only tasks of this project (id from list_projects)'),
  assignedToMe: z
    .boolean()
    .optional()
    .describe('true: only tasks assigned to the person you are working for ("my tasks")'),
  dueOnOrBefore: z
    .string()
    .max(40)
    .optional()
    .describe(
      'ISO date such as 2026-10-27 (that whole day counts) or a date-time. Finds tasks due then or earlier, ' +
        'so overdue tasks are included. Tasks without a due date are left out.',
    ),
  includeDone: z
    .boolean()
    .optional()
    .describe(
      'false leaves out finished tasks (done or cancelled). Use false for "open", "to do", "due" or "overdue" questions. ' +
        'Omitted: tasks of every status.',
    ),
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
  permissions: z
    .array(z.string().min(3).max(100))
    .max(40)
    .optional()
    .describe(
      'Workspace permissions the job needs, as object:action keys (e.g. "tasks:read", "tickets:read", "people:create"). ' +
        'Only ask for what the instructions use. Ones the user does not hold are skipped.',
    ),
  activate: z
    .boolean()
    .optional()
    .describe(
      'Set true ONLY if the user explicitly asked to activate / go live. Otherwise omit or set false: the agent keeps its current status (a draft stays a draft, an active agent stays active).',
    ),
  triggers: z
    .array(z.string().min(3).max(100))
    .max(20)
    .optional()
    .describe(
      'Events that should start this agent by themselves, as entity.event keys (e.g. "ticket.created", "person.created", "project_task.completed"). ' +
        'Pass ONLY triggers the user explicitly asked for ("when a new ticket arrives, triage it"). ' +
        'For an agent that only works when someone asks it in chat, omit this or pass an empty list. ' +
        'Omitted: no event is guessed from your instructions unless they clearly describe one.',
    ),
});

const updateRoutineParams = z.object({
  routineId: z.string().min(1).max(30),
  name: z.string().min(2).max(255).optional(),
  instructions: z.string().min(10).max(20000).optional(),
  cronExpr: z.string().max(100).optional().describe('Five-field cron, in the routine timezone.'),
  timezone: z.string().max(64).optional().describe('IANA timezone, e.g. "Europe/Amsterdam".'),
  enabled: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
});

/** What save_agent_setup tells the model to confirm, given the status after saving. */
function saveSetupHint(status: string, activated: boolean): string {
  if (status === 'paused') {
    return 'Setup saved; you are still paused. Confirm briefly; they can turn you back on with the Activate button.';
  }
  if (status !== 'active') return 'Setup saved as draft. Confirm briefly; ask if they want you activated.';
  return activated
    ? 'Setup saved and activated. Confirm briefly with the user.'
    : 'Setup saved; you are still active. Confirm briefly with the user.';
}

export const PLATFORM_TOOLS: PlatformToolDefinition[] = [
  {
    id: 'agent.save_setup',
    name: 'save_agent_setup',
    description:
      'Save purpose + routines + display name AFTER interviewing the user. ' +
      'Do not call this after only a preset click — you must have clarified routines first. ' +
      'Never claim you are active unless activate=true and the user asked for that. ' +
      'Only pass triggers the user asked for (events that should start you by themselves); an agent that works when asked in chat has none.',
    requiredPermissions: [],
    parameters: saveAgentSetupParams,
    async execute(ctx, raw) {
      if (ctx.actorCanEdit === false) return NOT_EDITOR;
      const args = saveAgentSetupParams.parse(raw);
      const { updateAgent, getAgent } = await import('./agents');

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

      // What the user asked for beats a reading of the prompt: triggers passed
      // here are used as given (an empty list: chat only), and stay when a
      // later save does not repeat them.
      const explicit = args.triggers ? normalizeExplicitTriggers(args.triggers) : null;
      const eventSubscriptions = explicit
        ? explicit.subscriptions
        : hasExplicitTriggers(existing.enabledTools)
          ? existing.eventSubscriptions
          : extractEventSubscriptions(prompt);
      const nextName = args.name.trim();
      const { splitGrantable } = await import('./grants');
      const { granted, refused } = splitGrantable(args.permissions ?? [], {
        permissions: ctx.actorPermissions ?? [],
      });
      const permissions = [...new Set([...(existing.permissions ?? []), ...granted])];
      const updated = await updateAgent(ctx.db, ctx.agentId, {
        name: nextName,
        systemPrompt: prompt,
        description: args.description?.trim() || existing.description,
        permissions,
        eventSubscriptions,
        ...(explicit ? { enabledTools: withExplicitTriggersFlag(existing.enabledTools) } : {}),
        // Saving only turns an agent on, never off: re-saving the setup of a
        // live agent from its chat must not pause it and stop its routines.
        ...(args.activate ? { status: 'active' as const } : {}),
      });
      if (!updated) return { error: 'Failed to save agent setup' };
      await reindexAgentRoutines(routineIndexSync(ctx.env, ctx.workspaceId), ctx.db, ctx.agentId);

      return {
        ok: true,
        agentId: updated.id,
        name: updated.name,
        status: updated.status,
        description: updated.description,
        eventSubscriptions: updated.eventSubscriptions,
        ...(explicit && explicit.invalid.length > 0
          ? {
              unknownTriggers: explicit.invalid,
              unknownTriggersHint:
                'These triggers are not events WeldSuite knows, so they were not saved. Tell the user and ask what should start you.',
            }
          : {}),
        grantedPermissions: granted,
        ...(refused.length > 0
          ? {
              notGranted: refused,
              notGrantedHint:
                'Tell the user these were not granted (they lack them or they do not exist); an admin can add them under Settings → Access.',
            }
          : {}),
        hint: saveSetupHint(updated.status, Boolean(args.activate)),
      };
    },
  },
  {
    id: 'agent.ask_user',
    name: ASK_USER_TOOL_NAME,
    description:
      'Ask the user ONE multiple-choice question when you need a decision or detail from them. ' +
      'The question is shown as a card with your options; the user can also type their own answer. ' +
      'After calling this, end your turn without further text: their answer arrives as the next user message. ' +
      'Never ask the same question twice, and never use it for questions you can answer yourself.',
    requiredPermissions: [],
    parameters: agentQuestionSchema,
    async execute(_ctx, raw) {
      const question = agentQuestionSchema.parse(raw);
      return {
        ok: true,
        shownToUser: true,
        question: question.question,
        options: question.options.map((option) => option.label),
        hint: 'The question is on screen. End your turn now and wait for the answer.',
      };
    },
  },
  {
    id: 'agent.list_routines',
    name: 'list_routines',
    description: "List this agent's routines with their schedule, timezone, next run and whether they are on.",
    requiredPermissions: [],
    parameters: z.object({}),
    async execute(ctx) {
      const { listRoutines } = await import('./parity');
      const routines = await listRoutines(ctx.db, ctx.agentId);
      return routines.map((r) => ({
        routineId: r.id,
        name: r.name,
        scheduleKind: r.scheduleKind,
        cronExpr: r.cronExpr,
        timezone: r.timezone,
        eventKey: r.eventKey,
        enabled: r.enabled,
        nextRunAt: r.nextRunAt,
      }));
    },
  },
  {
    id: 'agent.update_routine',
    name: 'update_routine',
    description:
      'Change one of this agent\'s routines: rename it, rewrite its instructions, move its schedule or timezone, or turn it on/off. ' +
      'Get the routineId from list_routines.',
    requiredPermissions: [],
    parameters: updateRoutineParams,
    async execute(ctx, raw) {
      if (ctx.actorCanEdit === false) return NOT_EDITOR;
      const { routineId, ...changes } = updateRoutineParams.parse(raw);
      const { getRoutine, updateRoutine, routineScheduleError } = await import('./parity');
      const existing = await getRoutine(ctx.db, routineId);
      if (!existing || existing.agentId !== ctx.agentId) return { error: 'Routine not found for this agent' };
      if (existing.scheduleKind === 'cron' && (changes.cronExpr !== undefined || changes.timezone !== undefined)) {
        const scheduleError = routineScheduleError(
          changes.cronExpr ?? existing.cronExpr,
          changes.timezone ?? existing.timezone,
        );
        if (scheduleError) return { error: scheduleError };
      }
      const updated = await updateRoutine(ctx.db, routineId, changes);
      if (!updated) return { error: 'Failed to update routine' };
      await reindexAgentRoutines(routineIndexSync(ctx.env, ctx.workspaceId), ctx.db, ctx.agentId);
      return {
        ok: true,
        routineId: updated.id,
        name: updated.name,
        cronExpr: updated.cronExpr,
        timezone: updated.timezone,
        enabled: updated.enabled,
        nextRunAt: updated.nextRunAt,
      };
    },
  },
  {
    id: 'agent.save_skill',
    name: 'save_skill',
    description:
      'Save the current process as a reusable skill (steps, rules, safety boundaries). Enable it for this agent.',
    requiredPermissions: [],
    parameters: z.object({
      name: z.string().min(2).max(255),
      instructions: z.string().min(20).max(20000),
      description: z.string().max(2000).optional(),
      activate: z.boolean().optional(),
    }),
    async execute(ctx, raw) {
      if (ctx.actorCanEdit === false) return NOT_EDITOR;
      const args = z
        .object({
          name: z.string().min(2).max(255),
          instructions: z.string().min(20).max(20000),
          description: z.string().max(2000).optional(),
          activate: z.boolean().optional(),
        })
        .parse(raw);
      const { createSkill, enableSkillForAgent } = await import('./parity');
      const skill = await createSkill(ctx.db, {
        name: args.name,
        instructions: args.instructions,
        description: args.description,
        status: args.activate === false ? 'draft' : 'active',
        createdBy: ctx.actorUserId,
        sourceAgentId: ctx.agentId,
      });
      await enableSkillForAgent(ctx.db, ctx.agentId, skill.id);
      return { ok: true, skillId: skill.id, name: skill.name, status: skill.status };
    },
  },
  {
    id: 'agent.remember',
    name: 'remember',
    description: 'Store a lasting preference, fact, or correction about how this agent should work.',
    requiredPermissions: [],
    parameters: z.object({
      kind: z.enum(['preference', 'fact', 'summary', 'correction']).default('preference'),
      content: z.string().min(1).max(5000),
    }),
    async execute(ctx, raw) {
      if (ctx.actorCanEdit === false) return NOT_EDITOR;
      const args = z
        .object({
          kind: z.enum(['preference', 'fact', 'summary', 'correction']).default('preference'),
          content: z.string().min(1).max(5000),
        })
        .parse(raw);
      const { createMemory } = await import('./parity');
      const memory = await createMemory(ctx.db, {
        agentId: ctx.agentId,
        kind: args.kind,
        content: args.content,
        source: 'chat',
        createdBy: ctx.actorUserId,
      });
      return { ok: true, memoryId: memory.id };
    },
  },
  {
    id: 'agent.create_routine',
    name: 'create_routine',
    description:
      'Create a scheduled or connector-triggered routine for this agent. Prefer cron for recurring work. ' +
      'Each run posts its result in a chat thread for the user who created the routine, and notifies them. ' +
      "Routines only run while the agent is active. Give cronExpr in the user's timezone (it is the default).",
    requiredPermissions: [],
    parameters: z.object({
      name: z.string().min(2).max(255),
      instructions: z.string().min(10).max(20000),
      scheduleKind: z.enum(['cron', 'event', 'connector']).default('cron'),
      cronExpr: z.string().max(100).optional(),
      timezone: z.string().max(64).optional(),
      eventKey: z.string().max(100).optional(),
      requireApproval: z.boolean().optional(),
      connectorProvider: z.enum(['slack', 'github']).optional(),
      connectorMatch: z.string().max(500).optional(),
      connectorChannel: z.string().max(200).optional(),
      connectorRepo: z.string().max(200).optional(),
    }),
    async execute(ctx, raw) {
      if (ctx.actorCanEdit === false) return NOT_EDITOR;
      const args = z
        .object({
          name: z.string().min(2).max(255),
          instructions: z.string().min(10).max(20000),
          scheduleKind: z.enum(['cron', 'event', 'connector']).default('cron'),
          cronExpr: z.string().max(100).optional(),
          timezone: z.string().max(64).optional(),
          eventKey: z.string().max(100).optional(),
          requireApproval: z.boolean().optional(),
          connectorProvider: z.enum(['slack', 'github']).optional(),
          connectorMatch: z.string().max(500).optional(),
          connectorChannel: z.string().max(200).optional(),
          connectorRepo: z.string().max(200).optional(),
        })
        .parse(raw);
      const { createRoutine, routineScheduleError } = await import('./parity');
      const timezone = args.timezone ?? ctx.userTimezone ?? undefined;
      if (args.scheduleKind === 'cron') {
        const scheduleError = routineScheduleError(args.cronExpr, timezone);
        if (scheduleError) return { error: scheduleError };
      }
      const routine = await createRoutine(ctx.db, {
        agentId: ctx.agentId,
        name: args.name,
        instructions: args.instructions,
        scheduleKind: args.scheduleKind,
        cronExpr: args.cronExpr,
        timezone,
        eventKey: args.eventKey,
        requireApproval: args.requireApproval ?? true,
        connectorConfig: args.connectorProvider
          ? {
              provider: args.connectorProvider,
              match: args.connectorMatch,
              channel: args.connectorChannel,
              repo: args.connectorRepo,
            }
          : null,
        createdBy: ctx.actorUserId,
      });
      await reindexAgentRoutines(routineIndexSync(ctx.env, ctx.workspaceId), ctx.db, ctx.agentId);
      return {
        ok: true,
        routineId: routine.id,
        name: routine.name,
        cronExpr: routine.cronExpr,
        timezone: routine.timezone,
        nextRunAt: routine.nextRunAt,
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
      const result = await listPeople(
        ctx.db,
        {
          search: args.search,
          limit: args.limit ?? 20,
        },
        peopleOwnerScope(ctx),
      );
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
      const person = await getPerson(ctx.db, args.id, peopleOwnerScope(ctx));
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
      // Background agent jobs can outlive the invoker's membership; leave the
      // owner unset then instead of failing the tool on the owner check.
      const ownerIsMember = await isValidWorkspaceMember(ctx.db, ctx.actorUserId);
      const person = await createPerson(ctx.db, {
        ...args,
        ownerId: ownerIsMember ? ctx.actorUserId : undefined,
        inCrm: true,
      });
      await emitAgentEntityEvent(ctx, 'person', person.id, {
        id: person.id,
        fullName: person.fullName,
        email: person.email,
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
      const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}-${randomBase36(4).toUpperCase()}`;
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
      await emitAgentEntityEvent(ctx, 'ticket', id, {
        id,
        ticketNumber,
        subject: args.subject,
        status: args.status ?? 'new',
        priority: args.priority ?? 'medium',
      });
      return { id, ticketNumber, subject: args.subject, status: args.status ?? 'new' };
    },
  },
  {
    id: 'tasks.list',
    name: 'list_tasks',
    description:
      'List WeldFlow tasks with their project, assignees and due date, optionally filtered by status, project, ' +
      'assignee, due date or search. totalCount is how many tasks match, whatever the limit. ' +
      '"My tasks": assignedToMe. "Due today" or "overdue": dueOnOrBefore with includeDone=false.',
    requiredPermissions: ['tasks:read'],
    parameters: listTasksParams,
    async execute(ctx, raw) {
      const args = listTasksParams.parse(raw);
      const { tasks: t } = schema;
      const limit = args.limit ?? 20;
      const conditions: SQL[] = [
        isNull(t.deletedAt),
        // Tasks of a deleted project are gone with it.
        sql`NOT EXISTS (SELECT 1 FROM ${schema.projects} WHERE ${schema.projects.id} = ${t.projectId} AND ${schema.projects.deletedAt} IS NOT NULL)`,
      ];
      if (args.status) conditions.push(eq(t.status, args.status));
      else if (args.includeDone === false) conditions.push(notInArray(t.status, [...CLOSED_TASK_STATUSES]));
      if (args.projectId) conditions.push(eq(t.projectId, args.projectId));
      if (args.search) conditions.push(ilike(t.title, `%${args.search}%`));
      if (args.assignedToMe) conditions.push(assignedTo(ctx.actorUserId));
      if (args.dueOnOrBefore) {
        const cutoff = dueCutoff(args.dueOnOrBefore, ctx.userTimezone ?? (await getWorkspaceTimezone(ctx.db)));
        if (!cutoff) return { error: 'dueOnOrBefore must be an ISO date such as 2026-10-27.' };
        conditions.push(cutoff.inclusive ? lte(t.dueDate, cutoff.at) : lt(t.dueDate, cutoff.at));
      }
      const scope = await taskRowScope(ctx);
      if (scope) conditions.push(scope);
      const where = and(...conditions);

      const [rows, [{ total }]] = await Promise.all([
        ctx.db
          .select({
            id: t.id,
            number: t.number,
            title: t.title,
            status: t.status,
            priority: t.priority,
            projectId: t.projectId,
            assigneeId: t.assigneeId,
            assigneeIds: t.assigneeIds,
            dueDate: t.dueDate,
          })
          .from(t)
          .where(where)
          // Tasks due soonest come first when the question is about due dates.
          .orderBy(...(args.dueOnOrBefore ? [asc(t.dueDate), desc(t.createdAt)] : [desc(t.createdAt)]))
          .limit(limit),
        ctx.db.select({ total: sql<number>`count(*)::int` }).from(t).where(where),
      ]);
      const [projects, members] = await Promise.all([
        projectNames(ctx.db, rows.map((row) => row.projectId)),
        memberNames(ctx.db, rows.flatMap((row) => taskAssigneeIds(row))),
      ]);
      return {
        totalCount: Number(total),
        tasks: rows.map((row) => ({
          id: row.id,
          number: row.number,
          title: row.title,
          status: row.status,
          priority: row.priority,
          projectId: row.projectId,
          projectName: row.projectId ? (projects.get(row.projectId) ?? null) : null,
          assigneeIds: taskAssigneeIds(row),
          assignees: taskAssigneeIds(row).flatMap((id) => members.get(id) ?? []),
          dueDate: row.dueDate ? row.dueDate.toISOString() : null,
        })),
      };
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
      const number = await allocateTaskNumber(ctx.db);
      await ctx.db.insert(t).values({
        id,
        number,
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
      await emitAgentEntityEvent(ctx, 'project_task', id, {
        id,
        title: args.title,
        projectId: args.projectId ?? null,
        status: args.status ?? 'todo',
      });
      return { id, title: args.title, status: args.status ?? 'todo' };
    },
  },
  ...PROJECT_TOOLS,
  ...SHEET_TOOLS,
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

      // Any status: a draft or paused agent still answers when mentioned.
      const [target] = await ctx.db
        .select({ id: weldagentAgents.id, name: weldagentAgents.name })
        .from(weldagentAgents)
        .where(and(eq(weldagentAgents.id, args.agentId), isNull(weldagentAgents.deletedAt)))
        .limit(1);
      if (!target) {
        return { error: 'Target agent not found' };
      }

      // Return a mention token the model should include; actual dispatch happens
      // when the reply is posted and scanned for <@agt_…> mentions.
      return {
        ok: true,
        mentionToken: `<@${args.agentId}>`,
        agentName: target.name,
        hint: `Include <@${args.agentId}> in your reply text to ping ${target.name}. Message draft: ${args.message}`,
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

      const { createChannel } = await import('@weldsuite/chat-domain/create-channel');
      const { addChannelMembers } = await import('@weldsuite/chat-domain/channel-members');
      const { mergeAgentRoomPolicy } = await import('@weldsuite/chat-domain/agent-room-policy');
      const { postAgentChatMessage } = await import('@weldsuite/chat-domain/post-agent-message');
      const { dispatchAgentRoomReplies } = await import('./agent-mention-dispatch');

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
 * Every permission key some platform tool needs (the registry's
 * `requiredPermissions`, sheets included, none empty). A grant outside this
 * list gives the agent no platform tool, which the Access tab can say.
 */
export function listToolPermissions(): string[] {
  return [...new Set(PLATFORM_TOOLS.flatMap((tool) => tool.requiredPermissions))].filter(
    (permission) => permission.length > 0,
  );
}

const TOOL_IDS = new Set(PLATFORM_TOOLS.map((t) => t.id));

/**
 * `enabledTools` also carries non-tool flags (e.g. `agent.auto_review`). Only
 * real tool ids count toward the allow-list — otherwise turning on a flag would
 * silently strip every platform tool from the agent.
 */
export function explicitToolAllowList(enabledTools: string[] = []): string[] {
  return enabledTools.filter((id) => TOOL_IDS.has(id));
}

/**
 * Narrow an agent's grants to what the human driving this turn may do. An agent
 * never lets a user act beyond their own role; unattended runs (events,
 * routines) pass no actor permissions and use the agent's grants as-is.
 */
export function effectiveAgentPermissions(
  agentPermissions: string[],
  actorPermissions?: string[] | null,
): string[] {
  if (!actorPermissions) return agentPermissions;
  // An agent works across apps, and a user's grants may be per app
  // (`weldcrm:people:read`) while the agent's are not (`people:read`), so
  // each side is matched plainly or in any app.
  const holds = (grants: string[], key: string) =>
    hasPermission(grants, key) || hasAppPermission({ permissions: grants }, key, null);
  // Keep the narrower side of each overlap so wildcards intersect correctly
  // (agent `people:*` ∩ user `people:read` → `people:read`).
  return Array.from(
    new Set([
      ...agentPermissions.filter((perm) => holds(actorPermissions, perm)),
      ...actorPermissions.filter((perm) => holds(agentPermissions, perm)),
    ]),
  );
}

/**
 * Filter the registry to tools the agent may use given its grants and optional
 * explicit enabledTools allow-list.
 * `agent.save_setup` is always available so unfinished agents can finish onboarding,
 * and `agent.ask_user` so any agent can put a question to the user.
 */
export function resolveAgentTools(
  agentPermissions: string[],
  enabledTools: string[] = [],
  /** False drops the tools that change the agent (see AGENT_EDIT_TOOL_IDS). */
  canEdit = true,
): PlatformToolDefinition[] {
  const alwaysOn = new Set([
    'agent.ask_user',
    'agent.save_setup',
    'agent.save_skill',
    'agent.remember',
    'agent.create_routine',
    'agent.list_routines',
    'agent.update_routine',
  ]);
  const allowList = explicitToolAllowList(enabledTools);
  return PLATFORM_TOOLS.filter((tool) => {
    if (!canEdit && AGENT_EDIT_TOOL_IDS.has(tool.id)) return false;
    if (alwaysOn.has(tool.id)) return true;
    if (allowList.length > 0 && !allowList.includes(tool.id)) return false;
    return agentHasGrants(agentPermissions, tool.requiredPermissions);
  });
}

/** Look up a tool the agent may run by its model-facing name. */
export function findAgentToolByName(
  agentPermissions: string[],
  enabledTools: string[],
  toolName: string,
): PlatformToolDefinition | undefined {
  return resolveAgentTools(agentPermissions, enabledTools).find((t) => t.name === toolName);
}

export { agentHasGrants };
