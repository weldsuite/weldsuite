import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const InvoicePanel = lazy(() =>
  import('./invoice-panel').then((m) => ({ default: m.InvoicePanel })),
);

registerObjectPanel({
  type: 'invoice',
  label: 'Invoice',
  component: InvoicePanel,
});

export { InvoicePanel };
