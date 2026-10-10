/**
 * Partner portal — /api/partner/*.
 *
 * A partner (reseller) manages the workspaces it licenses for its customers:
 * creates them, edits each licence (apps, monthly credits, seats, the price it
 * charges), grants extra credits, defines licence packages, reads its monthly
 * statements and runs its own team. Plan: docs/plans/reseller-licensing.md.
 *
 * Auth: `clerkMiddleware()` (mounted in src/index.ts, before the global
 * `apiAuth()` because a partner user may have no active org) then
 * `partnerAuth()`, which resolves the caller's `partner_members` rows and the
 * partner to act for (`X-Partner-Id`). Permissions are `PARTNER_PERMISSIONS`
 * (`requirePartnerPermission`), not workspace `weld*` keys. No tenant DB is
 * ever put on the context: partner users see usage numbers and manage
 * licences, never a customer's records. The only tenant access is the
 * installed-apps sync after a licence write (services/partner/licence-effects).
 *
 * Entity events: none. Everything here is master-DB state (partners, licences,
 * statements), the same category as /api/credits: the entity-event bus feeds
 * workflows, analytics and agents, and none of them belong in a reseller's
 * commercial data. Licence changes keep their own append-only history
 * (`workspace_licence_changes`, with the actor and reason).
 *
 * Money: amounts are decimal strings in USD, computed by the shared maths in
 * `@weldsuite/app-api-client/schemas/partners`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  LicenceError,
  PartnerPortalError,
  archivePackage,
  createPackage,
  currentStatementPreview,
  getPackage,
  getPartnerWorkspace,
  grantPartnerExtraCredits,
  inviteTeamMember,
  listLicenceHistory,
  listManagedWorkspaces,
  listPackages,
  listRequests,
  listTeam,
  getManagedWorkspace,
  markRequestProvisioned,
  memberCan,
  partnerCatalog,
  partnerOverview,
  partnerPublicInfo,
  partnerStatement,
  partnerStatementList,
  removeTeamMember,
  setLicenceStatus,
  snapshotOf,
  statementToCsv,
  updatePackage,
  updatePartnerSettings,
  updateRequestStatus,
  updateTeamMemberRole,
  upsertWorkspaceLicence,
  validateLicenceTerms,
} from '@weldsuite/core-domain/partners';
import {
  WORKSPACE_LICENCE_STATUSES,
  createManagedWorkspaceSchema,
  licencePackageSchema,
  licenceStatusChangeSchema,
  partnerCreditGrantSchema,
  partnerMemberInviteSchema,
  partnerMemberUpdateSchema,
  partnerRequestUpdateSchema,
  partnerSettingsSchema,
  workspaceLicenceInputSchema,
  type LicenceTerms,
  type PartnerCreditGrantResult,
  type PartnerMembership,
  type ManagedWorkspaceDetail,
} from '@weldsuite/app-api-client/schemas/partners';
import type { Env, Variables } from '../../types';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { partnerAuth, partnerIdentity, requirePartnerPermission } from '../../middleware/partner-auth';
import { applyLicenceEffects } from '../../services/partner/licence-effects';
import { sendPartnerInviteEmail } from '../../services/partner/notify';

type PartnerContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// Error mapping
// ============================================================================

/** `LicenceError` → 400 (bad terms), 409 (no contract), 404 (unknown workspace). */
function licenceFailure(c: PartnerContext, err: LicenceError) {
  const status = err.code === 'INVALID_APPS' || err.code === 'PLAN_NOT_ALLOWED' ? 400 : err.code === 'NO_CONTRACT' ? 409 : 404;
  return c.json({ error: { code: err.code, message: err.message } }, status);
}

function portalFailure(c: PartnerContext, err: PartnerPortalError) {
  const status =
    err.code === 'NOT_FOUND' ? 404 : err.code === 'RATE_LIMITED' ? 429 : 409; // LAST_OWNER, ALREADY_MEMBER, REQUEST_PROVISIONED
  return c.json({ error: { code: err.code, message: err.message } }, status);
}

