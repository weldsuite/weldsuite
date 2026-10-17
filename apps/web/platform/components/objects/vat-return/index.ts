import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const VatReturnPanel = lazy(() =>
  import('./vat-return-panel').then((m) => ({ default: m.VatReturnPanel })),
);

registerObjectPanel({
  type: 'vat_return',
  label: 'VAT return',
  component: VatReturnPanel,
});

export { VatReturnPanel };
