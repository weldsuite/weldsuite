/**
 * Pay run routes.
 *
 *   draft → calculated → approved → paid        (draft | calculated → cancelled)
 *
 * Permissions: reads `payroll:read`; create, inputs, calculate, cancel
 * `payroll:prepare`; approve, mark paid, the payment file and the journal
 * retry `payroll:approve`. Every transition publishes an `hr_pay_run` event
 * (ids and status only); approval also publishes `hr_payslip` `published` per
 * employee, which the workforce portal and My HR use to refresh.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createHrPayRunInputSchema,
  createHrPayRunSchema,
  markHrPayRunPaidSchema,
  setHrPayRunEmployeeSchema,
  updateHrPayRunInputSchema,
  updateHrPayRunSchema,
} from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { noContent, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../../types';
import { approveRun, markRunPaid } from '../../../services/weldhr/payroll/approve';
import { calculateRun } from '../../../services/weldhr/payroll/calculate';
import { buildPaymentFile, buildRunReport } from '../../../services/weldhr/payroll/files';
import { postRunJournal } from '../../../services/weldhr/payroll/journal';
import {
  cancelRun,
  collectRunInputs,
  createRun,
  createRunInput,
  deleteRunInput,
  getRunDetail,
  listRunInputs,
  listRuns,
  setRunEmployee,
  updateRun,
  updateRunInput,
} from '../../../services/weldhr/payroll/runs';
import { recordHrAudit } from '../../../services/weldhr/shared';
import { actor, clientIp, db, emit, param } from '../helpers';
import { payrollDeps } from './deps';
import { generatedFileResponse } from './responses';

export const runsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  employerId: z.string().optional(),
  status: z.string().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

const detail = async (c: Parameters<typeof actor>[0], id: string) => getRunDetail(db(c), id, { userId: actor(c) });

runsRoutes.get('/', requirePermission('payroll:read'), zValidator('query', listQuery), async (c) => success(c, await listRuns(db(c), c.req.valid('query'))));

runsRoutes.get('/:runId', requirePermission('payroll:read'), async (c) => success(c, await detail(c, param(c, 'runId'))));

runsRoutes.post('/', requirePermission('payroll:prepare'), zValidator('json', createHrPayRunSchema), async (c) => {
  const run = await createRun(db(c), c.req.valid('json'), { userId: actor(c) });
  emit(c, 'hr_pay_run', 'created', run.id, { status: run.status });
  return success(c, await detail(c, run.id), 201);
});

runsRoutes.patch('/:runId', requirePermission('payroll:prepare'), zValidator('json', updateHrPayRunSchema), async (c) => {
  const run = await updateRun(db(c), param(c, 'runId'), c.req.valid('json'));
  emit(c, 'hr_pay_run', 'updated', run.id, { status: run.status });
  return success(c, await detail(c, run.id));
});

runsRoutes.post('/:runId/cancel', requirePermission('payroll:prepare'), async (c) => {
  const run = await cancelRun(db(c), param(c, 'runId'));
  emit(c, 'hr_pay_run', 'cancelled', run.id, { status: run.status });
  return success(c, await detail(c, run.id));
});

runsRoutes.post('/:runId/employees', requirePermission('payroll:prepare'), zValidator('json', setHrPayRunEmployeeSchema), async (c) => {
  const body = c.req.valid('json');
  const run = await setRunEmployee(db(c), param(c, 'runId'), body.employeeId, body.excluded);
  emit(c, 'hr_pay_run', 'updated', run.id, { status: run.status });
  return success(c, await detail(c, run.id));
});

runsRoutes.post('/:runId/collect', requirePermission('payroll:prepare'), async (c) => {
  const run = param(c, 'runId');
  await collectRunInputs(db(c), run, payrollDeps(c).keyring, { userId: actor(c) });
  emit(c, 'hr_pay_run', 'updated', run);
  return success(c, await detail(c, run));
});

runsRoutes.get('/:runId/inputs', requirePermission('payroll:read'), zValidator('query', z.object({ employeeId: z.string().optional() })), async (c) =>
  success(c, await listRunInputs(db(c), param(c, 'runId'), c.req.valid('query'))),
);

runsRoutes.post('/:runId/inputs', requirePermission('payroll:prepare'), zValidator('json', createHrPayRunInputSchema), async (c) =>
  success(c, await createRunInput(db(c), param(c, 'runId'), c.req.valid('json'), { userId: actor(c) }), 201),
);

runsRoutes.patch('/:runId/inputs/:inputId', requirePermission('payroll:prepare'), zValidator('json', updateHrPayRunInputSchema), async (c) =>
  success(c, await updateRunInput(db(c), param(c, 'runId'), param(c, 'inputId'), c.req.valid('json'))),
);

runsRoutes.delete('/:runId/inputs/:inputId', requirePermission('payroll:prepare'), async (c) => {
  await deleteRunInput(db(c), param(c, 'runId'), param(c, 'inputId'));
  return noContent(c);
});

runsRoutes.post('/:runId/calculate', requirePermission('payroll:prepare'), async (c) => {
  const run = await calculateRun(db(c), param(c, 'runId'), payrollDeps(c), { userId: actor(c) });
  emit(c, 'hr_pay_run', 'calculated', run.id, { status: run.status });
  return success(c, await detail(c, run.id));
});

runsRoutes.post('/:runId/approve', requirePermission('payroll:approve'), async (c) => {
  const database = db(c);
  const result = await approveRun(database, param(c, 'runId'), payrollDeps(c), { userId: actor(c) });
  await recordHrAudit(database, {
    actorId: actor(c),
    action: 'payroll.run_approved',
    metadata: { runId: result.run.id, payslips: result.payslips.length, journal: result.journal.status },
    ip: clientIp(c),
  });
  emit(c, 'hr_pay_run', 'approved', result.run.id, { status: result.run.status });
  // One signal per employee: the portal and My HR refresh their payslip lists from it.
  for (const slip of result.payslips) emit(c, 'hr_payslip', 'published', slip.id, { employeeId: slip.employeeId, status: 'final' });
  for (const filing of result.filings) emit(c, 'hr_payroll_filing', filing.created ? 'created' : 'updated', filing.id, { status: 'open' });
  return success(c, await detail(c, result.run.id));
});

runsRoutes.post('/:runId/mark-paid', requirePermission('payroll:approve'), zValidator('json', markHrPayRunPaidSchema), async (c) => {
  const database = db(c);
  const result = await markRunPaid(database, param(c, 'runId'), c.req.valid('json'), { userId: actor(c), now: new Date() });
  await recordHrAudit(database, { actorId: actor(c), action: 'payroll.run_paid', metadata: { runId: result.run.id, declarations: result.declarationIds.length }, ip: clientIp(c) });
  emit(c, 'hr_pay_run', 'paid', result.run.id, { status: result.run.status });
  for (const id of result.declarationIds) emit(c, 'hr_declaration', 'paid', id, { status: 'paid' });
  return success(c, await detail(c, result.run.id));
});

// Retry the WeldBooks journal of an approved run (idempotent in books-api).
runsRoutes.post('/:runId/post-journal', requirePermission('payroll:approve'), async (c) => {
  const id = param(c, 'runId');
  await postRunJournal(db(c), id, payrollDeps(c), { userId: actor(c) });
  emit(c, 'hr_pay_run', 'updated', id);
  return success(c, await detail(c, id));
});

runsRoutes.get('/:runId/payment-file', requirePermission('payroll:approve'), async (c) => {
  const id = param(c, 'runId');
  const file = await buildPaymentFile(db(c), id, payrollDeps(c));
  await recordHrAudit(db(c), { actorId: actor(c), action: 'payroll.payment_file_downloaded', metadata: { runId: id, fileName: file.fileName }, ip: clientIp(c) });
  return generatedFileResponse(file);
});

runsRoutes.get('/:runId/report', requirePermission('payroll:read'), async (c) =>
  generatedFileResponse(await buildRunReport(db(c), param(c, 'runId'))),
);
