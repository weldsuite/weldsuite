import { ChartNoAxesGantt, History } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/** Object-panel type of a WeldPanel alert, the `stack=` value of its deep links. */
export const PANEL_ALERT_TYPE = 'panel_alert';

export type PanelAlertTabId = 'overview' | 'history';

export const PANEL_ALERT_TAB_ICONS: Record<PanelAlertTabId, ObjectPanelTabDescriptor['icon']> = {
  overview: ChartNoAxesGantt,
  history: History,
};

export function isPanelAlertTabId(value: string | undefined): value is PanelAlertTabId {
  return !!value && Object.hasOwn(PANEL_ALERT_TAB_ICONS, value);
}

/** The Alerts list with this alert's panel open, on the tab the link asks for. */
export function panelAlertHref(alertId: string, tab?: PanelAlertTabId): string {
  const parts = [PANEL_ALERT_TYPE, encodeURIComponent(alertId)];
  if (tab) parts.push(`tab=${tab}`);
  return `/weldpanel/alerts?stack=${parts.join(':')}`;
}
