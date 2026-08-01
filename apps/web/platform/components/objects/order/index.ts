import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const OrderPanel = lazy(() =>
  import('./order-panel').then((m) => ({ default: m.OrderPanel })),
);

registerObjectPanel({
  type: 'order',
  label: 'Order',
  component: OrderPanel,
});

export { OrderPanel };
