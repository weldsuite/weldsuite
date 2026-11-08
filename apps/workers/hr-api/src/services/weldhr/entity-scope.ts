/**
 * Entity scoping for WeldHR queries (docs/plans/legal-entities.md): every HR
 * record belongs to the legal entity of its employee, and payroll setup to the
 * entity of its employer.
 *
 * The routes turn the request into one SQL condition on `hr_employees.
 * legal_entity_id` (or `hr_payroll_employers.legal_entity_id`); these helpers
 * apply it to a table through its employee or employer column, so a service
 * takes one optional `SQL` and adds it to its filters. No condition means no
 * filter (the member's access is the same everywhere).
 */

import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';

/** `column in (select id from hr_employees where <entity condition>)`. Undefined without a condition. */
export function employeeIdIn(column: AnyColumn, employeeCondition: SQL | undefined): SQL | undefined {
  if (!employeeCondition) return undefined;
  return sql`${column} in (select ${schema.hrEmployees.id} from ${schema.hrEmployees} where ${employeeCondition})`;
}

/** `column in (select id from hr_payroll_employers where <entity condition>)`. Undefined without a condition. */
export function employerIdIn(column: AnyColumn, employerCondition: SQL | undefined): SQL | undefined {
  if (!employerCondition) return undefined;
  return sql`${column} in (select ${schema.hrPayrollEmployers.id} from ${schema.hrPayrollEmployers} where ${employerCondition})`;
}
