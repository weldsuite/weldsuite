/**
 * Vendor payment runs: check runs and ACH runs (/api/payment-runs).
 *
 * A run is a batch of bills to pay from one bank account. It is planned
 * (draft), submitted, approved (two people for ACH), and only then does the
 * money move in the books: one payment per vendor, allocated over its bills.
 * Vendors with a hold (bank details changed and unverified, no bank details,
 * a bill in another open run, ...) are left out of the payments until the hold
 * is cleared.
 *
 * Backup withholding (24% from a 1099 vendor without a TIN, or flagged after an
 * IRS B notice) is taken out of the payment, not held: the bills settle for the
 * gross, the bank is credited the net and the withheld part goes to Backup
 * Withholding Payable. Run and vendor views carry `withheldAmount` / `netAmount`
 * (a preview until the payment is made); checks, NACHA entries, Positive Pay
 * and the check register show the net, `grossAmount` and
 * `backupWithholdingAmount` next to it.
 *
 *   GET    /                         runs of the entity ?status= ?method= ?bankAccountId= ?limit= ?cursor=
 *   GET    /payable-bills            approved bills with a balance, by vendor ?dueBefore= ?partyId= ?bankAccountId=
 *   POST   /                         {bankAccountId, method, paymentDate, items[], secCode?, sameDay?, requiredApprovals?, notes?}
 *   GET    /:id                      the run with bills, vendors, holds, payments, approvals and history
 *   PATCH  /:id                      edit a draft
 *   DELETE /:id                      delete a draft
 *   POST   /:id/submit               draft -> pending approval
 *   POST   /:id/approve              record one approval; the last one makes the payments
 *   POST   /:id/reject               {reason} pending -> draft, approvals cleared
 *   POST   /:id/cancel               draft or pending -> cancelled
 *   POST   /:id/release-hold         {partyId, reason?} let a held vendor into the run
 *   GET    /:id/checks               print data for the run's checks (check runs)
 *   POST   /:id/checks/printed       {paymentIds} mark checks printed
 *   GET    /:id/nacha                the NACHA file (ACH runs): { fileName, content, summary }
 *   POST   /:id/complete             the bank accepted the file (ACH runs)
 *   POST   /checks/:paymentId/void   {reason, reissue?, date?} void a check, optionally reissue it
 *   GET    /check-register           checks of a bank account ?bankAccountId= ?from= ?to= ?status=
 *   GET    /positive-pay             Positive Pay file ?bankAccountId= ?from= ?to= ?format=
 *   GET    /positive-pay/formats     the formats
 *   GET|PUT /settings/:bankAccountId check, ACH and Positive Pay settings of a bank account
 *
 * Permissions: bills:read (view), banking:create (make, edit, submit, cancel),
 * banking:manage (approve, reject, release holds, print and export files, void
 * checks, settings).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, list, noContent, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { approveRun } from '../../services/payment-runs/approval';
import { buildCheckPrintData, markChecksPrinted } from '../../services/payment-runs/checks';
import { generateNachaFile, completeAchRun } from '../../services/payment-runs/nacha';
import {
  cancelRun,
  createRun,
  deleteRun,
  getRunDetail,
  listPayableBills,
  listRuns,
  rejectRun,
  releaseHold,
  submitRun,
  updateRun,
} from '../../services/payment-runs/runs';
import { checkRegisterRoutes, checksRoutes } from './checks';
import { positivePayRoutes } from './positive-pay';
import { settingsRoutes } from './settings';
import {
  auditRun,
  day,
  createRunSchema,
  pageLimit,
  printedSchema,
  publishPaymentsCreated,
  reasonSchema,
  releaseHoldSchema,
  requireEntity,
  respondError,
  runEventData,
  updateRunSchema,
  type AppContext,
  type RunAction,
} from './shared';
import type { RunRow } from '../../services/payment-runs/runs';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** The entity event of a run mutation: ids, status and totals only, never vendor bank data. */
function runEvent(c: AppContext, run: RunRow, action: RunAction): void {
  publishEntityEvent({ c, entityType: 'payment_run', entityId: run.id, action, data: runEventData(run) });
}

// Static paths first: they must not be read as a run id.
app.route('/settings', settingsRoutes);
app.route('/positive-pay', positivePayRoutes);
app.route('/checks', checksRoutes);
app.route('/check-register', checkRegisterRoutes);

const payableQuery = z.object({
  dueBefore: day.optional(),
  partyId: z.string().min(1).max(30).optional(),
  bankAccountId: z.string().min(1).max(30).optional(),
});

