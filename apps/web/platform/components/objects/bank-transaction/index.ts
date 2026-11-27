import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host wraps the renderer in <Suspense>).
const BankTransactionPanel = lazy(() =>
  import('./bank-transaction-panel').then((m) => ({ default: m.BankTransactionPanel })),
);

registerObjectPanel({
  type: 'bank_transaction',
  label: 'Bank transaction',
  component: BankTransactionPanel,
});

export { BankTransactionPanel };
