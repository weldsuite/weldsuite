/**
 * The side panel of a saved report: comments, version history (view a
 * version, restore it), the alerts and scheduled sends on it, and its share
 * links. Opened from the builder's toolbar (`ReportActions`).
 */

import { useState } from 'react';
import { Bell, CalendarClock, History, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelReportVersionDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  useRestoreWeldPanelReportVersion,
  useWeldPanelAlerts,
  useWeldPanelReportVersion,
  useWeldPanelReportVersions,
  useWeldPanelSubscriptions,
} from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { AlertFormDialog } from '../alerts/alert-form-dialog';
import { AlertStateBadge, useConditionText } from '../alerts/alert-text';
import { formatDateTime } from '../lib/format';
import { reportKindLabel } from '../lib/report-kinds';
import { scheduleText } from '../lib/schedule';
import { specSummary } from '../lib/spec-summary';
import { SubscriptionFormDialog } from '../subscriptions/subscription-form-dialog';
import { CommentsPanel } from './comments-panel';
import { SharePanel } from './share-dialog';
import { useMembers } from './use-members';

export type ReportPanelTab = 'comments' | 'history' | 'alerts' | 'schedules' | 'share';

function VersionDetail({ reportId, version }: Readonly<{ reportId: string; version: number }>) {
  const { t } = useI18n();
  const tv = t.weldpanel.collab.versions;
  const { data, isLoading, isError } = useWeldPanelReportVersion(reportId, version);
  if (isLoading) return <p className="text-xs text-muted-foreground">{tv.specLoading}</p>;
  if (isError || !data) return <p className="text-xs text-destructive">{tv.loadFailed}</p>;
  const summary = specSummary(data.spec, t.weldpanel.analytics.range);
  const list = (items: string[]) => (items.length > 0 ? items.join(', ') : tv.none);
  return (
    <FieldGrid
      className="mt-2 rounded-md border bg-muted/30 p-3"
      fields={[
        { label: tv.fields.name, value: data.name },
        { label: tv.fields.kind, value: reportKindLabel(t, data.kind) },
        { label: tv.fields.description, value: data.description },
        { label: tv.fields.range, value: summary.range },
        { label: tv.fields.events, value: list(summary.events) },
        { label: tv.fields.filters, value: String(summary.filters) },
        { label: tv.fields.breakdowns, value: list(summary.breakdowns) },
      ]}
    />
  );
}

function VersionsPanel({ report }: Readonly<{ report: PanelReportDto }>) {
  const { t, language, format } = useI18n();
  const tv = t.weldpanel.collab.versions;
  const tc = t.weldpanel.analytics.common;
  const canUpdate = useCan('panel_reports:update');
  const canManage = useCan('panel_projects:manage');
  const { me, nameOf } = useMembers();
  const { data: versions, isLoading, isError, refetch } = useWeldPanelReportVersions(report.id);
  const restore = useRestoreWeldPanelReportVersion(report.id);
  const [viewing, setViewing] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<PanelReportVersionDto | null>(null);
  const mayRestore = canUpdate && (report.ownerUserId === me || (report.visibility === 'workspace' && canManage));

  if (isLoading)
    return (
      <div className="grid gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  if (isError) return <ErrorState message={tv.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;
  if (!versions || versions.length === 0) return <EmptyState icon={History} title={tv.title} description={tv.empty} />;

  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">{tv.description}</p>
      <ul className="divide-y">
        {versions.map((version) => (
          <li key={version.id} className="py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {format(tv.version, { version: String(version.version) })} · <span className="font-normal">{version.name}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {format(tv.byLine, {
                    date: formatDateTime(version.createdAt, language),
                    name: nameOf(version.createdByUserId, { you: tc.ownedByYou, fallback: t.weldpanel.observe.common.unknown }),
                  })}
                </p>
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={() => setViewing(viewing === version.version ? null : version.version)} aria-expanded={viewing === version.version}>
                {viewing === version.version ? tv.hide : tv.view}
              </Button>
              {mayRestore && (
                <Button type="button" size="sm" variant="outline" onClick={() => setRestoring(version)}>
                  {tv.restore}
                </Button>
              )}
            </div>
            {viewing === version.version && <VersionDetail reportId={report.id} version={version.version} />}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={format(tv.restoreTitle, { version: String(restoring?.version ?? '') })}
        description={tv.restoreDescription}
        confirmLabel={tv.restore}
        cancelLabel={tc.cancel}
        onConfirm={async () => {
          if (!restoring) return;
          try {
            await restore.mutateAsync(restoring.version);
            toast.success(tv.restored);
            setRestoring(null);
          } catch (error) {
            toast.error(isApiError(error) && error.status === 409 ? tv.restoreConflict : tv.restoreFailed);
          }
        }}
      />
    </div>
  );
}

