import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const SalesTaxAgencyPanel = lazy(() =>
  import('./sales-tax-agency-panel').then((m) => ({ default: m.SalesTaxAgencyPanel })),
);

registerObjectPanel({
  type: 'sales_tax_agency',
  label: 'Sales tax agency',
  component: SalesTaxAgencyPanel,
});

export { SalesTaxAgencyPanel };
