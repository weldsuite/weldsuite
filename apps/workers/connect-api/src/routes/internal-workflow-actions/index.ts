/**
 * Internal service-to-service WeldConnect action routes —
 * `/api/internal/workflow-actions/*`.
 *
 * Moved here from app-api's internal router (routes/internal/index.ts) with
 * the rest of the connect module; @weldsuite/api-modules gives connect the
 * `/api/internal/workflow-actions` prefix (longest prefix wins over core's
 * `/api/internal`), so app-api's forwarder hands these calls to this worker.
 *
 * Caller: workflow-worker's create_customer action
 * (apps/workers/workflow-worker/src/engine/actions/customer.ts), over its
 * `CONNECT_INTERNAL` binding to the `ConnectInternal` entrypoint (no secret).
 *
 * The PUBLIC mount (registered BEFORE the global /api/* Clerk guard in
 * src/index.ts, reached through app-api's forwarder) stays until every caller
 * uses the entrypoint; it authenticates in-route with a shared-secret bearer:
 * `Authorization: Bearer <INTERNAL_API_SECRET>`, identical to app-api's
 * internal router.
 *
 * Response shapes intentionally preserve the LEGACY internal contract
 * ({ success, ... } / { success:false, error }) rather than the app-api
 * { data }/{ error } envelope. This is a machine contract, not a
 * platform-consumed route.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { InvalidMemberIdError } from '@weldsuite/crm-domain/people';
import { canAccessChannel } from '@weldsuite/chat-domain/channel-access';
import { postSystemChatMessage } from '@weldsuite/chat-domain/post-system-message';
import { resolveProjectAccess } from '@weldsuite/flow-domain/project-access';
import { taskAnalyticsPayload } from '@weldsuite/flow-domain/analytics-payload';
import {
  createContactFromWorkflow,
  createCustomerFromWorkflow,
  createTaskFromWorkflow,
  personEventData,
  sendTaskAssignmentNotificationsForWorkflow,
  updateContactFromWorkflow,
} from '../../services/workflow-actions';
import { authorizeWorkflowOwner, ownerHolds, WorkflowOwnerForbiddenError } from '../../services/workflow-owner';

export const internalWorkflowActionsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Auth — requests through the `ConnectInternal` entrypoint (service binding
// only) are trusted by topology; the public mount keeps the shared
// INTERNAL_API_SECRET bearer on every route until all callers use the
// entrypoint (same check as app-api's routes/internal/index.ts).
// ---------------------------------------------------------------------------

internalWorkflowActionsRoutes.use('*', async (c, next) => {
  if (c.get('internalTrusted') === true) {
    await next();
    return;
  }

  const secret = c.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error('[Internal API] INTERNAL_API_SECRET is not configured');
    return c.json({ error: 'Internal auth not configured' }, 503);
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  if (authHeader.slice(7) !== secret) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

// ---------------------------------------------------------------------------
// POST /create-customer — WeldConnect `create_customer` step
// (apps/workers/workflow-worker/src/engine/actions/customer.ts). Creates a CRM
// company through the companies service and publishes `company:created` with
// the run's chain depth so workflows listening to it can't loop forever.
// ---------------------------------------------------------------------------

const optionalTrimmed = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined));

const createCustomerSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  /** The workflow's owner; when sent, the action runs with (and is checked against) their permissions. */
  ownerUserId: z.string().min(1).optional(),
  chainDepth: z.number().int().min(0).default(0),
  skipIfEmailExists: z.boolean().default(true),
  customer: z.object({
    name: z.string().trim().min(1).max(255),
    email: optionalTrimmed(255).refine((v) => v === undefined || z.string().email().safeParse(v).success, {
      message: 'Invalid email address',
    }),
    phone: optionalTrimmed(50),
    website: optionalTrimmed(500),
    notes: optionalTrimmed(10000),
    status: optionalTrimmed(50),
  }),
});

internalWorkflowActionsRoutes.post(
  '/create-customer',
  zValidator('json', createCustomerSchema),
  async (c) => {
    const { workspaceId, userId, ownerUserId, chainDepth, skipIfEmailExists, customer } = c.req.valid('json');
    try {
      const db = await getTenantDbForWorkspace(c.env, workspaceId);
      if (ownerUserId) {
        await authorizeWorkflowOwner(db, c.env, ownerUserId, {
          permission: 'companies:create',
          app: 'weldcrm',
          doing: 'create companies',
        });
      }
      const { created, company } = await createCustomerFromWorkflow(db, {
        ...customer,
        userId: ownerUserId ?? userId,
        skipIfEmailExists,
      });

      if (created) {
        await publishEntityEventRaw({
          env: c.env,
          workspaceId,
          userId: ownerUserId ?? userId,
          entityType: 'company',
          action: 'created',
          entityId: company.id,
          data: {
            id: company.id,
            name: company.name,
            email: company.email,
            phone: company.phone,
            website: company.website,
            industry: company.industry,
            status: company.status,
          },
          workflowDepth: chainDepth,
        });
      }

      return c.json({
        success: true,
        created,
        customer: { id: company.id, name: company.name, email: company.email, status: company.status },
      });
    } catch (err) {
      return actionFailure(c, 'create-customer', err);
    }
  },
);

