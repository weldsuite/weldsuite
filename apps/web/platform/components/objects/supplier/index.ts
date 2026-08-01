import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const SupplierPanel = lazy(() =>
  import('./supplier-panel').then((m) => ({ default: m.SupplierPanel })),
);

registerObjectPanel({
  type: 'supplier',
  label: 'Supplier',
  component: SupplierPanel,
});

export { SupplierPanel };
