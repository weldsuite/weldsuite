/**
 * "Save as report", "Save changes" and "Add to dashboard" for a builder page.
 * A new analysis is saved as a report first (a dashboard tile is a report), so
 * "Add to dashboard" on an unsaved analysis asks for a name too.
 *
 * Also the collaboration entry points of every builder on a saved report:
 * "Share" (public links) and the side panel with comments, history, alerts
 * and schedules. Their dialogs mount only when opened. Annotations are added
 * and listed from the charts themselves (`charts/chart-annotations.tsx`).
 *
 * A page with the settings sidebar puts `ReportTools` (without "Add to
 * dashboard") on the left of its toolbar and `ReportSaveButtons` on the right;
 * `ReportActions` is all of them in one row.
 */

import { lazy, Suspense, useState } from 'react';
import { LayoutDashboard, Loader2, MessageSquare, Save, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelReportSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  useAddWeldPanelDashboardTile,
  useCreateWeldPanelReport,
  useUpdateWeldPanelReport,
  useWeldPanelDashboards,
} from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { NameDialog } from './name-dialog';

// Loaded when opened: they bring the collaboration hooks and forms along.
const ReportSidePanel = lazy(() => import('./report-side-panel').then((m) => ({ default: m.ReportSidePanel })));
const ShareDialog = lazy(() => import('./share-dialog').then((m) => ({ default: m.ShareDialog })));

/** Where a freshly added tile goes: below everything, half width. The dashboard page packs the tiles by order. */
export const NEW_TILE_LAYOUT = { x: 0, y: 1000, w: 12, h: 8 } as const;

interface ReportActionsProps {
  projectId: string;
  /** The analysis to save; null while it is incomplete. */
  spec: PanelReportSpec | null;
  /** The report currently open in the builder, if any. */
  report?: PanelReportDto | null;
  defaultName?: string;
  onSaved?: (report: PanelReportDto) => void;
}

