import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const BankAccountPanel = lazy(() =>
  import('./bank-account-panel').then((m) => ({ default: m.BankAccountPanel })),
);

registerObjectPanel({
  type: 'bank_account',
  label: 'Bank account',
  component: BankAccountPanel,
});

export { BankAccountPanel };
