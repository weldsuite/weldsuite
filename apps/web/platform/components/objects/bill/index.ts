import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const BillPanel = lazy(() =>
  import('./bill-panel').then((m) => ({ default: m.BillPanel })),
);

registerObjectPanel({
  type: 'bill',
  label: 'Bill',
  component: BillPanel,
});

export { BillPanel };
