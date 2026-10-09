/**
 * The employee-facing payroll endpoints, shared by My HR (`/api/weldhr/me`,
 * the signed-in member's own employee) and the workforce portal
 * (`/public/hr-portal/employee`, the session's employee). Only who the
 * employee is differs; the employee id never comes from the request.
 *
 *   GET  /payslips                       final payslips
 *   GET  /payslips/:payslipId/pdf        the PDF (stamps `viewedAt`, audited)
 *   GET  /annual-statements              jaaropgaaf / W-2 per year
 *   GET  /annual-statements/:year        PDF (?employerId=)
 *   GET  /payroll-details                masked details, elections, what is missing
 *   PUT  /payroll-details                identity and bank details; answers with the refreshed details
 *   POST /tax-elections                  sign a loonheffingskorting / W-4 / state certificate; refreshed details
 *
 * All of them answer 404 unless the `weldhr-payroll` flag is on.
 */

import { eq } from 'drizzle-orm';
import type { Hono, MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createHrTaxElectionSchema, hrPayrollPaymentDetailsSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { schema } from '@weldsuite/worker-kit/db';
import { success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../../types';
import { annualStatementPdf, listAnnualStatements } from '../../../services/weldhr/payroll/annual';
import { createElection, myPayrollDetails, setPaymentDetails } from '../../../services/weldhr/payroll/employees';
import { payslipFileName } from '../../../services/weldhr/payroll/format';
import { languageOf, markPayslipViewed, myPayslips, payslipPdf, requirePayslip } from '../../../services/weldhr/payroll/payslips';
import { HrNotFoundError, HrValidationError, recordHrAudit, todayIso } from '../../../services/weldhr/shared';
import { clientIp, db, emit, type HrContext } from '../helpers';
import { payrollDeps } from './deps';
import { pdfResponse } from './responses';

export interface SelfWho {
  employeeId: string;
  /** Audit actor and signer: the Clerk user id, or `portal:<employeeId>`. */
  actor: string;
}

type Resolve = (c: HrContext) => Promise<SelfWho>;

/** Tell the employee their bank details changed, after the response is on its way. Best effort. */
export function notifyBankChange(c: HrContext, employeeId: string, byEmployee: boolean): void {
  const notifier = payrollDeps(c).notifier;
  if (!notifier?.bankChanged) return;
  const database = db(c);
  const task = (async () => {
    const [row] = await database
      .select({ email: schema.hrEmployees.email, firstName: schema.hrEmployees.firstName, lastName: schema.hrEmployees.lastName })
      .from(schema.hrEmployees)
      .where(eq(schema.hrEmployees.id, employeeId))
      .limit(1);
    if (!row) return;
    const [employer] = await database
      .select({ name: schema.hrPayrollEmployers.name, country: schema.hrPayrollEmployers.country, nlSettings: schema.hrPayrollEmployers.nlSettings })
      .from(schema.hrPayrollProfiles)
      .innerJoin(schema.hrPayrollEmployers, eq(schema.hrPayrollEmployers.id, schema.hrPayrollProfiles.employerId))
      .where(eq(schema.hrPayrollProfiles.employeeId, employeeId))
      .limit(1);
    await notifier.bankChanged!({
      employeeId,
      email: row.email,
      name: `${row.firstName} ${row.lastName}`.trim(),
      employerName: employer?.name ?? '',
      byEmployee,
      lang: employer ? languageOf(employer) : 'en',
    });
  })().catch((err) => console.error('[payroll] bank change notification failed:', err instanceof Error ? err.message : err));
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No execution context (tests): the promise runs anyway.
  }
}

export function registerPayrollSelfService(
  router: Hono<{ Bindings: Env; Variables: Variables }>,
  resolve: Resolve,
  guard: MiddlewareHandler,
): void {
  router.get('/payslips', guard, async (c) => {
    const who = await resolve(c);
    return success(c, await myPayslips(db(c), who.employeeId));
  });

  router.get('/payslips/:payslipId/pdf', guard, async (c) => {
    const who = await resolve(c);
    const database = db(c);
    const deps = payrollDeps(c);
    const row = await requirePayslip(database, c.req.param('payslipId'), who.employeeId);
    const bytes = await payslipPdf(database, row, deps);
    await markPayslipViewed(database, row.id, deps.now());
    await recordHrAudit(database, {
      actorId: who.actor,
      action: 'payroll.payslip_viewed',
      employeeId: who.employeeId,
      metadata: { payslipId: row.id },
      ip: clientIp(c),
    });
    return pdfResponse(bytes, payslipFileName(row.country, row));
  });

  router.get('/annual-statements', guard, async (c) => {
    const who = await resolve(c);
    return success(c, await listAnnualStatements(db(c), who.employeeId));
  });

  router.get('/annual-statements/:year', guard, async (c) => {
    const who = await resolve(c);
    const database = db(c);
    const year = Number(c.req.param('year'));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HrValidationError('The year is not valid');
    let employerId = c.req.query('employerId');
    if (!employerId) {
      const options = (await listAnnualStatements(database, who.employeeId)).filter((s) => s.year === year);
      if (options.length === 0) throw new HrNotFoundError('Annual statement', String(year));
      if (options.length > 1) throw new HrValidationError('Say which employer (employerId) the statement is for');
      employerId = options[0]!.employerId;
    }
    const { bytes, fileName } = await annualStatementPdf(database, who.employeeId, year, employerId, payrollDeps(c));
    await recordHrAudit(database, {
      actorId: who.actor,
      action: 'payroll.annual_statement_viewed',
      employeeId: who.employeeId,
      metadata: { year, employerId },
      ip: clientIp(c),
    });
    return pdfResponse(bytes, fileName);
  });

  router.get('/payroll-details', guard, async (c) => {
    const who = await resolve(c);
    return success(c, await myPayrollDetails(db(c), who.employeeId, payrollDeps(c).keyring));
  });

  router.put('/payroll-details', guard, zValidator('json', hrPayrollPaymentDetailsSchema), async (c) => {
    const who = await resolve(c);
    const database = db(c);
    const deps = payrollDeps(c);
    const result = await setPaymentDetails(database, who.employeeId, c.req.valid('json'), { keyring: deps.keyring, selfService: true });
    if (result.changedFields.length) {
      await recordHrAudit(database, {
        actorId: who.actor,
        action: 'payroll.payment_details_updated',
        employeeId: who.employeeId,
        metadata: { fields: result.changedFields, by: 'employee' },
        ip: clientIp(c),
      });
      if (result.bankChanged) {
        await recordHrAudit(database, {
          actorId: who.actor,
          action: 'payroll.bank_changed',
          employeeId: who.employeeId,
          metadata: { fields: result.changedFields.filter((f) => f.startsWith('bank')), by: 'employee' },
          ip: clientIp(c),
        });
        notifyBankChange(c, who.employeeId, true);
      }
      // No field names on the event: which fields changed is itself personal.
      emit(c, 'hr_employee', 'updated', who.employeeId);
    }
    // The full, refreshed details: clients write this straight into their cache.
    return success(c, await myPayrollDetails(database, who.employeeId, deps.keyring));
  });

  router.post('/tax-elections', guard, zValidator('json', createHrTaxElectionSchema), async (c) => {
    const who = await resolve(c);
    const database = db(c);
    const deps = payrollDeps(c);
    const input = c.req.valid('json');
    const today = todayIso(deps.now());
    if (input.effectiveFrom > `${Number(today.slice(0, 4)) + 1}-12-31`) throw new HrValidationError('The effective date is too far ahead');
    const election = await createElection(database, who.employeeId, input, { signedBy: who.actor, source: 'employee', now: deps.now() });
    await recordHrAudit(database, {
      actorId: who.actor,
      action: 'payroll.tax_election_signed',
      employeeId: who.employeeId,
      metadata: { kind: election.kind, state: election.state, electionId: election.id, by: 'employee' },
      ip: clientIp(c),
    });
    return success(c, await myPayrollDetails(database, who.employeeId, deps.keyring, today), 201);
  });
}
