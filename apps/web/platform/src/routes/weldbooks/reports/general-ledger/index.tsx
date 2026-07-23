import { createFileRoute } from '@tanstack/react-router';
import GeneralLedgerPage from '@/app/weldbooks/reports/general-ledger/page';

export const Route = createFileRoute('/weldbooks/reports/general-ledger/')({
  component: GeneralLedgerPage,
});
