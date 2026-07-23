import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const PersonPanel = lazy(() =>
  import('./person-panel').then((m) => ({ default: m.PersonPanel })),
);

registerObjectPanel({
  type: 'person',
  label: 'Person',
  component: PersonPanel,
});

;
