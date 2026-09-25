/** Coaching timeline for a single employee's profile. */

import { useState } from 'react';
import { CheckCircle2, Loader2, Plus } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrCoachingLog } from '@weldsuite/app-api-client/domains/weldhr';
import { useHrCoaching } from '@/hooks/queries/use-weldhr-queries';
import { CoachingDialog } from '../../coaching/components/coaching-dialog';
import { SectionCard, EmptyText } from '../page-kit';
import { ErrorBanner, StatusBadge, errorMessage, formatDate } from '../shared';

export function EmployeeCoachingTab({ employeeId }: Readonly<{ employeeId: string }>) {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('coaching:create');
  const { data: logs, isLoading, error } = useHrCoaching({ employeeId });
  const [creating, setCreating] = useState(false);

  return (
    <SectionCard
      title={t('weldhr.coaching.tab.title')}
      action={
        canCreate && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('weldhr.coaching.logSession')}
          </Button>
        )
      }
    >
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.common.loadFailed')) : null} />

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !logs || logs.length === 0 ? (
        <EmptyText>{t('weldhr.coaching.tab.empty')}</EmptyText>
      ) : (
        <div className="space-y-3">
          {logs.map((log) => (
            <TimelineEntry key={log.id} log={log} />
          ))}
        </div>
      )}

      {creating && <CoachingDialog employeeId={employeeId} onClose={() => setCreating(false)} />}
    </SectionCard>
  );
}

function TimelineEntry({ log }: Readonly<{ log: HrCoachingLog }>) {
  const t = useTranslations();
  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{formatDate(log.sessionDate)}</p>
          <Badge variant="outline">{t(`weldhr.status.coachingCategory.${log.category}`)}</Badge>
          <StatusBadge group="coaching" status={log.status} />
          <Badge variant={log.visibility === 'internal' ? 'secondary' : 'outline'}>
            {t(`weldhr.status.visibility.${log.visibility}`)}
          </Badge>
        </div>
        {log.acknowledgedAt && (
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t('weldhr.coaching.table.acknowledged')}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm font-medium">{log.topic}</p>
      {log.notes && <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">{log.notes}</p>}
      {log.actionItems.length > 0 && (
        <ul className="mt-2 space-y-1">
          {log.actionItems.map((item) => (
            <li key={item.id} className="flex items-center gap-1.5 text-xs">
              <span className={item.done ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                {item.done ? '✓' : '○'}
              </span>
              <span className={item.done ? 'text-muted-foreground line-through' : ''}>{item.text}</span>
            </li>
          ))}
        </ul>
      )}
      {log.followUpDate && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('weldhr.coaching.dialog.followUpDate')}: {formatDate(log.followUpDate)}
        </p>
      )}
      {log.employeeComment && (
        <div className="mt-2 rounded-md border bg-muted/40 p-2">
          <p className="text-xs font-medium text-muted-foreground">{t('weldhr.coaching.acknowledgement.title')}</p>
          <p className="mt-0.5 text-xs">{log.employeeComment}</p>
        </div>
      )}
    </Card>
  );
}
