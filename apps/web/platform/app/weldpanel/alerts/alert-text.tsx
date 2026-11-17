/** How an alert reads in the list, the detail sheet and the side panel. */

import type { PanelAlertCondition, PanelAlertDto, PanelAlertState } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { useI18n } from '@/lib/i18n/provider';
import { formatNumber } from '../lib/format';

const STATE_TONES: Record<PanelAlertState, SoftTone> = { pending: 'neutral', ok: 'success', firing: 'danger', error: 'warning' };

export function AlertStateBadge({ alert }: Readonly<{ alert: Pick<PanelAlertDto, 'state' | 'enabled'> }>) {
  const { t } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  if (!alert.enabled) return <SoftBadge tone="neutral">{ta.disabled}</SoftBadge>;
  return <SoftBadge tone={STATE_TONES[alert.state]}>{ta.states[alert.state]}</SoftBadge>;
}

/** "Above 1,000", "Down 20% or more", "Unusual (medium sensitivity)". */
export function useConditionText(): (condition: PanelAlertCondition) => string {
  const { t, language, format } = useI18n();
  const tt = t.weldpanel.collab.alerts.conditionText;
  const sensitivities = t.weldpanel.collab.alerts.form.sensitivities;
  return (condition) => {
    if (condition.type === 'threshold') return format(tt[condition.operator], { value: formatNumber(condition.value, language) });
    if (condition.type === 'change') return format(tt[condition.direction], { percent: formatNumber(condition.percent, language) });
    return format(tt.anomaly, { sensitivity: sensitivities[condition.sensitivity].toLowerCase() });
  };
}

/** What an alert watches: the report's name (and series), or the event of its own spec. */
export function useWatchText(): (alert: PanelAlertDto, reports: ReadonlyMap<string, PanelReportDto>) => string {
  const { t, format } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  return (alert, reports) => {
    if (alert.reportId) {
      const report = reports.get(alert.reportId);
      const name = report?.name ?? t.weldpanel.collab.subscriptions.missingTarget;
      const specSeries = report?.spec.series;
      const seriesCount = Array.isArray(specSeries) ? specSeries.length : 1;
      return seriesCount > 1 ? `${name} · ${format(ta.seriesN, { n: String(alert.seriesIndex + 1) })}` : name;
    }
    const specSeries = alert.spec?.series;
    const series = Array.isArray(specSeries) ? (specSeries[alert.seriesIndex] as { event?: unknown } | undefined) : undefined;
    return format(ta.customSeries, { event: typeof series?.event === 'string' ? series.event : '?' });
  };
}
