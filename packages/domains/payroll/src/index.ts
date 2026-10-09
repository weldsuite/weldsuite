/**
 * @weldsuite/payroll-domain — WeldSuite's payroll engines (NL and US), pay
 * periods, payment files and payslip documents. Pure functions; no database.
 * Contract: ./types.ts.
 */

import { calculateNlPayslip } from './nl';
import { calculateUsPayslip } from './us';
import type { PayslipInput, PayslipResult } from './types';

export * from './types';
export { PAY_COMPONENTS, componentDef, componentsFor, ISSUE_CODES, type ComponentDef, type IssueCode } from './components';

/** Calculate one employee's payslip for one period. */
export function calculatePayslip(input: PayslipInput): PayslipResult {
  return input.country === 'NL' ? calculateNlPayslip(input) : calculateUsPayslip(input);
}
