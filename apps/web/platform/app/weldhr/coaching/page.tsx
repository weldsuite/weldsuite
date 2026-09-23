/**
 * WeldHR — coaching log. Filterable list of coaching sessions across the
 * workforce; logging, editing and closing sessions happens through
 * {@link CoachingDialog}.
 */

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Plus } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrCoachingCategory, HrCoachingLog, HrCoachingStatus } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useDeleteHrCoaching,
  useHrCoaching,
  useUpdateHrCoaching,
} from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import {
  CompanyPicker,
  EmployeeAvatar,
  EmployeePicker,
  EmptyState,
  ErrorBanner,
  InlineSpinner,
  PageBody,
  PageHeader,
  StatusBadge,
  errorMessage,
  formatDate,
  todayIso,
} from '../components/shared';
import { CoachingDialog } from './components/coaching-dialog';

const CATEGORIES: HrCoachingCategory[] = [
  'performance',
  'quality',
  'behavior',
  'attendance',
  'development',
  'recognition',
];
const STATUSES: HrCoachingStatus[] = ['open', 'acknowledged', 'closed'];

type DialogState = { kind: 'create' } | { kind: 'edit'; log: HrCoachingLog } | null;

export default function WeldHrCoachingPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('coaching:create');
  const canUpdate = can('coaching:update');
  const canDelete = can('coaching:delete');

  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [followUpDue, setFollowUpDue] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);

  const { data: logs, isLoading, error } = useHrCoaching({
    employeeId: employeeId ?? undefined,
    companyId: companyId ?? undefined,
    category: category === 'all' ? undefined : category,
    status: status === 'all' ? undefined : status,
    followUpDue: followUpDue || undefined,
    from: from || undefined,
    to: to || undefined,
  });

  return (
    <PageBody wide>
      <PageHeader
        title={t('weldhr.coaching.title')}
        subtitle={t('weldhr.coaching.subtitle')}
        actions={
          canCreate && (
            <Button onClick={() => setDialog({ kind: 'create' })}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.coaching.logSession')}
            </Button>
          )
        }
      />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-48 space-y-1">
          <p className="text-xs text-muted-foreground">{t('weldhr.coaching.filters.employee')}</p>
          <EmployeePicker
            value={employeeId}
            valueLabel={employeeLabel}
            onChange={(id, label) => {
              setEmployeeId(id);
              setEmployeeLabel(label);
            }}
            allowClear
          />
        </div>
        <div className="w-48 space-y-1">
          <p className="text-xs text-muted-foreground">{t('weldhr.coaching.filters.client')}</p>
          <CompanyPicker
            value={companyId}
            valueLabel={companyLabel}
            onChange={(id, label) => {
              setCompanyId(id);
              setCompanyLabel(label);
            }}
            allowClear
          />
        </div>
        <div className="w-40 space-y-1">
          <p className="text-xs text-muted-foreground">{t('weldhr.coaching.filters.category')}</p>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('weldhr.common.all')}</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(`weldhr.status.coachingCategory.${c}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-40 space-y-1">
          <p className="text-xs text-muted-foreground">{t('weldhr.common.status')}</p>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('weldhr.common.all')}</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`weldhr.status.coaching.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t('weldhr.common.from')}</p>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t('weldhr.common.to')}</p>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" />
        </div>
        <Button
          type="button"
          variant={followUpDue ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFollowUpDue((v) => !v)}
        >
          {t('weldhr.coaching.filters.followUpDue')}
        </Button>
      </Card>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.common.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !logs || logs.length === 0 ? (
        <EmptyState
          title={t('weldhr.coaching.empty.title')}
          description={t('weldhr.coaching.empty.description')}
          action={
            canCreate ? (
              <Button onClick={() => setDialog({ kind: 'create' })}>{t('weldhr.coaching.logSession')}</Button>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.coaching.table.date')}</TableHead>
                <TableHead>{t('weldhr.coaching.table.employee')}</TableHead>
                <TableHead>{t('weldhr.coaching.table.coach')}</TableHead>
                <TableHead>{t('weldhr.coaching.table.category')}</TableHead>
                <TableHead>{t('weldhr.coaching.table.topic')}</TableHead>
                <TableHead>{t('weldhr.coaching.table.client')}</TableHead>
                <TableHead>{t('weldhr.common.status')}</TableHead>
                <TableHead>{t('weldhr.coaching.table.visibility')}</TableHead>
                <TableHead>{t('weldhr.coaching.table.followUp')}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <CoachingRow
                  key={log.id}
                  log={log}
                  canUpdate={canUpdate}
                  canDelete={canDelete}
                  onEdit={() => setDialog({ kind: 'edit', log })}
                />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {dialog?.kind === 'create' && <CoachingDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <CoachingDialog log={dialog.log} onClose={() => setDialog(null)} />}
    </PageBody>
  );
}

function CoachingRow({
  log,
  canUpdate,
  canDelete,
  onEdit,
}: {
  log: HrCoachingLog;
  canUpdate: boolean;
  canDelete: boolean;
  onEdit: () => void;
}) {
  const t = useTranslations();
  const updateCoaching = useUpdateHrCoaching();
  const [failure, setFailure] = useState<string | null>(null);

  const followUpDue = Boolean(log.followUpDate) && log.followUpDate! <= todayIso() && log.status !== 'closed';

  async function closeSession() {
    setFailure(null);
    try {
      await updateCoaching.mutateAsync({ id: log.id, status: 'closed' });
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  return (
    <TableRow>
      <TableCell>{formatDate(log.sessionDate)}</TableCell>
      <TableCell>
        <Link
          to="/weldhr/employees/$employeeId"
          params={{ employeeId: log.employeeId }}
          className="flex items-center gap-2 hover:underline"
        >
          <EmployeeAvatar name={log.employeeName ?? ''} className="h-6 w-6" />
          <span className="truncate">{log.employeeName}</span>
        </Link>
      </TableCell>
      <TableCell>{log.coachName ?? '—'}</TableCell>
      <TableCell>{t(`weldhr.status.coachingCategory.${log.category}`)}</TableCell>
      <TableCell className="max-w-xs whitespace-normal">
        <p className="truncate font-medium">{log.topic}</p>
        {log.acknowledgedAt && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            {t('weldhr.coaching.table.acknowledged')}
          </p>
        )}
        {log.employeeComment && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">“{log.employeeComment}”</p>
        )}
      </TableCell>
      <TableCell>{log.companyName ?? '—'}</TableCell>
      <TableCell>
        <StatusBadge group="coaching" status={log.status} />
      </TableCell>
      <TableCell>
        <Badge variant={log.visibility === 'internal' ? 'secondary' : 'outline'}>
          {t(`weldhr.status.visibility.${log.visibility}`)}
        </Badge>
      </TableCell>
      <TableCell className={cn(followUpDue && 'font-medium text-amber-600 dark:text-amber-400')}>
        {formatDate(log.followUpDate)}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {canUpdate && log.status !== 'closed' && (
            <Button variant="ghost" size="sm" onClick={() => void closeSession()} disabled={updateCoaching.isPending}>
              {t('weldhr.coaching.closeSession')}
            </Button>
          )}
          {canUpdate && (
            <Button variant="ghost" size="sm" onClick={onEdit}>
              {t('weldhr.common.edit')}
            </Button>
          )}
          {canDelete && <DeleteCoachingButton logId={log.id} />}
        </div>
        {failure && <p className="mt-1 text-xs text-destructive">{failure}</p>}
      </TableCell>
    </TableRow>
  );
}

function DeleteCoachingButton({ logId }: { logId: string }) {
  const t = useTranslations();
  const deleteCoaching = useDeleteHrCoaching();

  async function remove() {
    if (!confirm(t('weldhr.common.confirmDelete'))) return;
    try {
      await deleteCoaching.mutateAsync(logId);
    } catch {
      // Surfaced via the row's own error state on next render if needed.
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={deleteCoaching.isPending}>
      {t('weldhr.common.delete')}
    </Button>
  );
}
