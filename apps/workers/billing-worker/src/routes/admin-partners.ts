/**
 * Admin console API for reseller partners:
 * `/api/internal/admin/partners/*` (mounted by routes/admin.ts, so it shares
 * the `x-admin-secret` + acting-admin auth).
 *
 * Reseller licensing, docs/plans/reseller-licensing.md. Request bodies are the
 * shared Zod schemas of `@weldsuite/app-api-client/schemas/partners`.
 *
 * Like every admin write, a partner write needs an `x-request-id` (the Stripe
 * idempotency key) and is recorded in `admin_audit_events` (target type
 * `partner`), successful or not. These bodies mostly carry no `reason` field;
 * if the console sends one it is kept in the audit row. Responses:
 * `{ data }`, 204 for deletes, `{ error: { code, message, details? } }`.
 *
 *   GET    /                                 list
 *   POST   /                                 create (Stripe customer, contract, territories, owner invite)
 *   GET    /:id                              detail
 *   PATCH  /:id                              profile
 *   POST   /:id/contracts                    new effective-dated contract
 *   PUT    /:id/territories                  replace countries (409 TERRITORY_CONFLICT)
 *   POST   /:id/members                      invite a portal member
 *   DELETE /:id/members/:memberId
 *   POST   /:id/status                       status / pause the dunning clock
 *   POST   /:id/workspaces/attach            move a direct workspace under the partner
 *   POST   /:id/workspaces/:workspaceId/detach
 *   PUT    /:id/workspaces/:workspaceId/licence
 *   GET    /:id/statements/preview?period=YYYY-MM
 *   GET    /:id/statements/:statementId
 *   POST   /:id/statements/run?period=YYYY-MM
 *   POST   /:id/statements/:statementId/void
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  attachWorkspaceSchema,
  createPartnerSchema,
  detachWorkspaceSchema,
  partnerContractSchema,
  partnerMemberInviteSchema,
  partnerProfileSchema,
  partnerStatusOverrideSchema,
  partnerTerritoriesSchema,
  workspaceLicenceInputSchema,
} from '@weldsuite/app-api-client/schemas/partners';
import { getMasterDb } from '../lib/db';
import { PARTNER_TARGET, recordAdminAudit } from '../lib/admin-audit';
import type { AdminContext } from '../services/admin-billing';
import { AdminBillingError } from '../services/admin-billing';
import {
  addContract,
  addMember,
  attachWorkspace,
  createPartner,
  detachWorkspace,
  getPartnerDetail,
  getStatement,
  listPartners,
  previewStatement,
  removeMember,
  replaceTerritories,
  runStatement,
  setStatusOverride,
  setWorkspaceLicence,
  updatePartner,
  voidStatement,
} from '../services/partner-admin';
import { REQUEST_ID, errorMessage, errorResponse, type AdminCtx, type AdminEnv } from './admin-http';

export const adminPartnerRoutes = new Hono<AdminEnv>();

const voidSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason of at least 3 characters').max(500) });

interface PartnerActionSpec<B> {
  action: string;
  /** What the audit row points at; resolved after the body is parsed. */
  target: (body: B) => { targetId: string; workspaceId: string | null };
  /** Request fields worth keeping in the audit row (never secrets). */
  details?: (body: B) => Record<string, unknown>;
  /** Success status; 204 sends no body. */
  status?: 200 | 204;
}

