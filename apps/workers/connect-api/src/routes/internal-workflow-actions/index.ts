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
import { UnknownPipelineStageError } from '@weldsuite/crm-domain/opportunities';
import { activityType } from '@weldsuite/core-api-client/schemas/activities';
import {
  createContactFromWorkflow,
  createCustomerFromWorkflow,
  createDealFromWorkflow,
  createLeadFromWorkflow,
  logActivityFromWorkflow,
  moveDealStageFromWorkflow,
  personEventData,
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
// POST /create-lead — WeldConnect `create_lead` step. Leads always carry an
// email (same requirement as the CRM create route), so there is no
// dedup/reuse path like `create_contact` has.
// ---------------------------------------------------------------------------

const leadFieldsSchema = z.object({
  firstName: optionalTrimmed(100),
  lastName: optionalTrimmed(100),
  email: z.string().trim().email().max(255),
  companyName: optionalTrimmed(255),
  title: optionalTrimmed(100),
  phone: optionalTrimmed(50),
  mobile: optionalTrimmed(50),
  website: optionalTrimmed(500),
  source: optionalTrimmed(50),
  rating: optionalTrimmed(20),
  notes: optionalTrimmed(10000),
});

internalWorkflowActionsRoutes.post(
  '/create-lead',
  zValidator('json', actorSchema.extend({ lead: leadFieldsSchema })),
  async (c) => {
    const { workspaceId, ownerUserId, chainDepth, lead } = c.req.valid('json');
    try {
      const db = await getTenantDbForWorkspace(c.env, workspaceId);
      await authorizeWorkflowOwner(db, c.env, ownerUserId, {
        permission: 'leads:create',
        app: 'weldcrm',
        doing: 'create leads',
      });
      const { id, eventData } = await createLeadFromWorkflow(db, { ownerUserId, lead });
      await publishEntityEventRaw({
        env: c.env,
        workspaceId,
        userId: ownerUserId,
        entityType: 'lead',
        action: 'created',
        entityId: id,
        data: eventData,
        workflowDepth: chainDepth,
      });
      return c.json({
        success: true,
        lead: { id, name: (eventData.fullName as string | null) ?? null, email: eventData.email as string },
      });
    } catch (err) {
      return actionFailure(c, 'create-lead', err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /create-deal — WeldConnect `create_deal` step.
// ---------------------------------------------------------------------------

const dealFieldsSchema = z.object({
  name: z.string().trim().min(1).max(255),
  customerId: z.string().trim().min(1).max(30),
  description: optionalTrimmed(5000),
  amount: z.union([z.string(), z.number()]).optional(),
  currency: optionalTrimmed(3),
  pipeline: optionalTrimmed(100),
  stageId: optionalTrimmed(30),
  closeDate: optionalTrimmed(50),
});

internalWorkflowActionsRoutes.post(
  '/create-deal',
  zValidator('json', actorSchema.extend({ deal: dealFieldsSchema })),
  async (c) => {
    const { workspaceId, ownerUserId, chainDepth, deal } = c.req.valid('json');
    try {
      const db = await getTenantDbForWorkspace(c.env, workspaceId);
      await authorizeWorkflowOwner(db, c.env, ownerUserId, {
        permission: 'opportunities:create',
        app: 'weldcrm',
        doing: 'create deals',
      });
      const { id, eventData } = await createDealFromWorkflow(db, { ownerUserId, deal });
      await publishEntityEventRaw({
        env: c.env,
        workspaceId,
        userId: ownerUserId,
        entityType: 'opportunity',
        action: 'created',
        entityId: id,
        data: eventData,
        workflowDepth: chainDepth,
      });
      return c.json({
        success: true,
        deal: { id, name: eventData.name as string, stage: eventData.stage as string, status: eventData.status as string },
      });
    } catch (err) {
      return actionFailure(c, 'create-deal', err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /move-deal-stage — WeldConnect `move_deal_stage` step. Keeps
// won/lost/probability in sync exactly like the CRM PATCH route's `stageId`
// move does (opportunities.ts `syncStatusWithStage`), and publishes the same
// derived `stage_changed` / `won` / `lost` events.
// ---------------------------------------------------------------------------

internalWorkflowActionsRoutes.post(
  '/move-deal-stage',
  zValidator(
    'json',
    actorSchema.extend({
      dealId: z.string().trim().min(1).max(30),
      stageId: z.string().trim().min(1).max(30),
    }),
  ),
  async (c) => {
    const { workspaceId, ownerUserId, chainDepth, dealId, stageId } = c.req.valid('json');
    try {
      const db = await getTenantDbForWorkspace(c.env, workspaceId);
      const resolved = await authorizeWorkflowOwner(db, c.env, ownerUserId, {
        permission: 'opportunities:update',
        app: 'weldcrm',
        doing: 'move deals',
      });
      const ownerScope = ownerHolds(resolved, 'opportunities:scope:all', 'weldcrm') ? undefined : ownerUserId;
      const result = await moveDealStageFromWorkflow(db, { dealId, stageId, ownerScope });
      if (!result) {
        return c.json(
          { success: false, error: `Deal ${dealId} was not found (or the workflow's owner can't move it)` },
          404,
        );
      }
      for (const event of result.events) {
        await publishEntityEventRaw({
          env: c.env,
          workspaceId,
          userId: ownerUserId,
          entityType: 'opportunity',
          action: event.action,
          entityId: dealId,
          // crm-domain types this against the catalog's exact OpportunityEventData
          // shape (plus stageId, no index signature); publishEntityEventRaw takes a plain bag.
          data: event.data as unknown as Record<string, unknown>,
          workflowDepth: chainDepth,
        });
      }
      return c.json({ success: true, deal: { id: dealId, stageId: result.stageId, status: result.status } });
    } catch (err) {
      if (err instanceof UnknownPipelineStageError) {
        return c.json({ success: false, error: err.message }, 400);
      }
      return actionFailure(c, 'move-deal-stage', err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /log-activity — WeldConnect `log_activity` step.
// ---------------------------------------------------------------------------

const activityFieldsSchema = z.object({
  type: activityType,
  subject: z.string().trim().min(1).max(255),
  description: optionalTrimmed(10000),
  dueDate: optionalTrimmed(50),
  customerId: optionalTrimmed(30),
  contactId: optionalTrimmed(30),
  personId: optionalTrimmed(30),
  opportunityId: optionalTrimmed(30),
});

internalWorkflowActionsRoutes.post(
  '/log-activity',
  zValidator('json', actorSchema.extend({ activity: activityFieldsSchema })),
  async (c) => {
    const { workspaceId, ownerUserId, chainDepth, activity } = c.req.valid('json');
    try {
      const db = await getTenantDbForWorkspace(c.env, workspaceId);
      await authorizeWorkflowOwner(db, c.env, ownerUserId, {
        permission: 'activities:create',
        app: 'weldcrm',
        doing: 'log activities',
      });
      const { id, eventData } = await logActivityFromWorkflow(db, { ownerUserId, activity });
      await publishEntityEventRaw({
        env: c.env,
        workspaceId,
        userId: ownerUserId,
        entityType: 'activity',
        action: 'created',
        entityId: id,
        data: eventData,
        workflowDepth: chainDepth,
      });
      return c.json({
        success: true,
        activity: { id, type: eventData.type as string, subject: eventData.subject as string },
      });
    } catch (err) {
      return actionFailure(c, 'log-activity', err);
    }
  },
);
