/**
 * /api/weldhr/employees, /api/weldhr/departments, /api/weldhr/org-chart
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import {
  createHrDepartmentSchema,
  createHrEmployeeSchema,
  hrEmployeeSensitiveSchema,
  listHrEmployeesQuerySchema,
  updateHrDepartmentSchema,
  updateHrEmployeeSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import {
  createDepartment,
  createEmployee,
  deleteDepartment,
  deleteEmployee,
  getEmployeeDetail,
  listDepartments,
  listEmployees,
  orgChart,
  readSensitive,
  toPublicEmployee,
  updateDepartment,
  updateEmployee,
  writeSensitive,
} from '../../services/weldhr/employees';
import { startChecklist } from '../../services/weldhr/lifecycle';
import { recordHrAudit } from '../../services/weldhr/shared';
import { actor, clientIp, db, emit, param } from './helpers';

export const employeesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

employeesRoutes.get('/', requirePermission('employees:read'), zValidator('query', listHrEmployeesQuerySchema), async (c) => {
  const result = await listEmployees(db(c), c.req.valid('query'));
  return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

employeesRoutes.get('/:employeeId', requirePermission('employees:read'), async (c) => {
  return success(c, await getEmployeeDetail(db(c), param(c, 'employeeId')));
});

employeesRoutes.post('/', requirePermission('employees:create'), zValidator('json', createHrEmployeeSchema), async (c) => {
  const { sensitive, onboardingTemplateId, ...input } = c.req.valid('json');
  const database = db(c);

  if (sensitive) {
    if (!(await hasContextPermission(c, 'employees:sensitive'))) {
      return error.forbidden(c, 'You do not have permission to set sensitive employee data');
    }
  }

  const employee = await createEmployee(database, input, {
    createdBy: actor(c),
    sensitive,
    keyring: keyringFromEnv(c.env),
  });
  if (sensitive) {
    await recordHrAudit(database, {
      actorId: actor(c),
      action: 'employee.sensitive_updated',
      employeeId: employee.id,
      metadata: { fields: Object.keys(sensitive) },
      ip: clientIp(c),
    });
  }
  emit(c, 'hr_employee', 'created', employee.id, { status: employee.status });

  if (onboardingTemplateId) {
    const checklist = await startChecklist(database, employee.id, { templateId: onboardingTemplateId }, actor(c));
    emit(c, 'hr_checklist', 'created', checklist.id, { employeeId: employee.id, status: checklist.status });
  }
  return success(c, toPublicEmployee(employee), 201);
});

employeesRoutes.patch('/:employeeId', requirePermission('employees:update'), zValidator('json', updateHrEmployeeSchema), async (c) => {
  const { sensitive, ...input } = c.req.valid('json');
  if (sensitive) {
    return error.badRequest(c, 'Update sensitive data through PUT /employees/:employeeId/sensitive');
  }
  const employee = await updateEmployee(db(c), param(c, 'employeeId'), input);
  emit(c, 'hr_employee', 'updated', employee.id, { status: employee.status });
  return success(c, toPublicEmployee(employee));
});

employeesRoutes.delete('/:employeeId', requirePermission('employees:delete'), async (c) => {
  const id = param(c, 'employeeId');
  await deleteEmployee(db(c), id);
  await recordHrAudit(db(c), { actorId: actor(c), action: 'employee.deleted', employeeId: id, ip: clientIp(c) });
  emit(c, 'hr_employee', 'deleted', id);
  return noContent(c);
});

// Sensitive block — separate permission, every read audited.
employeesRoutes.get('/:employeeId/sensitive', requirePermission('employees:sensitive'), async (c) => {
  const id = param(c, 'employeeId');
  const database = db(c);
  const value = await readSensitive(database, id, keyringFromEnv(c.env));
  await recordHrAudit(database, { actorId: actor(c), action: 'employee.sensitive_viewed', employeeId: id, ip: clientIp(c) });
  return success(c, value);
});

employeesRoutes.put(
  '/:employeeId/sensitive',
  requirePermission('employees:sensitive'),
  zValidator('json', hrEmployeeSensitiveSchema),
  async (c) => {
    const id = param(c, 'employeeId');
    const database = db(c);
    const keyring = keyringFromEnv(c.env);
    const { changedFields } = await writeSensitive(database, id, c.req.valid('json'), keyring);
    if (changedFields.length) {
      await recordHrAudit(database, {
        actorId: actor(c),
        action: 'employee.sensitive_updated',
        employeeId: id,
        metadata: { fields: changedFields },
        ip: clientIp(c),
      });
      // No field names on the event: which fields changed is itself personal.
      emit(c, 'hr_employee', 'updated', id);
    }
    return success(c, await readSensitive(database, id, keyring));
  },
);

export const orgChartRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

orgChartRoutes.get('/', requirePermission('employees:read'), async (c) => success(c, await orgChart(db(c))));

export const departmentsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

departmentsRoutes.get('/', requirePermission('employees:read'), async (c) => success(c, await listDepartments(db(c))));

departmentsRoutes.post('/', requirePermission('employees:manage'), zValidator('json', createHrDepartmentSchema), async (c) => {
  return success(c, await createDepartment(db(c), c.req.valid('json')), 201);
});

departmentsRoutes.patch('/:departmentId', requirePermission('employees:manage'), zValidator('json', updateHrDepartmentSchema), async (c) => {
  return success(c, await updateDepartment(db(c), param(c, 'departmentId'), c.req.valid('json')));
});

departmentsRoutes.delete('/:departmentId', requirePermission('employees:manage'), async (c) => {
  await deleteDepartment(db(c), param(c, 'departmentId'));
  return noContent(c);
});
