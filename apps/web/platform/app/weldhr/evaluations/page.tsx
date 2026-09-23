/** WeldHR — evaluations list with scoring entry point. */

import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, Share2 } from 'lucide-react';
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
import type { HrEvaluationStatus } from '@weldsuite/app-api-client/domains/weldhr';
import { useHrEvaluationForms, useHrEvaluations } from '@/hooks/queries/use-weldhr-queries';
import {
  CompanyPicker,
  EmployeeAvatar,
  EmployeePicker,
  EmptyState,
  ErrorBanner,
  InlineSpinner,
  PageBody,
  PageHeader,
  ScoreBadge,
  StatusBadge,
  errorMessage,
  formatDate,
} from '../components/shared';
import { EvaluationDialog } from './components/evaluation-dialog';

const STATUSES: HrEvaluationStatus[] = ['draft', 'submitted', 'acknowledged'];

export default function WeldHrEvaluationsPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canCreate = can('evaluations:create');

  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(null);
  const [formId, setFormId] = useState('all');
  const [status, setStatus] = useState('all');
  const [creating, setCreating] = useState(false);

  const { data: forms } = useHrEvaluationForms();
  const { data: evaluations, isLoading, error } = useHrEvaluations({
    employeeId: employeeId ?? undefined,
    companyId: companyId ?? undefined,
    formId: formId === 'all' ? undefined : formId,
    status: status === 'all' ? undefined : status,
  });

  return (
    <PageBody wide>
      <PageHeader
        title={t('weldhr.evaluations.title')}
        subtitle={t('weldhr.evaluations.subtitle')}
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.evaluations.newEvaluation')}
            </Button>
          )
        }
      />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-48 space-y-1">
          <p className="text-xs text-muted-foreground">{t('weldhr.evaluations.filters.employee')}</p>
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
          <p className="text-xs text-muted-foreground">{t('weldhr.evaluations.filters.client')}</p>
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
        <div className="w-44 space-y-1">
          <p className="text-xs text-muted-foreground">{t('weldhr.evaluations.filters.form')}</p>
          <Select value={formId} onValueChange={setFormId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('weldhr.common.all')}</SelectItem>
              {(forms ?? []).map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
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
                  {t(`weldhr.status.evaluation.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.common.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !evaluations || evaluations.length === 0 ? (
        <EmptyState
          title={t('weldhr.evaluations.empty.title')}
          description={t('weldhr.evaluations.empty.description')}
          action={
            canCreate ? (
              <Button onClick={() => setCreating(true)}>{t('weldhr.evaluations.newEvaluation')}</Button>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.evaluations.table.employee')}</TableHead>
                <TableHead>{t('weldhr.evaluations.table.form')}</TableHead>
                <TableHead>{t('weldhr.evaluations.table.period')}</TableHead>
                <TableHead>{t('weldhr.evaluations.table.evaluator')}</TableHead>
                <TableHead>{t('weldhr.evaluations.table.score')}</TableHead>
                <TableHead>{t('weldhr.common.status')}</TableHead>
                <TableHead>{t('weldhr.evaluations.table.shared')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {evaluations.map((evaluation) => (
                <TableRow
                  key={evaluation.id}
                  className="cursor-pointer"
                  onClick={() =>
                    void navigate({
                      to: '/weldhr/evaluations/$evaluationId',
                      params: { evaluationId: evaluation.id },
                    })
                  }
                >
                  <TableCell>
                    <Link
                      to="/weldhr/employees/$employeeId"
                      params={{ employeeId: evaluation.employeeId }}
                      className="flex items-center gap-2 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <EmployeeAvatar name={evaluation.employeeName ?? ''} className="h-6 w-6" />
                      <span className="truncate">{evaluation.employeeName}</span>
                    </Link>
                  </TableCell>
                  <TableCell>{evaluation.formName ?? '—'}</TableCell>
                  <TableCell>
                    {evaluation.periodStart || evaluation.periodEnd
                      ? `${formatDate(evaluation.periodStart)} – ${formatDate(evaluation.periodEnd)}`
                      : t('weldhr.evaluations.table.noPeriod')}
                  </TableCell>
                  <TableCell>{evaluation.evaluatorName ?? '—'}</TableCell>
                  <TableCell>
                    <ScoreBadge score={evaluation.overallScore} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge group="evaluation" status={evaluation.status} />
                  </TableCell>
                  <TableCell>
                    {evaluation.sharedWithClient && <Share2 className="h-4 w-4 text-muted-foreground" />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {creating && <EvaluationDialog onClose={() => setCreating(false)} />}
    </PageBody>
  );
}