/** Run a handler body, turning the domain's expected failures into their HTTP answers. */
async function guarded(c: PartnerContext, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof LicenceError) return licenceFailure(c, err);
    if (err instanceof PartnerPortalError) return portalFailure(c, err);
    throw err;
  }
}

// ============================================================================
// Identity — before partnerAuth: needs no X-Partner-Id and answers non-partners
// ============================================================================

// GET /me — the caller's partner memberships. A user who is not a partner gets
// an empty list (200), not a 403: the shell probes this for every user to decide
// whether to show the portal entry.
app.get('/me', partnerIdentity(), (c) => {
  const memberships: PartnerMembership[] = (c.get('partnerMemberships') ?? []).map((m) => ({
    partnerId: m.partner.id,
    partnerName: m.partner.name,
    role: m.role,
    status: m.partner.status,
  }));
  return success(c, memberships);
});

// Everything below acts for one partner.
app.use('*', partnerAuth());

const canRead = requirePartnerPermission('partner:workspaces:read');
const canManageWorkspaces = requirePartnerPermission('partner:workspaces:manage');
const canManageLicences = requirePartnerPermission('partner:licences:manage');
const canReadBilling = requirePartnerPermission('partner:billing:read');
const canManageTeam = requirePartnerPermission('partner:team:manage');

/** A licence's editable terms, without the request-only fields (`packageId`, `reason`). */
function termsOf(input: z.infer<typeof workspaceLicenceInputSchema>): LicenceTerms {
  return {
    allowedApps: input.allowedApps,
    monthlyCredits: input.monthlyCredits,
    creditRolloverCap: input.creditRolloverCap,
    maxSeats: input.maxSeats,
    featurePlanId: input.featurePlanId,
    storageGb: input.storageGb,
    resalePricing: input.resalePricing,
  };
}

// ============================================================================
// Overview
// ============================================================================

app.get('/overview', canRead, async (c) => {
  const partner = c.get('partner')!;
  const member = c.get('partnerMember')!;
  const overview = await partnerOverview(getMasterDb(c.env), {
    partner,
    role: member.role,
    includeBilling: memberCan(member, 'partner:billing:read'),
  });
  return success(c, overview);
});

// ============================================================================
// Workspaces
// ============================================================================

const workspacesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(WORKSPACE_LICENCE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Offset of the next page, as returned in `pagination.cursor`. */
  cursor: z.coerce.number().int().min(0).default(0),
});

app.get('/workspaces', canRead, zValidator('query', workspacesQuery), async (c) => {
  const partner = c.get('partner')!;
  const { q, status, limit, cursor } = c.req.valid('query');
  const { rows, totalCount } = await listManagedWorkspaces(getMasterDb(c.env), partner.id, {
    q: q || undefined,
    status,
    limit,
    offset: cursor,
  });
  const next = cursor + rows.length;
  const hasMore = next < totalCount;
  return list(c, rows, cursorPagination(totalCount, hasMore, hasMore ? String(next) : null));
});

