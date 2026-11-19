import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { PANEL_PERSON_TYPE } from './panel-person-tabs';

// Lazy-loaded so the panel body only ships when actually opened.
const PanelPersonPanel = lazy(() => import('./panel-person-panel').then((m) => ({ default: m.PanelPersonPanel })));

registerObjectPanel({
  type: PANEL_PERSON_TYPE,
  label: 'Person',
  component: PanelPersonPanel,
});
