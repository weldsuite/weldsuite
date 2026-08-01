import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const CategoryPanel = lazy(() =>
  import('./category-panel').then((m) => ({ default: m.CategoryPanel })),
);

registerObjectPanel({
  type: 'category',
  label: 'Category',
  component: CategoryPanel,
});

export { CategoryPanel };
