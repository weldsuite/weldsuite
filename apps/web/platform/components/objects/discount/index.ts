import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const DiscountPanel = lazy(() => import('./discount-panel').then((m) => ({ default: m.DiscountPanel })));

registerObjectPanel({
  type: 'discount',
  label: 'Discount',
  component: DiscountPanel,
});

export { DiscountPanel };
