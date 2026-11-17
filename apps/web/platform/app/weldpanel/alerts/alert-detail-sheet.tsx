/**
 * One alert in a side sheet: its state, what it watches and how, where it
 * sends, and its history. `/weldpanel/alerts?alert=<id>` opens it (the links
 * in alert emails and notifications).
 */

import { BellRing, CheckCircle2, CircleAlert } from 'lucide-react';
import type { PanelAlertDto, PanelAlertEventKind } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState, InlineError } from '@weldsuite/ui/components/error-banner';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useWeldPanelAlert, useWeldPanelAlertEvents } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { ChannelsSummary } from '../components/delivery-channels-fields';
import { formatDateTime, formatNumber } from '../lib/format';
import { reportBuilderHref } from '../lib/links';
import { isNotFoundError } from '../lib/api-errors';
import { AlertStateBadge, useConditionText, useWatchText } from './alert-text';

const EVENT_ICONS: Record<PanelAlertEventKind, typeof BellRing> = { fired: BellRing, resolved: CheckCircle2, error: CircleAlert };
const EVENT_COLORS: Record<PanelAlertEventKind, string> = { fired: 'text-destructive', resolved: 'text-emerald-600 dark:text-emerald-400', error: 'text-amber-600 dark:text-amber-400' };

function History({ alertId }: Readonly<{ alertId: string }>) {
  const { t, language, format } = useI18n();
  const td = t.weldpanel.collab.alerts.detail;
  const { data: events, isLoading, isError, refetch } = useWeldPanelAlertEvents(alertId);
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError)
    return (
      <InlineError>
        {td.historyFailed}{' '}
        <button type="button" className="underline underline-offset-2" onClick={() => void refetch()}>
          {t.weldpanel.retry}
        </button>
      </InlineError>
    );
  if (!events || events.length === 0) return <EmptyText>{td.historyEmpty}</EmptyText>;
  return (
    <ul className="divide-y">
      {events.map((event) => {
        const Icon = EVENT_ICONS[event.kind];
        return (
          <li key={event.id} className="flex items-start gap-3 py-2.5">
            <Icon className={`mt-0.5 size-4 shrink-0 ${EVENT_COLORS[event.kind]}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{td.events[event.kind]}</p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(event.createdAt, language)}
                {event.value !== null && event.bound !== null && ` · ${format(td.valueBound, { value: formatNumber(event.value, language), bound: formatNumber(event.bound, language) })}`}
              </p>
              {event.message && <p className="mt-0.5 text-sm text-muted-foreground">{event.message}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function AlertDetail({ alert, reports }: Readonly<{ alert: PanelAlertDto; reports: ReadonlyMap<string, PanelReportDto> }>) {
  const { t, language, format } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const td = ta.detail;
  const conditionText = useConditionText();
  const watchText = useWatchText();
  const report = alert.reportId ? reports.get(alert.reportId) : undefined;
  const when = (iso: string | null) => (iso ? formatDateTime(iso, language) : td.never);
  return (
    <div className="grid gap-5 px-4 pb-6">
      <div className="flex flex-wrap items-center gap-2">
        <AlertStateBadge alert={alert} />
        {alert.snoozedUntil && Date.parse(alert.snoozedUntil) > Date.now() && (
          <span className="text-xs text-muted-foreground">{format(ta.snoozed, { date: formatDateTime(alert.snoozedUntil, language) })}</span>
        )}
      </div>
      <FieldGrid
        fields={[
          { label: td.watching, value: watchText(alert, reports) },
          { label: td.condition, value: `${conditionText(alert.condition)} · ${ta.intervals[alert.checkInterval]}` },
          { label: td.lastValue, value: alert.lastValue === null ? '–' : formatNumber(alert.lastValue, language) },
          { label: td.lastChecked, value: when(alert.lastCheckedAt) },
          { label: td.lastFired, value: when(alert.lastFiredAt) },
          { label: td.nextCheck, value: when(alert.nextCheckAt) },
          { label: td.channels, value: <ChannelsSummary channels={alert.channels} /> },
        ]}
      />
      {alert.lastError && (
        <p className="text-sm text-destructive">
          {td.lastError}: {alert.lastError}
        </p>
      )}
      {report && (
        <Button asChild variant="outline" size="sm" className="justify-self-start">
          <Link href={reportBuilderHref(report.kind, report.id)}>{td.openReport}</Link>
        </Button>
      )}
      <div>
        <h3 className="mb-1 text-sm font-medium">{td.historyTitle}</h3>
        <History alertId={alert.id} />
      </div>
    </div>
  );
}

interface AlertDetailSheetProps {
  alertId: string | null;
  onClose: () => void;
  reports: ReadonlyMap<string, PanelReportDto>;
}

export function AlertDetailSheet({ alertId, onClose, reports }: Readonly<AlertDetailSheetProps>) {
  const { t } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const { data: alert, isLoading, isError, error, refetch } = useWeldPanelAlert(alertId ?? '');
  return (
    <Sheet open={alertId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{alert?.name ?? ta.title}</SheetTitle>
          <SheetDescription>{ta.description}</SheetDescription>
        </SheetHeader>
        {isLoading && (
          <div className="grid gap-3 px-4">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
        {isError && (
          <div className="px-4">
            <ErrorState message={isNotFoundError(error) ? ta.notFound : ta.loadFailed} onRetry={isNotFoundError(error) ? undefined : () => void refetch()} retryLabel={t.weldpanel.retry} />
          </div>
        )}
        {alert && <AlertDetail alert={alert} reports={reports} />}
      </SheetContent>
    </Sheet>
  );
}
