import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const OpportunityPanel = lazy(() =>
  import('./opportunity-panel').then((m) => ({ default: m.OpportunityPanel })),
);

registerObjectPanel({
  type: 'opportunity',
  label: 'Opportunity',
  component: OpportunityPanel,
});

export { OpportunityPanel };
