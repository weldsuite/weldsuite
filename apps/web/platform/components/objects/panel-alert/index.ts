import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { PANEL_ALERT_TYPE } from './panel-alert-tabs';

// Lazy-loaded so the panel body only ships when actually opened.
const PanelAlertPanel = lazy(() => import('./panel-alert-panel').then((m) => ({ default: m.PanelAlertPanel })));

registerObjectPanel({
  type: PANEL_ALERT_TYPE,
  label: 'Alert',
  component: PanelAlertPanel,
});
