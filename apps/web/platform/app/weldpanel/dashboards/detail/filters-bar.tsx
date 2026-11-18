/**
 * Dashboard-wide period and filters, saved on the dashboard and applied by
 * the server to every report tile: the period replaces each report's own,
 * the filters are added to theirs. Editors change a draft and apply it;
 * everyone else sees what is set.
 */

import { useEffect, useState } from 'react';
import { CalendarRange, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelDashboardDetailDto, PanelDashboardFilters } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelDateRange, PanelFilter } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { useUpdateWeldPanelDashboard } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { DateRangePicker } from '../../components/date-range-picker';
import { FilterBuilder } from '../../components/filter-builder';
import { DEFAULT_RANGE, isCustomRange, rangesEqual } from '../../lib/date-range';
import { formatDay } from '../../lib/format';

interface Draft {
  dateRange: PanelDateRange | undefined;
  filters: PanelFilter[];
}

function draftOf(filters: PanelDashboardFilters | null): Draft {
  return { dateRange: filters?.dateRange, filters: (filters?.filters ?? []) as PanelFilter[] };
}

function sameDraft(a: Draft, b: Draft): boolean {
  const ranges = a.dateRange && b.dateRange ? rangesEqual(a.dateRange, b.dateRange) : a.dateRange === b.dateRange;
  return ranges && JSON.stringify(a.filters) === JSON.stringify(b.filters);
}

export function DashboardFiltersBar({ dashboard, canEdit }: Readonly<{ dashboard: PanelDashboardDetailDto; canEdit: boolean }>) {
  const { t, language, format } = useI18n();
  const tf = t.weldpanel.collab.dashboards.filters;
  const tr = t.weldpanel.analytics.range;
  const update = useUpdateWeldPanelDashboard(dashboard.id);
  const saved = draftOf(dashboard.filters);
  const [draft, setDraft] = useState<Draft>(saved);

  // A saved change (or a refetch) replaces the draft.
  useEffect(() => {
    setDraft(draftOf(dashboard.filters));
  }, [dashboard.filters]);

  const dirty = !sameDraft(draft, saved);
  const hasAny = draft.dateRange !== undefined || draft.filters.length > 0;

  async function save(next: Draft) {
    try {
      await update.mutateAsync({ filters: next.dateRange === undefined && next.filters.length === 0 ? null : { ...(next.dateRange ? { dateRange: next.dateRange } : {}), filters: next.filters } });
      toast.success(tf.saved);
    } catch {
      toast.error(tf.failed);
    }
  }

  if (!canEdit) {
    if (!dashboard.filters || (!dashboard.filters.dateRange && dashboard.filters.filters.length === 0)) return null;
    const range = dashboard.filters.dateRange;
    let periodText: string | null = null;
    if (range) periodText = isCustomRange(range) ? `${formatDay(range.from, language)} – ${formatDay(range.to, language)}` : tr[range.preset];
    const parts = [periodText ? format(tf.periodActive, { period: periodText }) : null, dashboard.filters.filters.length > 0 ? format(tf.active, { count: String(dashboard.filters.filters.length) }) : null].filter(Boolean);
    return (
      <p className="text-sm text-muted-foreground" data-testid="weldpanel-dashboard-filters">
        {tf.readOnly}: {parts.join(' · ')}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2" data-testid="weldpanel-dashboard-filters" aria-label={tf.title}>
      {draft.dateRange ? (
        <div className="flex items-center gap-1">
          <DateRangePicker value={draft.dateRange} onChange={(dateRange) => setDraft({ ...draft, dateRange })} />
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={tf.reportPeriod} title={tf.reportPeriod} onClick={() => setDraft({ ...draft, dateRange: undefined })}>
            <X />
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => setDraft({ ...draft, dateRange: DEFAULT_RANGE })}>
          <CalendarRange />
          {tf.reportPeriod}
        </Button>
      )}
      <FilterBuilder projectId={dashboard.projectId} filters={draft.filters} onChange={(filters) => setDraft({ ...draft, filters })} />
      <div className="ml-auto flex items-center gap-2">
        {hasAny && (
          <Button type="button" variant="ghost" size="sm" disabled={update.isPending} onClick={() => void save({ dateRange: undefined, filters: [] })}>
            {tf.clear}
          </Button>
        )}
        {dirty && (
          <Button type="button" size="sm" disabled={update.isPending} onClick={() => void save(draft)}>
            {update.isPending && <Loader2 className="animate-spin" />}
            {tf.apply}
          </Button>
        )}
      </div>
    </div>
  );
}
