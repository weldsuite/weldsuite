/**
 * Internal payroll endpoint, mounted only on the `BooksInternal` entrypoint
 * (service binding; trusted by topology, no Clerk JWT). hr-api calls it with
 * `X-Workspace-Id` (Clerk org id) when a WeldHR pay run is approved.
 *
 * POST /internal/payroll/imports
 *   { entityId, externalId (the pay run id), payDate, periodStart?, periodEnd?,
 *     description, country: 'NL' | 'US', totals, mapping?, postedBy? }
 *   → 201 { importId, journalEntryId, entryNumber, payDate, duplicate: false }
 *   → 200 { importId, journalEntryId, ..., duplicate: true, status } when the run was posted before
 *   → 409 when the run was posted before and that import has since been reversed (it is not posted)
 *   → 400 for totals that do not balance, a locked or closed period, an unknown account
 *   → 404 for an unknown accounting entity
 *
 * One pay run posts once: (entity, source `weldhr`, external id) is unique.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { error, success } from '@weldsuite/worker-kit/response';
import { getWorkspaceContextForOrg, schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { loadEntityAccounts } from '../../services/accounting-posting';
import { DuplicatePayrollError, findImportByExternalId, postPayrollImport } from '../../services/payroll/imports';
import { isPayrollFailure } from '../../services/payroll/errors';
import { accountMappingSchema } from '../../services/payroll/mapping';
import { buildWeldHrLines, resolveWeldHrMapping, weldHrSummary } from '../../services/payroll/weldhr';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const LOG = '[books-api/payroll-internal]';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().finite().min(-1_000_000_000).max(1_000_000_000);

const importSchema = z.object({
  entityId: z.string().min(1).max(30),
  externalId: z.string().min(1).max(100),
  payDate: isoDate,
  periodStart: isoDate.nullish(),
  periodEnd: isoDate.nullish(),
  description: z.string().min(1).max(255),
  country: z.enum(['NL', 'US']),
  totals: z.object({
    grossWages: money,
    employerTaxes: money,
    employerBenefits: money,
    reimbursements: money,
    employeeTaxes: money,
    employeeDeductions: money,
    netPay: money,
  }),
  /** Category → account id; categories left out get the chart's defaults. */
  mapping: accountMappingSchema.optional(),
  /** The member who approved the run (audit trail). */
  postedBy: z.string().max(255).nullish(),
});

app.use('*', async (c, next) => {
  if (c.get('internalTrusted') !== true) return error.unauthorized(c, 'Internal endpoint');
  await next();
});

/** Tenant from `X-Workspace-Id`; a caller that already resolved one (tests) keeps it. False when unknown or suspended. */
async function resolveTenant(c: AppContext): Promise<boolean> {
  if (c.get('tenantDb')) return true;
  const orgId = c.req.header('X-Workspace-Id');
  if (!orgId) return false;
  try {
    const workspace = await getWorkspaceContextForOrg(c.env, orgId);
    if (workspace.suspended) return false;
    c.set('tenantDb', workspace.db);
    c.set('workspaceId', workspace.id);
    c.set('orgId', orgId);
    c.set('userId', 'system');
    return true;
  } catch (err) {
    console.error(`${LOG} tenant resolution failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

app.post('/imports', async (c) => {
  const parsed = importSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return error.badRequest(c, 'Invalid payroll payload', parsed.error.flatten());
  const body = parsed.data;
  if (!(await resolveTenant(c))) return error.badRequest(c, 'X-Workspace-Id is missing or does not match an active workspace');
  const db = c.get('tenantDb');

  try {
    const [entity] = await db
      .select({ id: schema.entities.id, jurisdictionCode: schema.entities.jurisdictionCode })
      .from(schema.entities)
      .where(and(eq(schema.entities.id, body.entityId), isNull(schema.entities.deletedAt)))
      .limit(1);
    if (!entity) return error.notFound(c, 'Accounting entity', body.entityId);

    const accounts = await loadEntityAccounts(db, body.entityId);
    for (const [category, accountId] of Object.entries(body.mapping ?? {})) {
      if (!accounts.byId(accountId)) return error.badRequest(c, `The account mapped to ${category} does not belong to this accounting entity`);
    }
    const mapping = resolveWeldHrMapping(accounts, body.country, body.mapping);
    const lines = buildWeldHrLines(body.totals, accounts, mapping, body.description);

    const posted = await postPayrollImport(db, {
      entityId: body.entityId,
      userId: body.postedBy ?? null,
      source: 'weldhr',
      externalId: body.externalId,
      payDate: body.payDate,
      periodStart: body.periodStart ?? null,
      periodEnd: body.periodEnd ?? null,
      lines,
      summary: weldHrSummary(body.totals),
      description: body.description,
      reference: body.externalId,
    });

    await writeAccountingAudit(c, db, { accountingEntityId: body.entityId, entityType: 'payroll_import', entityId: posted.importId, action: 'created' });
    publishEntityEvent({
      c,
      entityType: 'payroll_import',
      entityId: posted.importId,
      action: 'created',
      source: 'system',
      data: { id: posted.importId, entityId: body.entityId, source: 'weldhr', payDate: body.payDate, status: 'posted', journalEntryId: posted.journalEntryId },
    });
    return success(c, { ...posted, duplicate: false }, 201);
  } catch (err) {
    if (err instanceof DuplicatePayrollError) {
      const existing = await findImportByExternalId(db, body.entityId, 'weldhr', body.externalId);
      // A payroll that was posted and then reversed in WeldBooks is NOT posted: the external id stays taken, so it
      // cannot be posted again either. Say so instead of reporting a success the ledger does not have.
      if (err.existing.status === 'reversed') {
        return error.conflict(c, 'This payroll was posted to WeldBooks and has since been reversed there. It is not posted; a reversed payroll cannot be posted again.', { importId: err.existing.id, status: 'reversed' });
      }
      return success(c, { importId: err.existing.id, journalEntryId: existing?.journalEntryId ?? null, entryNumber: null, payDate: existing?.payDate ?? body.payDate, duplicate: true, status: err.existing.status });
    }
    if (isPayrollFailure(err)) return error.badRequest(c, err.message);
    console.error(`${LOG} import failed:`, err);
    return error.internal(c, 'Failed to post the payroll');
  }
});

export const payrollInternalRoutes = app;
