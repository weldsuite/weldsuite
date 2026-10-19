import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const FixedAssetPanel = lazy(() =>
  import('./fixed-asset-panel').then((m) => ({ default: m.FixedAssetPanel })),
);

registerObjectPanel({
  type: 'fixed_asset',
  label: 'Fixed asset',
  component: FixedAssetPanel,
});

export { FixedAssetPanel };