// GET /payable-bills — approved bills with an open balance, by vendor
app.get('/payable-bills', requirePermission('bills:read'), zValidator('query', payableQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const vendors = await listPayableBills(db, { entityId, ...q });
    return list(c, vendors, cursorPagination(vendors.length, false, null));
  } catch (err) {
    return respondError(c, err, 'fetch payable bills');
  }
});

// GET / — runs, newest first
app.get('/', requirePermission('bills:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) {
      // An empty tenant simply has nothing to list.
      return list(c, [], cursorPagination(0, false, null));
    }
    const result = await listRuns(db, entityId, {
      status: q.status,
      method: q.method,
      bankAccountId: q.bankAccountId,
      limit: pageLimit(q.limit),
      cursor: q.cursor,
    });
    return list(c, result.rows, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    return respondError(c, err, 'fetch payment runs');
  }
});

// POST / — plan a run
app.post('/', requirePermission('banking:create'), zValidator('json', createRunSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const { run, approvalsLowered } = await createRun(db, {
      entityId,
      userId: c.get('userId') ?? null,
      bankAccountId: data.bankAccountId,
      method: data.method,
      paymentDate: data.paymentDate,
      secCode: data.secCode ?? null,
      sameDay: data.sameDay ?? false,
      items: data.items,
      requiredApprovals: data.requiredApprovals,
      notes: data.notes ?? null,
      canLowerApprovals: await hasContextPermission(c, 'banking:manage'),
    });
    await auditRun(c, db, run, 'created', {
      method: { old: null, new: run.method },
      totalAmount: { old: null, new: run.totalAmount },
      requiredApprovals: { old: null, new: run.requiredApprovals },
      ...(approvalsLowered ? { approvalsLowered: { old: false, new: true } } : {}),
    });
    runEvent(c, run, 'created');
    return success(c, await getRunDetail(db, entityId, run.id), 201);
  } catch (err) {
    return respondError(c, err, 'create payment run');
  }
});

// GET /:id
app.get('/:id', requirePermission('bills:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    return success(c, await getRunDetail(db, entityId, c.req.param('id')));
  } catch (err) {
    return respondError(c, err, 'fetch payment run');
  }
});

// PATCH /:id — edit a draft
app.patch('/:id', requirePermission('banking:create'), zValidator('json', updateRunSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const { run, before } = await updateRun(db, {
      entityId,
      runId: c.req.param('id'),
      paymentDate: data.paymentDate,
      secCode: data.secCode,
      sameDay: data.sameDay,
      items: data.items,
      requiredApprovals: data.requiredApprovals,
      notes: data.notes,
      bankAccountId: data.bankAccountId,
      canLowerApprovals: await hasContextPermission(c, 'banking:manage'),
    });
    await auditRun(c, db, run, 'updated', {
      totalAmount: { old: before.totalAmount, new: run.totalAmount },
      requiredApprovals: { old: before.requiredApprovals, new: run.requiredApprovals },
      paymentDate: { old: before.paymentDate, new: run.paymentDate },
    });
    runEvent(c, run, 'updated');
    return success(c, await getRunDetail(db, entityId, run.id));
  } catch (err) {
    return respondError(c, err, 'update payment run');
  }
});

// DELETE /:id — a draft only
app.delete('/:id', requirePermission('banking:create'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const run = await deleteRun(db, entityId, c.req.param('id'));
    await auditRun(c, db, run, 'deleted');
    runEvent(c, run, 'deleted');
    return noContent(c);
  } catch (err) {
    return respondError(c, err, 'delete payment run');
  }
});

// POST /:id/submit
app.post('/:id/submit', requirePermission('banking:create'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const { run } = await submitRun(db, entityId, c.req.param('id'));
    await auditRun(c, db, run, 'submitted', { status: { old: 'draft', new: run.status } });
    runEvent(c, run, 'updated');
    return success(c, await getRunDetail(db, entityId, run.id));
  } catch (err) {
    return respondError(c, err, 'submit payment run');
  }
});

// POST /:id/approve — one approval; the last one makes the payments
app.post('/:id/approve', requirePermission('banking:manage'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const userId = c.get('userId');
    const result = await approveRun(db, { entityId, runId: c.req.param('id'), userId });
    await auditRun(c, db, result.run, 'approved', {
      approvals: { old: result.approvalCount - 1, new: result.approvalCount },
      ...(result.approved ? { status: { old: 'pending_approval', new: result.run.status } } : {}),
    });
    runEvent(c, result.run, result.approved ? 'approved' : 'updated');
    publishPaymentsCreated(c, result.run, result.payments);
    return success(c, {
      run: await getRunDetail(db, entityId, result.run.id),
      approved: result.approved,
      approvalCount: result.approvalCount,
      requiredApprovals: result.run.requiredApprovals,
      payments: result.payments,
    });
  } catch (err) {
    return respondError(c, err, 'approve payment run');
  }
});

