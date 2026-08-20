import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

const PickListPanel = lazy(() =>
  import('./pick-list-panel').then((m) => ({ default: m.PickListPanel })),
);

registerObjectPanel({
  type: 'pick-list',
  label: 'Pick list',
  component: PickListPanel,
});

export { PickListPanel };