app.post('/workspaces', canManageWorkspaces, zValidator('json', createManagedWorkspaceSchema), (c) =>
  guarded(c, async () => {
    const partner = c.get('partner')!;
    const userId = c.get('userId');
    const body = c.req.valid('json');
    const masterDb = getMasterDb(c.env);

    // A partner that has not paid does not get to add workspaces (and the
    // credits they would carry).
    if (partner.status === 'suspended') {
      return c.json(
        { error: { code: 'PARTNER_SUSPENDED', message: 'New workspaces are paused until the overdue invoice is paid.' } },
        403,
      );
    }

    const terms = termsOf(body.licence);
    await validateLicenceTerms(masterDb, partner.id, terms);
    if (body.licence.packageId && !(await getPackage(masterDb, partner.id, body.licence.packageId))) {
      return error.badRequest(c, 'Unknown licence package');
    }

    const workspaceWorker = c.env.WORKSPACE_WORKER;
    if (!workspaceWorker?.onboardPartnerWorkspace) {
      console.error('[partner] WORKSPACE_WORKER.onboardPartnerWorkspace is not available');
      return error.internal(c, 'Workspace service not configured');
    }

    let created: { workspaceId: string; clerkOrgId: string };
    try {
      created = await workspaceWorker.onboardPartnerWorkspace({
        partnerId: partner.id,
        actorUserId: userId,
        name: body.name,
        country: body.country,
        region: body.region,
        ownerEmail: body.ownerEmail.toLowerCase(),
        licence: { ...terms, packageId: body.licence.packageId },
      });
    } catch (err) {
      // Only the message crosses the RPC boundary; workspace-worker prefixes it with a code.
      const message = err instanceof Error ? err.message : String(err);
      const code = /^\[([A-Z_]+)\]/.exec(message)?.[1];
      const detail = message.replace(/^\[[A-Z_]+\]\s*/, '');
      if (code === 'VALIDATION' || code === 'INVALID_APPS' || code === 'PLAN_NOT_ALLOWED') return error.badRequest(c, detail);
      if (code === 'NO_CONTRACT') return error.conflict(c, detail);
      if (code === 'NOT_FOUND' || code === 'WRONG_PARTNER') return error.notFound(c, 'Licence package');
      console.error('[partner] onboardPartnerWorkspace failed:', err);
      return error.badGateway(c, 'Could not create the workspace');
    }
    if (!created?.workspaceId) return error.badGateway(c, 'Could not create the workspace');

    if (body.requestId) {
      const linked = await markRequestProvisioned(masterDb, partner.id, body.requestId, created.workspaceId);
      if (!linked) console.warn('[partner] Request to mark provisioned was not found:', body.requestId);
    }

    return success(c, { workspaceId: created.workspaceId }, 201);
  }),
);

app.get('/workspaces/:id', canRead, async (c) => {
  const partner = c.get('partner')!;
  const id = c.req.param('id');
  const masterDb = getMasterDb(c.env);
  const row = await getManagedWorkspace(masterDb, partner.id, id);
  if (!row) return error.notFound(c, 'Workspace', id);
  const detail: ManagedWorkspaceDetail = { ...row, history: await listLicenceHistory(masterDb, partner.id, id) };
  return success(c, detail);
});

/** The workspace row of this partner, plus the fields licence side effects need. */
async function ownWorkspace(c: PartnerContext, workspaceId: string) {
  const row = await getPartnerWorkspace(getMasterDb(c.env), c.get('partner')!.id, workspaceId);
  return row ? { id: row.id, clerkOrgId: row.clerkOrgId } : null;
}

/** Surface a partial failure of the post-write steps without changing the body shape. */
function withWarnings(c: PartnerContext, warnings: string[]) {
  if (warnings.length > 0) c.header('X-Partner-Warnings', warnings.join(','));
}

app.put('/workspaces/:id/licence', canManageLicences, zValidator('json', workspaceLicenceInputSchema), (c) =>
  guarded(c, async () => {
    const partner = c.get('partner')!;
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const masterDb = getMasterDb(c.env);

    const workspace = await ownWorkspace(c, id);
    if (!workspace) return error.notFound(c, 'Workspace', id);

    const terms = termsOf(body);
    await validateLicenceTerms(masterDb, partner.id, terms);
    if (body.packageId && !(await getPackage(masterDb, partner.id, body.packageId))) {
      return error.badRequest(c, 'Unknown licence package');
    }

    const actor = { id: userId, type: 'partner' as const };
    const result = await upsertWorkspaceLicence({
      db: masterDb,
      workspaceId: id,
      partnerId: partner.id,
      terms,
      packageId: body.packageId,
      actor,
      reason: body.reason ?? null,
    });
    const { warnings } = await applyLicenceEffects({
      env: c.env,
      masterDb,
      workspace,
      licence: snapshotOf(result.licence),
      previous: result.previous,
      changeId: result.changeId,
      actor,
    });
    withWarnings(c, warnings);

    return success(c, await getManagedWorkspace(masterDb, partner.id, id));
  }),
);

