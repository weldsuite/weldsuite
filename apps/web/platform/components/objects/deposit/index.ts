import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const DepositPanel = lazy(() =>
  import('./deposit-panel').then((m) => ({ default: m.DepositPanel })),
);

registerObjectPanel({
  type: 'deposit',
  label: 'Deposit',
  component: DepositPanel,
});

export { DepositPanel };
