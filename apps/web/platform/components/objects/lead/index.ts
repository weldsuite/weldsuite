import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const LeadPanel = lazy(() =>
  import('./lead-panel').then((m) => ({ default: m.LeadPanel })),
);

registerObjectPanel({
  type: 'lead',
  label: 'Lead',
  component: LeadPanel,
});

export { LeadPanel };
