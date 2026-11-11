/**
 * "Export CSV" and "Schedule" for a report page header: the overview (with the
 * selected `range`) or a saved report (`reportId`).
 */

import { useState } from 'react';
import { CalendarClock, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { useExportDeskOverviewCsv, useExportDeskReportCsv } from '@/hooks/queries/use-desk-reports-queries';
import { ScheduleDialog } from './schedule-dialog';

export function ReportShareActions({ reportId, range }: Readonly<{ reportId?: string; range?: string }>) {
  const { t } = useI18n();
  const canSchedule = useCan('settings:create');
  const exportOverview = useExportDeskOverviewCsv();
  const exportReport = useExportDeskReportCsv();
  const [scheduling, setScheduling] = useState(false);
  const pending = exportOverview.isPending || exportReport.isPending;

  const onExport = () => {
    const onError = () => toast.error(t.helpdesk.reportExport.failed);
    if (reportId) exportReport.mutate(reportId, { onError });
    else exportOverview.mutate(range ?? 'last_30_days', { onError });
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={onExport} disabled={pending}>
        {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Download className="mr-2 h-4 w-4" aria-hidden />}
        {pending ? t.helpdesk.reportExport.exporting : t.helpdesk.reportExport.button}
      </Button>
      {canSchedule && (
        <>
          <Button variant="outline" size="sm" onClick={() => setScheduling(true)}>
            <CalendarClock className="mr-2 h-4 w-4" aria-hidden />
            {t.helpdesk.reportSchedules.scheduleButton}
          </Button>
          <ScheduleDialog
            open={scheduling}
            onOpenChange={setScheduling}
            defaults={{ reportId: reportId ?? null, range }}
          />
        </>
      )}
    </>
  );
}
