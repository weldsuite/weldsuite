import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

const ParcelPanel = lazy(() =>
  import('./parcel-panel').then((m) => ({ default: m.ParcelPanel })),
);

registerObjectPanel({
  type: 'parcel',
  label: 'Parcel',
  component: ParcelPanel,
});

export { ParcelPanel };
