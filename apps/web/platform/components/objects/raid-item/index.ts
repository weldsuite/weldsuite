import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { RAID_ITEM_PANEL_TYPE } from '@/app/weldflow/project/[projectId]/raid/_components/raid-item-panel-type';

// Lazy-loaded so the panel body only ships when an item is opened.
const RaidItemPanel = lazy(() =>
  import('@/app/weldflow/project/[projectId]/raid/_components/raid-item-panel').then((m) => ({ default: m.RaidItemPanel })),
);

registerObjectPanel({
  type: RAID_ITEM_PANEL_TYPE,
  label: 'RAID item',
  component: RaidItemPanel,
});
