import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const QuotePanel = lazy(() => import('./quote-panel').then((m) => ({ default: m.QuotePanel })));

registerObjectPanel({
  type: 'quote',
  label: 'Quote',
  component: QuotePanel,
});

export { QuotePanel };
