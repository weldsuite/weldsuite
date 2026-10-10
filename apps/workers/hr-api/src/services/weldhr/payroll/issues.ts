/**
 * Builder issues, structured. The SEPA, NACHA and loonaangifte builders
 * report problems as `PayrollIssue`s (`invalid_iban`, `invalid_routing_number`,
 * `invalid_bsn`…) with params that name what they were about (a payment's
 * id, an income-relationship number). The API hands them on as
 * `HrPayrollIssue`s with the employee attached where it can tell, instead of
 * flattening them into a message: clients translate
 * `weldhr.payroll.issues.<code>` with the params.
 */

import type { HrPayrollIssue } from '@weldsuite/db/schema';
import type { PayrollIssue } from '@weldsuite/payroll-domain/types';
import { HrPayrollError } from '../shared';
import { sortIssues } from './common';

/** Which employee a param value points at, or undefined. */
export type IssueAttribution = (key: string, value: string | number) => string | undefined;

export function structuredIssues(issues: PayrollIssue[], attribute?: IssueAttribution): HrPayrollIssue[] {
  return sortIssues(
    issues.map((issue) => {
      let employeeId: string | undefined;
      if (attribute && issue.params) {
        for (const [key, value] of Object.entries(issue.params)) {
          employeeId = attribute(key, value);
          if (employeeId) break;
        }
      }
      return {
        severity: issue.severity,
        code: issue.code,
        ...(employeeId ? { employeeId } : {}),
        ...(issue.params ? { params: issue.params } : {}),
      };
    }),
  );
}

/** 422 with the issues structured in `error.details.issues`. */
export function invalidWith(code: string, message: string, issues: HrPayrollIssue[]): HrPayrollError {
  return new HrPayrollError(code, message, 422, { issues });
}

/** 409 for something the employer has to fill in first, structured the same way. */
export function incomplete(message: string, field: string): HrPayrollError {
  return new HrPayrollError('EMPLOYER_INCOMPLETE', message, 409, {
    issues: [{ severity: 'error', code: 'employer_incomplete', params: { field } }] satisfies HrPayrollIssue[],
  });
}
