import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const RecurringInvoicePanel = lazy(() =>
  import('./recurring-invoice-panel').then((m) => ({ default: m.RecurringInvoicePanel })),
);

registerObjectPanel({
  type: 'recurring_invoice',
  label: 'Recurring invoice',
  component: RecurringInvoicePanel,
});

export { RecurringInvoicePanel };
