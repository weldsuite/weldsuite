import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const CompanyPanel = lazy(() =>
  import('./company-panel').then((m) => ({ default: m.CompanyPanel })),
);

registerObjectPanel({
  type: 'company',
  label: 'Company',
  component: CompanyPanel,
});

;
