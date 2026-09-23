/** Milestones sub-tab: goals, milestones and certifications across the workforce. */

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
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
import type { HrMilestone, HrMilestoneStatus } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useDeleteHrMilestone,
  useHrMilestones,
  useUpdateHrMilestone,
} from '@/hooks/queries/use-weldhr-queries';
import {
  CompanyPicker,
  EmployeePicker,
  EmptyState,
  ErrorBanner,
  InlineSpinner,
  StatusBadge,
  errorMessage,
  formatDate,
} from '../../components/shared';
import { MilestoneDialog } from './milestone-dialog';
import { ShareBadge } from './kpis-tab';

const STATUSES: HrMilestoneStatus[] = ['planned', 'in_progress', 'achieved', 'missed'];

type DialogState = { kind: 'create' } | { kind: 'edit'; milestone: HrMilestone } | null;

export function MilestonesTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('evaluations:create');
  const canUpdate = can('evaluations:update');
  const canDelete = can('evaluations:delete');

  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(null);
  const [status, setStatus] = useState('all');
  const [dialog, setDialog] = useState<DialogState>(null);

  const { data: milestones, isLoading, error } = useHrMilestones({
    employeeId: employeeId ?? undefined,
    companyId: companyId ?? undefined,
    status: status === 'all' ? undefined : status,
  });
  const updateMilestone = useUpdateHrMilestone();
  const deleteMilestone = useDeleteHrMilestone();

  async function markAchieved(id: string) {
    try {
      await updateMilestone.mutateAsync({ id, status: 'achieved' });
    } catch {
      // The list refetches regardless; nothing further to surface inline.
    }
  }

  async function remove(id: string) {
    if (!confirm(t('weldhr.common.confirmDelete'))) return;
    try {
      await deleteMilestone.mutateAsync(id);
    } catch {
      // Same as above.
    }
  }

  return (
    <div className="space-y-4">
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
          <p className="text-xs text-muted-foreground">{t('weldhr.common.status')}</p>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('weldhr.common.all')}</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`weldhr.status.milestone.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {canCreate && (
          <Button className="ml-auto" onClick={() => setDialog({ kind: 'create' })}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldhr.performance.milestones.addMilestone')}
          </Button>
        )}
      </Card>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.common.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !milestones || milestones.length === 0 ? (
        <EmptyState title={t('weldhr.performance.milestones.empty')} />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.common.employee')}</TableHead>
                <TableHead>{t('weldhr.performance.milestones.table.title')}</TableHead>
                <TableHead>{t('weldhr.performance.milestones.table.type')}</TableHead>
                <TableHead>{t('weldhr.common.status')}</TableHead>
                <TableHead>{t('weldhr.performance.milestones.table.due')}</TableHead>
                <TableHead>{t('weldhr.performance.milestones.table.achieved')}</TableHead>
                <TableHead>{t('weldhr.performance.milestones.table.shared')}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {milestones.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Link
                      to="/weldhr/employees/$employeeId"
                      params={{ employeeId: m.employeeId }}
                      className="hover:underline"
                    >
                      {m.employeeName}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-xs truncate font-medium">{m.title}</TableCell>
                  <TableCell>{t(`weldhr.status.milestoneType.${m.type}`)}</TableCell>
                  <TableCell>
                    <StatusBadge group="milestone" status={m.status} />
                  </TableCell>
                  <TableCell>{formatDate(m.dueDate)}</TableCell>
                  <TableCell>{formatDate(m.achievedAt)}</TableCell>
                  <TableCell>
                    <ShareBadge shared={m.sharedWithClient} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {canUpdate && m.status !== 'achieved' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void markAchieved(m.id)}
                          disabled={updateMilestone.isPending}
                        >
                          <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                          {t('weldhr.performance.milestones.markAchieved')}
                        </Button>
                      )}
                      {canUpdate && (
                        <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'edit', milestone: m })}>
                          {t('weldhr.common.edit')}
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void remove(m.id)}
                          disabled={deleteMilestone.isPending}
                        >
                          {t('weldhr.common.delete')}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {dialog?.kind === 'create' && <MilestoneDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && (
        <MilestoneDialog milestone={dialog.milestone} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
