/**
 * Failures of a payroll posting that belong to the caller's data (a locked
 * period, an account that is not the entity's, totals that do not balance)
 * rather than to the server.
 */

import { ClosedPeriodError, LockedPeriodError } from '@weldsuite/books-domain/accounting-guards';
import { PostingError } from '../accounting-posting';
import { PayrollImportError } from './journal';

export type PayrollFailure = PostingError | ClosedPeriodError | LockedPeriodError | PayrollImportError;

export function isPayrollFailure(err: unknown): err is PayrollFailure {
  return (
    err instanceof PostingError ||
    err instanceof ClosedPeriodError ||
    err instanceof LockedPeriodError ||
    err instanceof PayrollImportError
  );
}
