/** My HR → Time off: report yourself sick or recovered, and your earlier sick reports. */

import { useState } from 'react';
import { CircleCheck, HeartPulse } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfAbsence } from '@weldsuite/app-api-client/domains/weldhr';
import { useMyHrAbsences } from '@/hooks/queries/use-weldhr-queries';
import { AbsenceDialog } from '../../absenteeism/components/absence-dialog';
import { RecoverDialog } from '../../absenteeism/components/recover-dialog';
import { formatDays } from '../../absenteeism/components/shared';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { ErrorBanner, StatusBadge, errorMessage, formatDate } from '../../components/shared';
import { TabLoading } from './shared';

/** Whether you are reported sick right now, with the button to report sick or recovered. */
export function SickStatusCard() {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrAbsences();
  const [reporting, setReporting] = useState(false);
  const [recovering, setRecovering] = useState<HrSelfAbsence | null>(null);

  if (isLoading) return <TabLoading />;
  if (!data) return <ErrorBanner error={errorMessage(error, t('weldhr.absenteeism.mine.loadFailed'))} />;

  const { current } = data;

  return (
    <>
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            {current ? (
              <HeartPulse className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            ) : (
              <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            )}
            <div className="min-w-0 space-y-1">
              <h2 className="text-base font-semibold">
                {t(current ? 'weldhr.absenteeism.mine.sick.title' : 'weldhr.absenteeism.mine.well.title')}
              </h2>
              {current && (
                <p className="text-sm">
                  {t('weldhr.absenteeism.since', { date: formatDate(current.startDate) })}
                  {current.firstDay === 'half' && ` (${t('weldhr.absenteeism.halfFirstDay')})`}
                  {' · '}
                  {t('weldhr.absenteeism.mine.sick.days', { days: formatDays(current.days) })}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {t(current ? 'weldhr.absenteeism.mine.sick.description' : 'weldhr.absenteeism.mine.well.description')}
              </p>
            </div>
          </div>
          {current ? (
            <Button onClick={() => setRecovering(current)}>{t('weldhr.absenteeism.reportRecovered')}</Button>
          ) : (
            <Button onClick={() => setReporting(true)}>{t('weldhr.absenteeism.reportSick')}</Button>
          )}
        </CardContent>
      </Card>

      {reporting && <AbsenceDialog mode={{ kind: 'self' }} onClose={() => setReporting(false)} />}
      {recovering && <RecoverDialog absence={recovering} self onClose={() => setRecovering(null)} />}
    </>
  );
}

/** Earlier sick reports. Renders nothing until the reports have loaded; `SickStatusCard` shows the spinner and errors. */
export function SickHistoryCard() {
  const t = useTranslations();
  const { data } = useMyHrAbsences();

  if (!data) return null;
  const { history } = data;

  return (
    <SectionCard title={t('weldhr.absenteeism.mine.history.title')} contentClassName="p-0">
      {history.length === 0 ? (
        <EmptyText>{t('weldhr.absenteeism.mine.history.empty')}</EmptyText>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('weldhr.absenteeism.table.firstSickDay')}</TableHead>
              <TableHead>{t('weldhr.absenteeism.table.lastSickDay')}</TableHead>
              <TableHead>{t('weldhr.absenteeism.table.days')}</TableHead>
              <TableHead>{t('weldhr.absenteeism.table.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((report) => (
              <TableRow key={report.id}>
                <TableCell className="whitespace-nowrap">
                  {formatDate(report.startDate)}
                  {report.firstDay === 'half' && (
                    <span className="text-muted-foreground"> · {t('weldhr.absenteeism.halfFirstDay')}</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(report.endDate)}</TableCell>
                <TableCell className="tabular-nums">{formatDays(report.days)}</TableCell>
                <TableCell>
                  <StatusBadge group="absence" status={report.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
