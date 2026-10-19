import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const LedgerAccountPanel = lazy(() =>
  import('./ledger-account-panel').then((m) => ({ default: m.LedgerAccountPanel })),
);

registerObjectPanel({
  type: 'ledger_account',
  label: 'Ledger account',
  component: LedgerAccountPanel,
});

export { LedgerAccountPanel };
