import { createFileRoute } from '@tanstack/react-router';
import GeneralLedgerPage from '@/app/weldbooks/reports/general-ledger/page';

interface GeneralLedgerSearch {
  /** Opens the ledger of this account. */
  accountId?: string;
  from?: string;
  to?: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export const Route = createFileRoute('/weldbooks/reports/general-ledger/')({
  validateSearch: (search: Record<string, unknown>): GeneralLedgerSearch => ({
    accountId: text(search.accountId),
    from: text(search.from),
    to: text(search.to),
  }),
  component: GeneralLedgerPage,
});