app.post('/workspaces/:id/status', canManageLicences, zValidator('json', licenceStatusChangeSchema), (c) =>
  guarded(c, async () => {
    const partner = c.get('partner')!;
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const masterDb = getMasterDb(c.env);

    const workspace = await ownWorkspace(c, id);
    if (!workspace) return error.notFound(c, 'Workspace', id);

    const actor = { id: userId, type: 'partner' as const };
    const result = await setLicenceStatus({
      db: masterDb,
      workspaceId: id,
      partnerId: partner.id,
      status: body.status,
      actor,
      reason: body.reason ?? null,
    });
    const { warnings } = await applyLicenceEffects({
      env: c.env,
      masterDb,
      workspace,
      licence: snapshotOf(result.licence),
      previous: result.previous,
      changeId: result.changeId,
      actor,
    });
    withWarnings(c, warnings);

    return success(c, await getManagedWorkspace(masterDb, partner.id, id));
  }),
);

app.post('/workspaces/:id/credits', canManageLicences, zValidator('json', partnerCreditGrantSchema), (c) =>
  guarded(c, async () => {
    const partner = c.get('partner')!;
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const masterDb = getMasterDb(c.env);

    // The key makes a retried request a no-op instead of a second charge.
    // `?idempotencyKey=` is the fallback for a caller that cannot send the header.
    const key = (c.req.header('Idempotency-Key') ?? c.req.query('idempotencyKey') ?? '').trim();
    if (!key || key.length > 200) {
      return error.badRequest(c, 'An Idempotency-Key header (at most 200 characters) is required');
    }
    if (partner.status === 'suspended') {
      return c.json(
        { error: { code: 'PARTNER_SUSPENDED', message: 'Extra credits are paused until the overdue invoice is paid.' } },
        403,
      );
    }

    const row = await getManagedWorkspace(masterDb, partner.id, id);
    if (!row) return error.notFound(c, 'Workspace', id);
    if (row.licence.status !== 'active') {
      return c.json({ error: { code: 'LICENCE_INACTIVE', message: 'The licence of this workspace is not active.' } }, 409);
    }

    // Scoped by partner and workspace so one partner's key can never collide with another's.
    const grant = await grantPartnerExtraCredits({
      db: masterDb,
      partnerId: partner.id,
      workspaceId: id,
      credits: body.credits,
      grantedBy: userId,
      note: body.note,
      idempotencyKey: `${partner.id}:${id}:${key}`,
    });
    const result: PartnerCreditGrantResult = { newBalance: grant.newBalance, amount: body.credits, charge: grant.amount };
    return success(c, result);
  }),
);

// ============================================================================
// Licence packages
// ============================================================================

app.get('/packages', canRead, async (c) => {
  const partner = c.get('partner')!;
  return success(c, await listPackages(getMasterDb(c.env), partner.id, c.req.query('archived') === 'true'));
});

app.post('/packages', canManageLicences, zValidator('json', licencePackageSchema), (c) =>
  guarded(c, async () => {
    const partner = c.get('partner')!;
    return success(c, await createPackage(getMasterDb(c.env), partner.id, c.req.valid('json')), 201);
  }),
);

app.put('/packages/:id', canManageLicences, zValidator('json', licencePackageSchema), (c) =>
  guarded(c, async () => {
    const partner = c.get('partner')!;
    const id = c.req.param('id');
    const updated = await updatePackage(getMasterDb(c.env), partner.id, id, c.req.valid('json'));
    if (!updated) return error.notFound(c, 'Package', id);
    return success(c, updated);
  }),
);

app.delete('/packages/:id', canManageLicences, async (c) => {
  const partner = c.get('partner')!;
  const id = c.req.param('id');
  if (!(await archivePackage(getMasterDb(c.env), partner.id, id))) return error.notFound(c, 'Package', id);
  return noContent(c);
});

// ============================================================================
// Catalog
// ============================================================================

app.get('/catalog', canRead, async (c) => {
  return success(c, await partnerCatalog(getMasterDb(c.env), c.get('partner')!.id));
});

// ============================================================================
// Statements
// ============================================================================

app.get('/statements', canReadBilling, async (c) => {
  return success(c, await partnerStatementList(getMasterDb(c.env), c.get('partner')!.id));
});

