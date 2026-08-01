import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const ProductPanel = lazy(() =>
  import('./product-panel').then((m) => ({ default: m.ProductPanel })),
);

registerObjectPanel({
  type: 'product',
  label: 'Product',
  component: ProductPanel,
});

export { ProductPanel };
