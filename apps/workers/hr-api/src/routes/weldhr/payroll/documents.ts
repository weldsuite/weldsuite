/**
 * Payslip and filing routes.
 *
 * Permissions: reads and payslip downloads `payroll:read`; generating,
 * submitting, refreshing, marking and DOWNLOADING filings `payroll:manage`
 * (the files carry full BSN / SSN numbers; downloads are audited).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { markHrPayrollFilingFiledSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../../types';
import { filingFile, generateFiling, getFiling, listFilings, markFilingFiled, refreshFilingStatus, submitFiling } from '../../../services/weldhr/payroll/filings';
import { payslipFileName } from '../../../services/weldhr/payroll/format';
import { getPayslip, payslipPdf, requirePayslip } from '../../../services/weldhr/payroll/payslips';
import { recordHrAudit } from '../../../services/weldhr/shared';
import { actor, clientIp, db, emit, param } from '../helpers';
import { payrollDeps, sendingAvailable } from './deps';
import { objectResponse, pdfResponse } from './responses';

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

export const payslipsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

payslipsRoutes.get('/:payslipId', requirePermission('payroll:read'), async (c) => success(c, await getPayslip(db(c), param(c, 'payslipId'))));

// A final payslip is the stored PDF; a draft is rendered on the fly with a "draft" watermark.
payslipsRoutes.get('/:payslipId/pdf', requirePermission('payroll:read'), async (c) => {
  const row = await requirePayslip(db(c), param(c, 'payslipId'));
  return pdfResponse(await payslipPdf(db(c), row, payrollDeps(c)), payslipFileName(row.country, row));
});

// ---------------------------------------------------------------------------
// Filings
// ---------------------------------------------------------------------------

export const filingsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  employerId: z.string().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  status: z.string().optional(),
  kind: z.string().optional(),
});

filingsRoutes.get('/', requirePermission('payroll:read'), zValidator('query', listQuery), async (c) =>
  success(c, await listFilings(db(c), c.req.valid('query'), (await sendingAvailable(c)).available)),
);

filingsRoutes.get('/:filingId', requirePermission('payroll:read'), async (c) =>
  success(c, await getFiling(db(c), param(c, 'filingId'), (await sendingAvailable(c)).available)),
);

filingsRoutes.post('/:filingId/generate', requirePermission('payroll:manage'), async (c) => {
  const row = await generateFiling(db(c), param(c, 'filingId'), payrollDeps(c), { userId: actor(c) });
  emit(c, 'hr_payroll_filing', 'updated', row.id, { status: row.status });
  return success(c, await getFiling(db(c), row.id, (await sendingAvailable(c)).available));
});

// The generated file (XML, PDF or CSV); `?name=` picks one of the extra files stored beside it. It holds every
// employee's full BSN / SSN, so it takes `payroll:manage` (not `payroll:read`) and every download is audited.
filingsRoutes.get('/:filingId/file', requirePermission('payroll:manage'), async (c) => {
  const file = await filingFile(db(c), param(c, 'filingId'), payrollDeps(c), c.req.query('name'));
  await recordHrAudit(db(c), {
    actorId: actor(c),
    action: 'payroll.filing_downloaded',
    metadata: { filingId: param(c, 'filingId'), fileName: file.fileName },
    ip: clientIp(c),
  });
  return objectResponse(file.object, file.fileName, file.contentType);
});

filingsRoutes.post('/:filingId/submit', requirePermission('payroll:manage'), async (c) => {
  const sending = await sendingAvailable(c);
  const row = await submitFiling(db(c), param(c, 'filingId'), payrollDeps(c), { userId: actor(c), flagOn: sending.flagOn });
  await recordHrAudit(db(c), { actorId: actor(c), action: 'payroll.filing_submitted', metadata: { filingId: row.id, reference: row.externalReference }, ip: clientIp(c) });
  emit(c, 'hr_payroll_filing', 'submitted', row.id, { status: row.status });
  return success(c, await getFiling(db(c), row.id, sending.available));
});

filingsRoutes.post('/:filingId/refresh-status', requirePermission('payroll:manage'), async (c) => {
  const sending = await sendingAvailable(c);
  const row = await refreshFilingStatus(db(c), param(c, 'filingId'), payrollDeps(c), { userId: actor(c), flagOn: sending.flagOn });
  emit(c, 'hr_payroll_filing', 'updated', row.id, { status: row.status });
  return success(c, await getFiling(db(c), row.id, sending.available));
});

filingsRoutes.post('/:filingId/mark-filed', requirePermission('payroll:manage'), zValidator('json', markHrPayrollFilingFiledSchema), async (c) => {
  const row = await markFilingFiled(db(c), param(c, 'filingId'), c.req.valid('json'), { userId: actor(c), now: new Date() });
  await recordHrAudit(db(c), { actorId: actor(c), action: 'payroll.filing_filed', metadata: { filingId: row.id, reference: row.externalReference }, ip: clientIp(c) });
  emit(c, 'hr_payroll_filing', 'updated', row.id, { status: row.status });
  return success(c, await getFiling(db(c), row.id, (await sendingAvailable(c)).available));
});