// ---------------------------------------------------------------------------
// WeldSuite record actions. Every body carries the workflow's actor: the run
// acts as the workflow's owner, whose permissions are checked here at run
// time (services/workflow-owner.ts). A refusal is a 403 the worker turns into
// a step failure that is not retried.
// ---------------------------------------------------------------------------

const actorSchema = z.object({
  workspaceId: z.string().min(1),
  ownerUserId: z.string().min(1),
  triggeredBy: z.string().min(1),
  chainDepth: z.number().int().min(0).default(0),
});

const contactFieldsSchema = z.object({
  firstName: optionalTrimmed(100),
  lastName: optionalTrimmed(100),
  email: optionalTrimmed(255).refine((v) => v === undefined || z.string().email().safeParse(v).success, {
    message: 'Invalid email address',
  }),
  phone: optionalTrimmed(50),
  title: optionalTrimmed(100),
  companyId: optionalTrimmed(30),
  status: optionalTrimmed(50),
  notes: optionalTrimmed(10000),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
});

/** Map a thrown error to the internal contract's response. */
function actionFailure(c: Context<{ Bindings: Env; Variables: Variables }>, label: string, err: unknown) {
  if (err instanceof WorkflowOwnerForbiddenError) {
    return c.json({ success: false, error: err.message }, 403);
  }
  if (err instanceof InvalidMemberIdError) {
    return c.json({ success: false, error: err.message }, 400);
  }
  console.error(`[Internal] Workflow ${label} failed:`, err);
  return c.json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' }, 500);
}

internalWorkflowActionsRoutes.post(
  '/create-contact',
  zValidator(
    'json',
    actorSchema.extend({ skipIfEmailExists: z.boolean().default(true), contact: contactFieldsSchema }),
  ),
  async (c) => {
    const { workspaceId, ownerUserId, chainDepth, skipIfEmailExists, contact } = c.req.valid('json');
    try {
      const db = await getTenantDbForWorkspace(c.env, workspaceId);
      await authorizeWorkflowOwner(db, c.env, ownerUserId, {
        permission: 'people:create',
        app: 'weldcrm',
        doing: 'create contacts',
      });
      const { created, person } = await createContactFromWorkflow(db, { ownerUserId, skipIfEmailExists, contact });
      if (created) {
        await publishEntityEventRaw({
          env: c.env,
          workspaceId,
          userId: ownerUserId,
          entityType: 'person',
          action: 'created',
          entityId: person.id,
          data: personEventData(person),
          workflowDepth: chainDepth,
        });
      }
      return c.json({
        success: true,
        created,
        contact: { id: person.id, displayName: person.displayName, email: person.email },
      });
    } catch (err) {
      return actionFailure(c, 'create-contact', err);
    }
  },
);