function AddToDashboardDialog({
  open,
  onOpenChange,
  projectId,
  spec,
  report,
  defaultName,
  onSaved,
}: Readonly<ReportActionsProps & { open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const ts = t.weldpanel.analytics.save;
  const tc = t.weldpanel.analytics.common;
  const [dashboardId, setDashboardId] = useState('');
  const [name, setName] = useState(defaultName ?? '');
  const [busy, setBusy] = useState(false);
  const { data: dashboards } = useWeldPanelDashboards({ projectId }, open);
  const createReport = useCreateWeldPanelReport();
  const addTile = useAddWeldPanelDashboardTile(dashboardId);

  const needsName = !report;
  const ready = dashboardId !== '' && (report ? true : name.trim() !== '' && spec !== null);

  async function submit() {
    setBusy(true);
    try {
      let target = report ?? null;
      if (!target && spec) {
        target = await createReport.mutateAsync({ projectId, name: name.trim(), visibility: 'private', spec });
        onSaved?.(target);
      }
      if (!target) return;
      await addTile.mutateAsync({ reportId: target.id, layout: NEW_TILE_LAYOUT });
      toast.success(ts.addedToDashboard);
      onOpenChange(false);
    } catch {
      toast.error(ts.addFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ts.dashboardDialogTitle}</DialogTitle>
          <DialogDescription>{ts.dashboardDialogDescription}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {needsName && (
            <div className="grid gap-1.5">
              <Label htmlFor="weldpanel-tile-report-name">{ts.nameLabel}</Label>
              <Input id="weldpanel-tile-report-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={ts.namePlaceholder} maxLength={255} />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="weldpanel-tile-dashboard">{ts.dashboardLabel}</Label>
            {dashboards && dashboards.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {ts.noDashboards}{' '}
                <Link href="/weldpanel/dashboards" className="underline underline-offset-2">
                  {ts.newDashboard}
                </Link>
              </p>
            ) : (
              <Select value={dashboardId} onValueChange={setDashboardId}>
                <SelectTrigger id="weldpanel-tile-dashboard">
                  <SelectValue placeholder={ts.dashboardPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {(dashboards ?? []).map((dashboard) => (
                    <SelectItem key={dashboard.id} value={dashboard.id}>
                      {dashboard.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {tc.cancel}
          </Button>
          <Button type="button" disabled={!ready || busy} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />}
            {tc.add}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Save as report" (or "Save as new"), then "Save changes" on a saved report so the main button ends the row; with the name dialog. */
export function ReportSaveButtons({ projectId, spec, report, defaultName, onSaved }: Readonly<ReportActionsProps>) {
  const { t } = useI18n();
  const ts = t.weldpanel.analytics.save;
  const canCreate = useCan('panel_reports:create');
  const canUpdate = useCan('panel_reports:update');
  const [saving, setSaving] = useState(false);
  const createReport = useCreateWeldPanelReport();
  const updateReport = useUpdateWeldPanelReport(report?.id ?? '');
  const complete = spec !== null;

  async function saveChanges() {
    if (!spec || !report) return;
    try {
      const saved = await updateReport.mutateAsync({ spec });
      toast.success(ts.updated);
      onSaved?.(saved);
    } catch {
      toast.error(ts.failed);
    }
  }

  return (
    <>
      {canCreate && (
        <Button type="button" size="sm" variant={report ? 'outline' : 'default'} disabled={!complete} onClick={() => setSaving(true)}>
          {report ? ts.saveAsNew : ts.saveReport}
        </Button>
      )}
      {report && canUpdate && (
        <Button type="button" size="sm" disabled={!complete || updateReport.isPending} onClick={() => void saveChanges()}>
          {updateReport.isPending ? <Loader2 className="animate-spin" /> : <Save />}
          {ts.updateReport}
        </Button>
      )}
      <NameDialog
        open={saving}
        onOpenChange={setSaving}
        title={ts.reportDialogTitle}
        description={ts.reportDialogDescription}
        submitLabel={ts.saveReport}
        initial={{ name: defaultName ?? '' }}
        namePlaceholder={ts.namePlaceholder}
        showDescription
        showVisibility
        onSubmit={async (values) => {
          if (!spec) return;
          try {
            const saved = await createReport.mutateAsync({
              projectId,
              name: values.name,
              description: values.description.trim() === '' ? null : values.description.trim(),
              visibility: values.visibility,
              spec,
            });
            toast.success(ts.saved);
            setSaving(false);
            onSaved?.(saved);
          } catch {
            toast.error(ts.failed);
          }
        }}
      />
    </>
  );
}

interface ReportToolsProps extends Pick<ReportActionsProps, 'projectId' | 'report' | 'defaultName' | 'onSaved'> {
  /** Only needed with `withDashboard`: the analysis to put on a dashboard. */
  spec?: PanelReportSpec | null;
  /** Start with "Add to dashboard". */
  withDashboard?: boolean;
}

/** On a saved report "Share" and the side panel; with `withDashboard` "Add to dashboard" first. */
export function ReportTools({ withDashboard = false, ...props }: Readonly<ReportToolsProps>) {
  const { spec = null, report } = props;
  const { t } = useI18n();
  const ts = t.weldpanel.analytics.save;
  const tcol = t.weldpanel.collab;
  const canCreate = useCan('panel_reports:create');
  const canUpdate = useCan('panel_reports:update');
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <>
      {withDashboard && (canCreate || canUpdate) && (
        <Button type="button" size="sm" variant="outline" disabled={spec === null} onClick={() => setAdding(true)}>
          <LayoutDashboard />
          {ts.addToDashboard}
        </Button>
      )}
      {report && (
        <>
          <Button type="button" size="sm" variant="outline" onClick={() => setSharing(true)}>
            <Share2 />
            {tcol.share.button}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setPanelOpen(true)}>
            <MessageSquare />
            {tcol.sidePanel.open}
          </Button>
        </>
      )}

      {adding && <AddToDashboardDialog {...props} spec={spec} open={adding} onOpenChange={setAdding} />}
      <Suspense fallback={null}>
        {report && sharing && (
          <ShareDialog
            open={sharing}
            onOpenChange={setSharing}
            target={{ targetType: 'report', targetId: report.id, name: report.name, ownerUserId: report.ownerUserId, visibility: report.visibility }}
          />
        )}
        {report && panelOpen && <ReportSidePanel report={report} open={panelOpen} onOpenChange={setPanelOpen} />}
      </Suspense>
    </>
  );
}

/** Every action in one row, saving first: for a page without the settings sidebar (Performance). */
export function ReportActions(props: Readonly<ReportActionsProps>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ReportSaveButtons {...props} />
      <ReportTools {...props} withDashboard />
    </div>
  );
}
