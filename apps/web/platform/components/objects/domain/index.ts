import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const DomainPanel = lazy(() =>
  import('./domain-panel').then((m) => ({ default: m.DomainPanel })),
);

registerObjectPanel({
  type: 'domain',
  label: 'Domain',
  component: DomainPanel,
});

export { DomainPanel };
