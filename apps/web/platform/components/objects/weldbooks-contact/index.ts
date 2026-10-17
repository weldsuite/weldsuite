import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const WeldbooksContactPanel = lazy(() =>
  import('./weldbooks-contact-panel').then((m) => ({ default: m.WeldbooksContactPanel })),
);

registerObjectPanel({
  type: 'weldbooks_contact',
  label: 'WeldBooks contact',
  component: WeldbooksContactPanel,
});

export { WeldbooksContactPanel };
