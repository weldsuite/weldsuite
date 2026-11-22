/**
 * My HR → Time off → a sick report of your own: its first and last sick day,
 * days and note, with "Report recovered" while it is still open.
 */

import { useState } from 'react';
import { CalendarCheck, CalendarDays, CalendarPlus, CircleDot, FileText, Hash, HeartPulse, SunMedium } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { ObjectPanelTabs, useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { PanelRow } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useMyHrAbsences } from '@/hooks/queries/use-weldhr-queries';
import { RecoverDialog } from '@/app/weldhr/absenteeism/components/recover-dialog';
import { formatDays } from '@/app/weldhr/absenteeism/components/shared';
import { StatusBadge, formatDate } from '@/app/weldhr/components/shared';
import { TIME_OFF_PANEL_WIDTH, TimeOffPanelMenu, TimeOffPanelMissing, TimeOffPanelTitle, useDetailsTab } from './parts';
import { MY_SICK_REPORT_PANEL_TYPE } from './types';

export function MySickReportPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { data, isLoading, error, refetch } = useMyHrAbsences();
  const report = data?.current?.id === props.id ? data.current : data?.history.find((r) => r.id === props.id);
  // Only the open report can be reported recovered, as in the list.
  const isCurrent = !!report && report.id === data?.current?.id;
  const [recovering, setRecovering] = useState(false);
  const detailsTab = useDetailsTab();

  const shell = useObjectPanelShell({ ...props, width: TIME_OFF_PANEL_WIDTH, loading: isLoading && !data });

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={
        <TimeOffPanelTitle
          label={report ? t('weldhr.me.timeOff.panel.sickReportTitle', { date: formatDate(report.startDate) }) : undefined}
          status={report ? <StatusBadge group="absence" status={report.status} /> : null}
        />
      }
      actions={
        report ? (
          <TimeOffPanelMenu type={MY_SICK_REPORT_PANEL_TYPE} id={report.id}>
            {isCurrent ? (
              <DropdownMenuItem onClick={() => setRecovering(true)}>
                <HeartPulse />
                {t('weldhr.absenteeism.reportRecovered')}
              </DropdownMenuItem>
            ) : null}
          </TimeOffPanelMenu>
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {!report && <TimeOffPanelMissing loaded={!!data} error={error} onRetry={() => void refetch()} />}

      {report && (
        <div className="space-y-1 p-4">
          <PanelRow
            icon={CalendarDays}
            label={t('weldhr.absenteeism.table.firstSickDay')}
            value={formatDate(report.startDate)}
            tabular
          />
          <PanelRow
            icon={SunMedium}
            label={t('weldhr.absenteeism.form.firstDay')}
            value={t(`weldhr.absenteeism.firstDay.${report.firstDay}`)}
          />
          <PanelRow
            icon={CalendarCheck}
            label={t('weldhr.absenteeism.table.lastSickDay')}
            value={report.endDate ? formatDate(report.endDate) : t('weldhr.absenteeism.stillAbsent')}
            tabular
          />
          <PanelRow icon={Hash} label={t('weldhr.absenteeism.table.days')} value={formatDays(report.days)} tabular />
          <PanelRow
            icon={CircleDot}
            label={t('weldhr.absenteeism.table.status')}
            value={report.status}
            renderValue={() => <StatusBadge group="absence" status={report.status} />}
          />
          <PanelRow icon={FileText} label={t('weldhr.absenteeism.table.note')} value={report.note} />
          <PanelRow
            icon={CalendarPlus}
            label={t('weldhr.me.timeOff.panel.reportedOn')}
            value={formatDate(report.createdAt)}
            tabular
          />
        </div>
      )}

      {recovering && report && <RecoverDialog absence={report} self onClose={() => setRecovering(false)} />}
    </EntityDetailView>
  );
}