// Literal segment before /:id.
app.get('/statements/current', canReadBilling, async (c) => {
  const preview = await currentStatementPreview(getMasterDb(c.env), c.get('partner')!.id);
  if (!preview) return error.notFound(c, 'Statement');
  return success(c, preview);
});

app.get('/statements/:id/csv', canReadBilling, async (c) => {
  const partner = c.get('partner')!;
  const id = c.req.param('id');
  const masterDb = getMasterDb(c.env);
  const view = id === 'current' ? await currentStatementPreview(masterDb, partner.id) : await partnerStatement(masterDb, partner.id, id);
  if (!view) return error.notFound(c, 'Statement', id);
  const period = view.periodStart.slice(0, 7);
  return c.body(statementToCsv(view), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="statement-${period}.csv"`,
    'Cache-Control': 'no-store',
  });
});

app.get('/statements/:id', canReadBilling, async (c) => {
  const id = c.req.param('id');
  const view = await partnerStatement(getMasterDb(c.env), c.get('partner')!.id, id);
  if (!view) return error.notFound(c, 'Statement', id);
  return success(c, view);
});

// ============================================================================
// Territory requests
// ============================================================================

app.get('/requests', canRead, async (c) => {
  return success(c, await listRequests(getMasterDb(c.env), c.get('partner')!.id));
});

app.patch('/requests/:id', canManageWorkspaces, zValidator('json', partnerRequestUpdateSchema), (c) =>
  guarded(c, async () => {
    const id = c.req.param('id');
    const updated = await updateRequestStatus(getMasterDb(c.env), c.get('partner')!.id, id, c.req.valid('json').status);
    if (!updated) return error.notFound(c, 'Request', id);
    return success(c, updated);
  }),
);

// ============================================================================
// Team
// ============================================================================

app.get('/team', canRead, async (c) => {
  return success(c, await listTeam(getMasterDb(c.env), c.get('partner')!.id));
});

app.post('/team', canManageTeam, zValidator('json', partnerMemberInviteSchema), (c) =>
  guarded(c, async () => {
    const partner = c.get('partner')!;
    const body = c.req.valid('json');
    const member = await inviteTeamMember(getMasterDb(c.env), {
      partnerId: partner.id,
      email: body.email,
      role: body.role,
      invitedBy: c.get('userId'),
    });
    c.executionCtx.waitUntil(sendPartnerInviteEmail(c.env, { to: member.email, partnerName: partner.name, role: member.role }));
    return success(c, member, 201);
  }),
);

app.patch('/team/:memberId', canManageTeam, zValidator('json', partnerMemberUpdateSchema), (c) =>
  guarded(c, async () => {
    const memberId = c.req.param('memberId');
    const updated = await updateTeamMemberRole(getMasterDb(c.env), c.get('partner')!.id, memberId, c.req.valid('json').role);
    if (!updated) return error.notFound(c, 'Team member', memberId);
    return success(c, updated);
  }),
);

app.delete('/team/:memberId', canManageTeam, (c) =>
  guarded(c, async () => {
    const memberId = c.req.param('memberId');
    if (!(await removeTeamMember(getMasterDb(c.env), c.get('partner')!.id, memberId))) {
      return error.notFound(c, 'Team member', memberId);
    }
    return noContent(c);
  }),
);

// ============================================================================
// Settings — what the partner's customers see
// ============================================================================

/** These URLs are rendered as links and images to other people: http(s) only (no `javascript:`). */
const settingsBody = partnerSettingsSchema.superRefine((value, ctx) => {
  for (const key of ['supportUrl', 'websiteUrl', 'logoUrl'] as const) {
    const url = value[key];
    if (url && !/^https?:\/\//i.test(url)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Must be an http(s) URL' });
    }
  }
});

app.get('/settings', canRead, (c) => success(c, partnerPublicInfo(c.get('partner')!)));

app.patch('/settings', canManageTeam, zValidator('json', settingsBody), async (c) => {
  const updated = await updatePartnerSettings(getMasterDb(c.env), c.get('partner')!.id, c.req.valid('json'));
  if (!updated) return error.notFound(c, 'Partner');
  return success(c, updated);
});

export const partnerRoutes = app;
