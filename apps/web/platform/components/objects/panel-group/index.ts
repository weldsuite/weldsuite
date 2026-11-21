import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { PANEL_GROUP_TYPE } from './panel-group-tabs';

// Lazy-loaded so the panel body only ships when actually opened.
const PanelGroupPanel = lazy(() => import('./panel-group-panel').then((m) => ({ default: m.PanelGroupPanel })));

registerObjectPanel({
  type: PANEL_GROUP_TYPE,
  label: 'Group',
  component: PanelGroupPanel,
});
