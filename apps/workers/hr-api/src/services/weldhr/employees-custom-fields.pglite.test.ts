/**
 * Employee custom fields (TASK-1003 follow-up): writes mirror the
 * `hr_employees.custom_fields` blob into `custom_field_values`
 * (entity type `employee`), and reads hydrate from it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createEmployee, getEmployeeDetail, listEmployees, updateEmployee } from './employees';
import { HrValidationError } from './shared';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values(
    ['ann', 'ben', 'cas', 'dee'].map((name) => ({
      id: `wm_cf_${name}`,
      userId: `user_cf_${name}`,
      name: `${name} Example`,
      email: `${name}@example.com`,
      status: 'ACTIVE',
      memberType: 'INTERNAL',
    })),
  );
  await db.insert(schema.customFieldDefinitions).values([
    { id: 'cfd_emp_shirt', entityType: 'employee', name: 'Shirt size', slug: 'shirt_size', fieldType: 'single_select', options: [{ label: 'M', value: 'm' }, { label: 'L', value: 'l' }] },
    { id: 'cfd_emp_badge', entityType: 'employee', name: 'Badge number', slug: 'badge', fieldType: 'number' },
  ]);
}, 60_000);

function newEmployee(name: string, customFields?: Record<string, unknown>) {
  return createEmployee(
    db,
    { firstName: name, lastName: 'Example', email: `${name}@example.com`, userId: `user_cf_${name}`, customFields },
    { createdBy: 'user_admin' },
  );
}

async function storedValues(employeeId: string) {
  return db
    .select()
    .from(schema.customFieldValues)
    .where(and(eq(schema.customFieldValues.entityType, 'employee'), eq(schema.customFieldValues.entityId, employeeId)));
}

describe('employee custom fields', () => {
  it('createEmployee mirrors the values into custom_field_values', async () => {
    const employee = await newEmployee('ann', { shirt_size: 'm', badge: '1042' });
    const rows = await storedValues(employee.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.fieldId === 'cfd_emp_badge')?.valueNumber).toBe(1042);

    // The detail is hydrated from the typed table (badge coerced to a number).
    const detail = await getEmployeeDetail(db, employee.id);
    expect(detail.customFields).toEqual({ shirt_size: 'm', badge: 1042 });
  });

  it('updateEmployee replaces the set and the list hydrates it', async () => {
    const employee = await newEmployee('ben', { shirt_size: 'l', badge: 7 });
    await updateEmployee(db, employee.id, { customFields: { shirt_size: 'm' } });

    expect(await storedValues(employee.id)).toHaveLength(1);
    const { data } = await listEmployees(db, { search: 'ben' });
    expect(data.find((e) => e.id === employee.id)?.customFields).toEqual({ shirt_size: 'm' });
  });

  it('an update that does not send customFields leaves the values alone', async () => {
    const employee = await newEmployee('cas', { badge: 3 });
    await updateEmployee(db, employee.id, { jobTitle: 'Engineer' });
    expect(await storedValues(employee.id)).toHaveLength(1);
    expect((await getEmployeeDetail(db, employee.id)).customFields).toEqual({ badge: 3 });
  });

  it('refuses an invalid value before writing anything', async () => {
    const employee = await newEmployee('dee', { shirt_size: 'l' });
    await expect(
      updateEmployee(db, employee.id, { jobTitle: 'Changed', customFields: { shirt_size: 'xxl' } }),
    ).rejects.toBeInstanceOf(HrValidationError);

    const detail = await getEmployeeDetail(db, employee.id);
    expect(detail.jobTitle).toBeNull();
    expect(detail.customFields).toEqual({ shirt_size: 'l' });
  });
});