// POST /:id/reject — back to draft
app.post('/:id/reject', requirePermission('banking:manage'), zValidator('json', reasonSchema), async (c) => {
  const db = c.get('tenantDb');
  const { reason } = c.req.valid('json');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const run = await rejectRun(db, entityId, c.req.param('id'));
    await auditRun(c, db, run, 'rejected', { reason: { old: null, new: reason }, status: { old: 'pending_approval', new: run.status } });
    runEvent(c, run, 'updated');
    return success(c, await getRunDetail(db, entityId, run.id));
  } catch (err) {
    return respondError(c, err, 'reject payment run');
  }
});

// POST /:id/cancel
app.post('/:id/cancel', requirePermission('banking:create'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const run = await cancelRun(db, entityId, c.req.param('id'));
    await auditRun(c, db, run, 'cancelled', { status: { old: null, new: 'cancelled' } });
    runEvent(c, run, 'updated');
    return success(c, await getRunDetail(db, entityId, run.id));
  } catch (err) {
    return respondError(c, err, 'cancel payment run');
  }
});

// POST /:id/release-hold — let a held vendor into the run
app.post('/:id/release-hold', requirePermission('banking:manage'), zValidator('json', releaseHoldSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const result = await releaseHold(db, {
      entityId,
      runId: c.req.param('id'),
      partyId: data.partyId,
      userId: c.get('userId'),
      reason: data.reason,
    });
    await auditRun(c, db, result.run, 'hold_released', {
      partyId: { old: data.partyId, new: data.partyId },
      holds: { old: result.released.map((h) => h.code), new: 'released' },
      ...(data.reason ? { reason: { old: null, new: data.reason } } : {}),
    });
    runEvent(c, result.run, 'updated');
    return success(c, await getRunDetail(db, entityId, result.run.id));
  } catch (err) {
    return respondError(c, err, 'release hold');
  }
});

// GET /:id/checks — what the platform prints the checks from
app.get('/:id/checks', requirePermission('banking:manage'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const data = await buildCheckPrintData(db, c.env, {
      entityId,
      runId: c.req.param('id'),
      userId: c.get('userId'),
      includePrinted: c.req.query('all') === 'true',
    });
    return success(c, data);
  } catch (err) {
    return respondError(c, err, 'build check print data');
  }
});

// POST /:id/checks/printed — the platform printed these checks
app.post('/:id/checks/printed', requirePermission('banking:manage'), zValidator('json', printedSchema), async (c) => {
  const db = c.get('tenantDb');
  const { paymentIds } = c.req.valid('json');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const result = await markChecksPrinted(db, { entityId, runId: c.req.param('id'), paymentIds });
    await auditRun(c, db, result.run, 'checks_printed', { printed: { old: 0, new: result.printed.length } });
    runEvent(c, result.run, 'updated');
    return success(c, { run: await getRunDetail(db, entityId, result.run.id), printed: result.printed, alreadyPrinted: result.alreadyPrinted });
  } catch (err) {
    return respondError(c, err, 'mark checks printed');
  }
});

// GET /:id/nacha — the file, made on request (vendor account numbers are decrypted and logged)
app.get('/:id/nacha', requirePermission('banking:manage'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const file = await generateNachaFile(db, c.env, { entityId, runId: c.req.param('id'), userId: c.get('userId') });
    await auditRun(c, db, file.run, 'exported', {
      fileName: { old: null, new: file.fileName },
      totalCredit: { old: null, new: file.summary.totalCredit },
    });
    runEvent(c, file.run, 'exported');
    return success(c, { fileName: file.fileName, content: file.content, summary: file.summary });
  } catch (err) {
    return respondError(c, err, 'make NACHA file');
  }
});

// POST /:id/complete — the bank accepted the file
app.post('/:id/complete', requirePermission('banking:manage'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const run = await completeAchRun(db, entityId, c.req.param('id'));
    await auditRun(c, db, run, 'completed', { status: { old: 'exported', new: 'completed' } });
    runEvent(c, run, 'updated');
    return success(c, await getRunDetail(db, entityId, run.id));
  } catch (err) {
    return respondError(c, err, 'complete payment run');
  }
});

export const paymentRunsRoutes = app;