/** The optional free-text reason of a request, for the audit row (schemas strip it). */
function rawReason(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const reason = (raw as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null;
}

/**
 * Parse, run, audit, respond: the partner variant of `runAction` in admin.ts.
 * It differs only in that `reason` is optional (the partner schemas carry
 * none), and that a write may have no body.
 */
async function runPartnerAction<S extends z.ZodTypeAny | null, R>(
  c: AdminCtx,
  schema: S,
  spec: PartnerActionSpec<S extends z.ZodTypeAny ? z.infer<S> : Record<string, never>>,
  run: (ctx: AdminContext, body: S extends z.ZodTypeAny ? z.infer<S> : Record<string, never>) => Promise<R>,
  auditTargetOf?: (result: R) => string,
) {
  type Body = S extends z.ZodTypeAny ? z.infer<S> : Record<string, never>;
  const masterDb = getMasterDb(c.env);
  const actor = c.get('adminActor');
  const requestId = c.req.header('x-request-id') ?? '';

  let body: Body;
  let reason: string | null = null;
  try {
    if (!REQUEST_ID.test(requestId)) {
      throw new AdminBillingError('BAD_REQUEST', 'x-request-id must be 8-100 letters, digits, - or _');
    }
    if (schema) {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new AdminBillingError('BAD_REQUEST', 'The request body must be JSON');
      }
      const parsed = (schema as z.ZodTypeAny).safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
        throw new AdminBillingError('BAD_REQUEST', `${where}${issue?.message ?? 'Invalid request'}`);
      }
      body = parsed.data as Body;
      reason = rawReason(raw);
    } else {
      body = {} as Body;
    }
  } catch (err) {
    return errorResponse(c, err);
  }

  const { targetId, workspaceId } = spec.target(body);
  const audit = { actor, workspaceId, targetType: PARTNER_TARGET, action: spec.action, reason };
  const requestDetails = { requestId, ...(spec.details?.(body) ?? {}) };

  try {
    const result = await run({ env: c.env, masterDb, actor, requestId, reason: reason ?? '' }, body);
    await recordAdminAudit(masterDb, {
      ...audit,
      targetId: auditTargetOf ? auditTargetOf(result) : targetId,
      outcome: 'success',
      details: { ...requestDetails, result: result as unknown as Record<string, unknown> },
    });
    if (spec.status === 204) return c.body(null, 204);
    return c.json({ data: result });
  } catch (err) {
    await recordAdminAudit(masterDb, {
      ...audit,
      targetId,
      outcome: 'failure',
      details: requestDetails,
      error: errorMessage(err),
    });
    return errorResponse(c, err);
  }
}

const onPartner = (c: AdminCtx) => () => ({ targetId: c.req.param('id')!, workspaceId: null });
const onPartnerWorkspace = (c: AdminCtx) => () => ({ targetId: c.req.param('id')!, workspaceId: c.req.param('workspaceId')! });

// ============================================================================
// Reads
// ============================================================================

