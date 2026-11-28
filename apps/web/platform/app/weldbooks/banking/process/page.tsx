/**
 * Bank → Transactions → To process. Where the edition offers
 * `books-bank-processing` (the Rust backend) this is the processing view; on
 * Global the reconcile screen stays as it is.
 */

import { isBankProcessingAvailable } from '@/hooks/queries/use-weldbooks-processing-queries';
import BankReconciliationPage from '../reconciliation/page';
import { ProcessView } from './process-view';

export default function BankProcessPage() {
  return isBankProcessingAvailable() ? <ProcessView /> : <BankReconciliationPage />;
}