internalWorkflowActionsRoutes.post(
  '/update-contact',
  zValidator('json', actorSchema.extend({ contactId: z.string().trim().min(1).max(30), contact: contactFieldsSchema })),
  async (c) => {
    const { workspaceId, ownerUserId, chainDepth, contactId, contact } = c.req.valid('json');
    try {
      const db = await getTenantDbForWorkspace(c.env, workspaceId);
      const resolved = await authorizeWorkflowOwner(db, c.env, ownerUserId, {
        permission: 'people:update',
        app: 'weldcrm',
        doing: 'edit contacts',
      });
      const ownerScope = ownerHolds(resolved, 'people:scope:all', 'weldcrm') ? undefined : ownerUserId;
      const result = await updateContactFromWorkflow(db, { contactId, ownerScope, contact });
      if (!result) {
        return c.json({ success: false, error: `Contact ${contactId} was not found (or the workflow's owner can't edit it)` }, 404);
      }
      await publishEntityEventRaw({
        env: c.env,
        workspaceId,
        userId: ownerUserId,
        entityType: 'person',
        action: 'updated',
        entityId: result.row.id,
        data: personEventData(result.row),
        changes: result.changes,
        workflowDepth: chainDepth,
      });
      return c.json({
        success: true,
        contact: { id: result.row.id, displayName: result.row.displayName, email: result.row.email },
      });
    } catch (err) {
      return actionFailure(c, 'update-contact', err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /post-chat-message — WeldConnect `post_chat_message` step
// (apps/workers/workflow-worker/src/engine/actions/chat.ts). Posts to a
// WeldChat channel through `@weldsuite/chat-domain/post-system-message`,
// checked against the SAME two gates chat-api's human send route applies for
// the owner: `channels:create` (requirePermission) and `canAccessChannel`
// (membership boundary — public channels open, a private channel/DM needs the
// owner to actually be a member). The message is attributed to the workflow
// itself (`authorType: 'system'`, `authorId: 'workflow:<workflowId>'`), never
// to the owner, and publishes `chat_message:created` with the run's chain
// depth so a workflow that reacts to new messages can't loop forever
// (packages/core/entity-events/src/workflow-dispatch.ts MAX_ENTITY_WORKFLOW_DEPTH).
// ---------------------------------------------------------------------------

const postChatMessageSchema = actorSchema.extend({
  channelId: z.string().trim().min(1).max(30),
  content: z.string().trim().min(1).max(10000),
  mentions: z.array(z.string().trim().min(1).max(255)).max(50).optional(),
  /** Carried from the run's trigger data so the message is attributed to the workflow, not its owner. */
  workflowId: optionalTrimmed(30),
  workflowName: optionalTrimmed(255),
});

internalWorkflowActionsRoutes.post(
  '/post-chat-message',
  zValidator('json', postChatMessageSchema),
  async (c) => {
    const { workspaceId, ownerUserId, chainDepth, channelId, content, mentions, workflowId, workflowName } =
      c.req.valid('json');
    try {
      const db = await getTenantDbForWorkspace(c.env, workspaceId);
      await authorizeWorkflowOwner(db, c.env, ownerUserId, {
        permission: 'channels:create',
        app: 'weldchat',
        doing: 'post chat messages',
      });
      if (!(await canAccessChannel(db, channelId, ownerUserId))) {
        return c.json(
          { success: false, error: "The workflow's owner doesn't have access to this channel" },
          403,
        );
      }

      const authorId = `workflow:${workflowId || workspaceId}`;
      const authorName = workflowName || 'Workflow';
      const message = await postSystemChatMessage(
        { db, env: c.env, orgId: workspaceId, channelId, authorId, authorName, invokerUserId: ownerUserId },
        { content, mentions },
      );

      await publishEntityEventRaw({
        env: c.env,
        workspaceId,
        userId: ownerUserId,
        entityType: 'chat_message',
        action: 'created',
        entityId: message.id,
        data: { id: message.id, channelId, authorId, authorType: 'system' },
        workflowDepth: chainDepth,
      });

      return c.json({ success: true, message: { id: message.id, channelId } });
    } catch (err) {
      return actionFailure(c, 'post-chat-message', err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /create-task — WeldConnect `create_task` step
// (apps/workers/workflow-worker/src/engine/actions/task.ts). Runs as the
// workflow owner twice over: `tasks:create` (app `weldflow`) gates the
// feature, and `resolveProjectAccess` (the same check flow-api's row-level
// guard runs) gates the specific project. Creates the task through
// `@weldsuite/flow-domain`'s task service, awaits assignment notifications,
// and publishes `project_task:created` with the run's chain depth.
// ---------------------------------------------------------------------------

const createTaskSchema = actorSchema.extend({
  projectId: z.string().trim().min(1).max(30),
  task: z.object({
    title: z.string().trim().min(1).max(500),
    description: optionalTrimmed(10000),
    priority: optionalTrimmed(20),
    stageId: optionalTrimmed(30),
    assigneeIds: z.array(z.string().trim().min(1).max(30)).max(50).optional(),
    // ISO date-time string; the worker action resolves relative inputs
    // ("in 3 days") to an absolute one before this reaches the route.
    dueDate: optionalTrimmed(50),
    labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  }),
});

internalWorkflowActionsRoutes.post('/create-task', zValidator('json', createTaskSchema), async (c) => {
  const { workspaceId, ownerUserId, chainDepth, projectId, task } = c.req.valid('json');
  try {
    const db = await getTenantDbForWorkspace(c.env, workspaceId);
    const resolved = await authorizeWorkflowOwner(db, c.env, ownerUserId, {
      permission: 'tasks:create',
      app: 'weldflow',
      doing: 'create tasks',
    });
    const scopeAll = ownerHolds(resolved, 'projects:scope:all', 'weldflow');
    const access = await resolveProjectAccess(db, ownerUserId, { scopeAll }, projectId);
    if (!access.canWrite) {
      throw new WorkflowOwnerForbiddenError("The workflow's owner does not have write access to this project");
    }

    const { row, assigneeIds } = await createTaskFromWorkflow(db, { ownerUserId, projectId, task });

    await publishEntityEventRaw({
      env: c.env,
      workspaceId,
      userId: ownerUserId,
      entityType: 'project_task',
      action: 'created',
      entityId: row.id,
      data: taskAnalyticsPayload(row as unknown as Record<string, unknown>, { projectId }),
      workflowDepth: chainDepth,
    });

    await sendTaskAssignmentNotificationsForWorkflow(db, c.env, {
      assigneeIds,
      workspaceId,
      assignedByUserId: ownerUserId,
      taskId: row.id,
      taskTitle: row.title,
      projectId,
      taskPriority: row.priority ?? null,
      dueDate: row.dueDate ?? null,
      taskDescription: row.description ?? null,
    });

    return c.json({
      success: true,
      task: { id: row.id, number: row.number ?? null, projectId: row.projectId ?? projectId, title: row.title },
    });
  } catch (err) {
    return actionFailure(c, 'create-task', err);
  }
});