adminPartnerRoutes.get('/', async (c) => {
  try {
    return c.json({ data: await listPartners(getMasterDb(c.env)) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

adminPartnerRoutes.get('/:id', async (c) => {
  try {
    return c.json({ data: await getPartnerDetail(getMasterDb(c.env), c.req.param('id')) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

adminPartnerRoutes.get('/:id/statements/preview', async (c) => {
  try {
    return c.json({ data: await previewStatement(getMasterDb(c.env), c.req.param('id'), c.req.query('period')) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

adminPartnerRoutes.get('/:id/statements/:statementId', async (c) => {
  try {
    return c.json({ data: await getStatement(getMasterDb(c.env), c.req.param('id'), c.req.param('statementId')) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ============================================================================
// Partner, contract, territories, members, status
// ============================================================================

adminPartnerRoutes.post('/', (c) =>
  runPartnerAction(
    c,
    createPartnerSchema,
    {
      action: 'partner.create',
      target: (b) => ({ targetId: b.name, workspaceId: null }),
      details: (b) => ({ name: b.name, country: b.country ?? null, ownerEmail: b.ownerEmail, territories: b.territories }),
    },
    (ctx, body) => createPartner(ctx, body),
    (partner) => partner.id,
  ),
);

adminPartnerRoutes.patch('/:id', (c) =>
  runPartnerAction(
    c,
    partnerProfileSchema.partial(),
    { action: 'partner.update', target: onPartner(c), details: (b) => ({ fields: Object.keys(b) }) },
    (ctx, body) => updatePartner(ctx, c.req.param('id'), body),
  ),
);

adminPartnerRoutes.post('/:id/contracts', (c) =>
  runPartnerAction(
    c,
    partnerContractSchema,
    { action: 'partner.contract.create', target: onPartner(c), details: (b) => ({ contract: b }) },
    (ctx, body) => addContract(ctx, c.req.param('id'), body),
  ),
);

adminPartnerRoutes.put('/:id/territories', (c) =>
  runPartnerAction(
    c,
    partnerTerritoriesSchema,
    { action: 'partner.territories.set', target: onPartner(c), details: (b) => ({ countries: b.countries }) },
    (ctx, body) => replaceTerritories(ctx, c.req.param('id'), body.countries),
  ),
);

adminPartnerRoutes.post('/:id/members', (c) =>
  runPartnerAction(
    c,
    partnerMemberInviteSchema,
    { action: 'partner.member.add', target: onPartner(c), details: (b) => ({ email: b.email, role: b.role }) },
    (ctx, body) => addMember(ctx, c.req.param('id'), body),
  ),
);

adminPartnerRoutes.delete('/:id/members/:memberId', (c) =>
  runPartnerAction(
    c,
    null,
    {
      action: 'partner.member.remove',
      target: onPartner(c),
      details: () => ({ memberId: c.req.param('memberId') }),
      status: 204,
    },
    (ctx) => removeMember(ctx, c.req.param('id'), c.req.param('memberId')),
  ),
);

adminPartnerRoutes.post('/:id/status', (c) =>
  runPartnerAction(
    c,
    partnerStatusOverrideSchema,
    {
      action: 'partner.status.override',
      target: onPartner(c),
      details: (b) => ({ status: b.status ?? null, dunningPausedUntil: b.dunningPausedUntil }),
    },
    (ctx, body) => setStatusOverride(ctx, c.req.param('id'), body),
  ),
);

// ============================================================================
// Workspaces
// ============================================================================

adminPartnerRoutes.post('/:id/workspaces/attach', (c) =>
  runPartnerAction(
    c,
    attachWorkspaceSchema,
    {
      action: 'partner.workspace.attach',
      target: onPartner(c),
      details: (b) => ({ workspaceId: b.workspaceId, cancelDirectSubscription: b.cancelDirectSubscription, licence: b.licence }),
    },
    (ctx, body) => attachWorkspace(ctx, c.req.param('id'), body),
  ),
);

adminPartnerRoutes.post('/:id/workspaces/:workspaceId/detach', (c) =>
  runPartnerAction(
    c,
    detachWorkspaceSchema,
    { action: 'partner.workspace.detach', target: onPartnerWorkspace(c) },
    (ctx, body) => detachWorkspace(ctx, c.req.param('id'), c.req.param('workspaceId'), body.reason),
  ),
);

adminPartnerRoutes.put('/:id/workspaces/:workspaceId/licence', (c) =>
  runPartnerAction(
    c,
    workspaceLicenceInputSchema,
    {
      action: 'partner.workspace.licence',
      target: onPartnerWorkspace(c),
      details: ({ reason: _r, ...licence }) => ({ licence }),
    },
    (ctx, body) => setWorkspaceLicence(ctx, c.req.param('id'), c.req.param('workspaceId'), body),
  ),
);

// ============================================================================
// Statements
// ============================================================================

adminPartnerRoutes.post('/:id/statements/run', (c) =>
  runPartnerAction(
    c,
    null,
    { action: 'partner.statement.run', target: onPartner(c), details: () => ({ period: c.req.query('period') ?? 'previous month' }) },
    (ctx) => runStatement(ctx, c.req.param('id'), c.req.query('period')),
  ),
);

adminPartnerRoutes.post('/:id/statements/:statementId/void', (c) =>
  runPartnerAction(
    c,
    voidSchema,
    {
      action: 'partner.statement.void',
      target: onPartner(c),
      details: () => ({ statementId: c.req.param('statementId') }),
    },
    (ctx) => voidStatement(ctx, c.req.param('id'), c.req.param('statementId')),
  ),
);