function AlertsTab({ report }: Readonly<{ report: PanelReportDto }>) {
  const { t } = useI18n();
  const tp = t.weldpanel.collab.sidePanel;
  const canCreate = useCan('panel_reports:create');
  const conditionText = useConditionText();
  const { data: alerts, isLoading, isError, refetch } = useWeldPanelAlerts({ projectId: report.projectId });
  const [creating, setCreating] = useState(false);
  const mine = (alerts ?? []).filter((alert) => alert.reportId === report.id);
  if (report.kind !== 'trends') return <EmptyState icon={Bell} title={t.weldpanel.collab.alerts.title} description={tp.alertsTrendsOnly} />;
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{tp.alertsDescription}</p>
        {canCreate && (
          <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus />
            {t.weldpanel.collab.alerts.newAlert}
          </Button>
        )}
      </div>
      {isLoading && <Skeleton className="h-12 w-full" />}
      {isError && <ErrorState message={t.weldpanel.collab.alerts.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />}
      {!isLoading && !isError && mine.length === 0 && <p className="text-sm text-muted-foreground">{tp.alertsEmpty}</p>}
      {mine.length > 0 && (
        <ul className="divide-y">
          {mine.map((alert) => (
            <li key={alert.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{alert.name}</p>
                <p className="text-xs text-muted-foreground">{conditionText(alert.condition)}</p>
              </div>
              <AlertStateBadge alert={alert} />
              <Button asChild size="sm" variant="ghost">
                <Link href={`/weldpanel/alerts?alert=${encodeURIComponent(alert.id)}`}>{tp.manage}</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {creating && <AlertFormDialog open={creating} onOpenChange={setCreating} projectId={report.projectId} reportId={report.id} />}
    </div>
  );
}

function SchedulesTab({ report }: Readonly<{ report: PanelReportDto }>) {
  const { t, language, format } = useI18n();
  const tp = t.weldpanel.collab.sidePanel;
  const ts = t.weldpanel.collab.subscriptions;
  const canCreate = useCan('panel_reports:create');
  const { data: subscriptions, isLoading, isError, refetch } = useWeldPanelSubscriptions({ projectId: report.projectId, targetType: 'report', targetId: report.id });
  const [creating, setCreating] = useState(false);
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{tp.schedulesDescription}</p>
        {canCreate && (
          <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus />
            {ts.newSubscription}
          </Button>
        )}
      </div>
      {isLoading && <Skeleton className="h-12 w-full" />}
      {isError && <ErrorState message={ts.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />}
      {!isLoading && !isError && (subscriptions ?? []).length === 0 && <p className="text-sm text-muted-foreground">{tp.schedulesEmpty}</p>}
      {subscriptions && subscriptions.length > 0 && (
        <ul className="divide-y">
          {subscriptions.map((subscription) => (
            <li key={subscription.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{subscription.name}</p>
                <p className="text-xs text-muted-foreground">{scheduleText(subscription.schedule, ts.scheduleText, language, format)}</p>
              </div>
              <Button asChild size="sm" variant="ghost">
                <Link href="/weldpanel/subscriptions">{tp.manage}</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <SubscriptionFormDialog
          open={creating}
          onOpenChange={setCreating}
          projectId={report.projectId}
          target={{ targetType: 'report', targetId: report.id, name: report.name }}
        />
      )}
    </div>
  );
}

interface ReportSidePanelProps {
  report: PanelReportDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab?: ReportPanelTab;
  onTabChange?: (tab: ReportPanelTab) => void;
}

export function ReportSidePanel({ report, open, onOpenChange, tab, onTabChange }: Readonly<ReportSidePanelProps>) {
  const { t } = useI18n();
  const tp = t.weldpanel.collab.sidePanel;
  const [ownTab, setOwnTab] = useState<ReportPanelTab>('comments');
  const active = tab ?? ownTab;
  const setTab = (next: ReportPanelTab) => (onTabChange ? onTabChange(next) : setOwnTab(next));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{report.name}</SheetTitle>
          <SheetDescription>{tp.title}</SheetDescription>
        </SheetHeader>
        {open && (
          <Tabs value={active} onValueChange={(value) => setTab(value as ReportPanelTab)} className="gap-4 px-4 pb-6">
            <TabsList className="h-auto max-w-full flex-wrap justify-start">
              {(['comments', 'history', 'alerts', 'schedules', 'share'] as const).map((value) => (
                <TabsTrigger key={value} value={value}>
                  {tp.tabs[value]}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="comments">
              <CommentsPanel target={{ targetType: 'report', targetId: report.id }} />
            </TabsContent>
            <TabsContent value="history">
              <VersionsPanel report={report} />
            </TabsContent>
            <TabsContent value="alerts">
              <AlertsTab report={report} />
            </TabsContent>
            <TabsContent value="schedules">
              <SchedulesTab report={report} />
            </TabsContent>
            <TabsContent value="share">
              <p className="mb-3 text-sm text-muted-foreground">{tp.shareDescription}</p>
              <SharePanel target={{ targetType: 'report', targetId: report.id, name: report.name, ownerUserId: report.ownerUserId, visibility: report.visibility }} />
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
    </Sheet>
  );
}
