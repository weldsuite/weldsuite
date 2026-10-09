/**
 * Payroll setup routes: employers, pay schedules, and everything per
 * employee (profile, compensation, components, tax elections, payment
 * details, their payslips and annual statements).
 *
 * Permissions: reads `payroll:read`; employee setup `payroll:prepare`;
 * employers and schedules `payroll:manage`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createHrCompensationSchema,
  createHrPayComponentSchema,
  createHrPayScheduleSchema,
  createHrPayrollEmployerSchema,
  createHrTaxElectionSchema,
  hrPayrollEmployerBankSchema,
  hrPayrollPaymentDetailsSchema,
  updateHrPayComponentSchema,
  updateHrPayScheduleSchema,
  updateHrPayrollEmployerSchema,
  upsertHrPayrollProfileSchema,
} from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { noContent, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../../types';
import { annualStatementPdf, listAnnualStatements } from '../../../services/weldhr/payroll/annual';
import {
  createComponent,
  createCompensation,
  createElection,
  deleteCompensation,
  deleteComponent,
  getPayrollEmployee,
  listElections,
  listPayrollEmployees,
  setPaymentDetails,
  updateComponent,
  upsertProfile,
} from '../../../services/weldhr/payroll/employees';
import { createEmployer, deleteEmployer, getEmployer, listEmployers, setEmployerBank, updateEmployer } from '../../../services/weldhr/payroll/employers';
import { listEmployeePayslips } from '../../../services/weldhr/payroll/payslips';
import { createSchedule, deleteSchedule, listSchedules, updateSchedule } from '../../../services/weldhr/payroll/schedules';
import { HrValidationError, recordHrAudit } from '../../../services/weldhr/shared';
import { actor, clientIp, db, emit, param } from '../helpers';
import { payrollDeps } from './deps';
import { pdfResponse } from './responses';
import { notifyBankChange } from './self-service';

type App = Hono<{ Bindings: Env; Variables: Variables }>;
const newApp = (): App => new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Employers
// ---------------------------------------------------------------------------

export const employersRoutes = newApp();

employersRoutes.get('/', requirePermission('payroll:read'), async (c) => success(c, await listEmployers(db(c), payrollDeps(c).keyring)));

employersRoutes.get('/:employerId', requirePermission('payroll:read'), async (c) =>
  success(c, await getEmployer(db(c), param(c, 'employerId'), payrollDeps(c).keyring)),
);

employersRoutes.post('/', requirePermission('payroll:manage'), zValidator('json', createHrPayrollEmployerSchema), async (c) =>
  success(c, await createEmployer(db(c), c.req.valid('json'), { createdBy: actor(c), keyring: payrollDeps(c).keyring }), 201),
);

employersRoutes.patch('/:employerId', requirePermission('payroll:manage'), zValidator('json', updateHrPayrollEmployerSchema), async (c) =>
  success(c, await updateEmployer(db(c), param(c, 'employerId'), c.req.valid('json'), payrollDeps(c).keyring)),
);

employersRoutes.delete('/:employerId', requirePermission('payroll:manage'), async (c) => {
  await deleteEmployer(db(c), param(c, 'employerId'));
  return noContent(c);
});

// The salary account: write-only, masked on every read, every change audited (names of fields only).
employersRoutes.put('/:employerId/bank', requirePermission('payroll:manage'), zValidator('json', hrPayrollEmployerBankSchema), async (c) => {
  const { employer, changedFields } = await setEmployerBank(db(c), param(c, 'employerId'), c.req.valid('json'), payrollDeps(c).keyring);
  if (changedFields.length) {
    await recordHrAudit(db(c), {
      actorId: actor(c),
      action: 'payroll.employer_bank_updated',
      metadata: { employerId: employer.id, fields: changedFields },
      ip: clientIp(c),
    });
  }
  return success(c, employer);
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export const schedulesRoutes = newApp();

schedulesRoutes.get('/', requirePermission('payroll:read'), zValidator('query', z.object({ employerId: z.string().optional() })), async (c) =>
  success(c, await listSchedules(db(c), c.req.valid('query'))),
);

schedulesRoutes.post('/', requirePermission('payroll:manage'), zValidator('json', createHrPayScheduleSchema), async (c) =>
  success(c, await createSchedule(db(c), c.req.valid('json')), 201),
);

schedulesRoutes.patch('/:scheduleId', requirePermission('payroll:manage'), zValidator('json', updateHrPayScheduleSchema), async (c) =>
  success(c, await updateSchedule(db(c), param(c, 'scheduleId'), c.req.valid('json'))),
);

schedulesRoutes.delete('/:scheduleId', requirePermission('payroll:manage'), async (c) => {
  await deleteSchedule(db(c), param(c, 'scheduleId'));
  return noContent(c);
});

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export const employeesRoutes = newApp();

const listEmployeesQuery = z.object({
  employerId: z.string().optional(),
  onPayroll: z.enum(['true', 'false']).optional(),
});

employeesRoutes.get('/', requirePermission('payroll:read'), zValidator('query', listEmployeesQuery), async (c) => {
  const q = c.req.valid('query');
  return success(c, await listPayrollEmployees(db(c), { employerId: q.employerId, onPayroll: q.onPayroll === undefined ? undefined : q.onPayroll === 'true' }, payrollDeps(c).keyring));
});

employeesRoutes.get('/:employeeId', requirePermission('payroll:read'), async (c) =>
  success(c, await getPayrollEmployee(db(c), param(c, 'employeeId'), payrollDeps(c).keyring)),
);

employeesRoutes.put('/:employeeId/profile', requirePermission('payroll:prepare'), zValidator('json', upsertHrPayrollProfileSchema), async (c) =>
  success(c, await upsertProfile(db(c), param(c, 'employeeId'), c.req.valid('json'))),
);

employeesRoutes.put('/:employeeId/payment-details', requirePermission('payroll:prepare'), zValidator('json', hrPayrollPaymentDetailsSchema), async (c) => {
  const employeeId = param(c, 'employeeId');
  const database = db(c);
  const result = await setPaymentDetails(database, employeeId, c.req.valid('json'), { keyring: payrollDeps(c).keyring, selfService: false });
  if (result.changedFields.length) {
    await recordHrAudit(database, {
      actorId: actor(c),
      action: 'payroll.payment_details_updated',
      employeeId,
      metadata: { fields: result.changedFields, by: 'admin' },
      ip: clientIp(c),
    });
    if (result.bankChanged) {
      // Changed bank details are the classic payroll fraud: leave a trail and tell the employee.
      await recordHrAudit(database, {
        actorId: actor(c),
        action: 'payroll.bank_changed',
        employeeId,
        metadata: { fields: result.changedFields.filter((f) => f.startsWith('bank')), by: 'admin' },
        ip: clientIp(c),
      });
      notifyBankChange(c, employeeId, false);
    }
    emit(c, 'hr_employee', 'updated', employeeId);
  }
  return success(c, result.details);
});

employeesRoutes.post('/:employeeId/compensations', requirePermission('payroll:prepare'), zValidator('json', createHrCompensationSchema), async (c) =>
  success(c, await createCompensation(db(c), param(c, 'employeeId'), c.req.valid('json'), { createdBy: actor(c) }), 201),
);

employeesRoutes.post('/:employeeId/components', requirePermission('payroll:prepare'), zValidator('json', createHrPayComponentSchema), async (c) =>
  success(c, await createComponent(db(c), param(c, 'employeeId'), c.req.valid('json'), { createdBy: actor(c) }), 201),
);

employeesRoutes.get('/:employeeId/tax-elections', requirePermission('payroll:read'), async (c) =>
  success(c, await listElections(db(c), param(c, 'employeeId'))),
);

// HR enters a paper form: source `admin`, signed by the member who entered it, in the signer's typed name.
employeesRoutes.post('/:employeeId/tax-elections', requirePermission('payroll:prepare'), zValidator('json', createHrTaxElectionSchema), async (c) => {
  const employeeId = param(c, 'employeeId');
  const election = await createElection(db(c), employeeId, c.req.valid('json'), { signedBy: actor(c), source: 'admin', now: payrollDeps(c).now() });
  await recordHrAudit(db(c), {
    actorId: actor(c),
    action: 'payroll.tax_election_signed',
    employeeId,
    metadata: { kind: election.kind, state: election.state, electionId: election.id, by: 'admin' },
    ip: clientIp(c),
  });
  return success(c, election, 201);
});

employeesRoutes.get('/:employeeId/payslips', requirePermission('payroll:read'), async (c) =>
  success(c, await listEmployeePayslips(db(c), param(c, 'employeeId'))),
);

employeesRoutes.get('/:employeeId/annual-statements', requirePermission('payroll:read'), async (c) =>
  success(c, await listAnnualStatements(db(c), param(c, 'employeeId'))),
);

employeesRoutes.get('/:employeeId/annual-statements/:year', requirePermission('payroll:read'), async (c) => {
  const year = Number(param(c, 'year'));
  const employerId = c.req.query('employerId');
  if (!Number.isInteger(year) || !employerId) throw new HrValidationError('Give the year and ?employerId=');
  const { bytes, fileName } = await annualStatementPdf(db(c), param(c, 'employeeId'), year, employerId, payrollDeps(c));
  // The statement carries the employee's BSN / SSN: reading it is on record.
  await recordHrAudit(db(c), {
    actorId: actor(c),
    action: 'payroll.annual_statement_viewed',
    employeeId: param(c, 'employeeId'),
    metadata: { year, employerId, by: 'payroll' },
    ip: clientIp(c),
  });
  return pdfResponse(bytes, fileName);
});

// ---------------------------------------------------------------------------
// Compensation and component rows by id
// ---------------------------------------------------------------------------

export const compensationsRoutes = newApp();

compensationsRoutes.delete('/:compensationId', requirePermission('payroll:prepare'), async (c) => {
  await deleteCompensation(db(c), param(c, 'compensationId'));
  return noContent(c);
});

export const componentsRoutes = newApp();

componentsRoutes.patch('/:componentId', requirePermission('payroll:prepare'), zValidator('json', updateHrPayComponentSchema), async (c) =>
  success(c, await updateComponent(db(c), param(c, 'componentId'), c.req.valid('json'))),
);

componentsRoutes.delete('/:componentId', requirePermission('payroll:prepare'), async (c) => {
  await deleteComponent(db(c), param(c, 'componentId'));
  return noContent(c);
});
