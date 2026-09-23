/** KPIs sub-tab: values per employee for a KPI over a period, with add/edit/delete. */

import { useState } from 'react';
import { Check, Plus, Share2, X } from 'lucide-react';
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
import type { HrKpiValue } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useDeleteHrKpiValue,
  useHrKpis,
  useHrKpiValues,
} from '@/hooks/queries/use-weldhr-queries';
import {
  EmptyState,
  ErrorBanner,
  InlineSpinner,
  errorMessage,
  formatDate,
  formatKpiValue,
} from '../../components/shared';
import { KpiValueDialog } from './kpi-value-dialog';

type DialogState = { kind: 'create' } | { kind: 'edit'; value: HrKpiValue } | null;

export function KpisTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('evaluations:create');
  const canUpdate = can('evaluations:update');
  const canDelete = can('evaluations:delete');

  const { data: kpis } = useHrKpis();
  const [kpiId, setKpiId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);

  const { data: values, isLoading, error } = useHrKpiValues({
    kpiId: kpiId === 'all' ? undefined : kpiId,
    from: from || undefined,
    to: to || undefined,
  });
  const deleteValue = useDeleteHrKpiValue();

  async function remove(id: string) {
    if (!confirm(t('weldhr.common.confirmDelete'))) return;
    try {
      await deleteValue.mutateAsync(id);
    } catch {
      // Row keeps its own optimistic state; the list simply refetches.
    }
  }

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-56 space-y-1">
          <p className="text-xs text-muted-foreground">{t('weldhr.performance.kpis.selectKpi')}</p>
          <Select value={kpiId} onValueChange={setKpiId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('weldhr.common.all')}</SelectItem>
              {(kpis ?? []).map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.name}
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
        {canCreate && (
          <Button className="ml-auto" onClick={() => setDialog({ kind: 'create' })}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldhr.performance.kpis.addValue')}
          </Button>
        )}
      </Card>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.common.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !values || values.length === 0 ? (
        <EmptyState title={t('weldhr.performance.kpis.empty')} />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.performance.kpis.table.employee')}</TableHead>
                <TableHead>{t('weldhr.performance.kpis.table.kpi')}</TableHead>
                <TableHead>{t('weldhr.evaluations.table.period')}</TableHead>
                <TableHead>{t('weldhr.performance.kpis.table.value')}</TableHead>
                <TableHead>{t('weldhr.performance.kpis.table.target')}</TableHead>
                <TableHead>{t('weldhr.performance.kpis.table.onTarget')}</TableHead>
                <TableHead>{t('weldhr.performance.kpis.table.shared')}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {values.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>{v.employeeName}</TableCell>
                  <TableCell>{v.kpiName}</TableCell>
                  <TableCell>
                    {formatDate(v.periodStart)} – {formatDate(v.periodEnd)}
                  </TableCell>
                  <TableCell className="font-medium tabular-nums">{formatKpiValue(v.value, v.unit)}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {v.target === null ? '—' : formatKpiValue(v.target, v.unit)}
                  </TableCell>
                  <TableCell>
                    {v.onTarget === null ? (
                      '—'
                    ) : v.onTarget ? (
                      <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <X className="h-4 w-4 text-destructive" />
                    )}
                  </TableCell>
                  <TableCell>
                    {v.sharedWithClient && <Share2 className="h-4 w-4 text-muted-foreground" />}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {canUpdate && (
                        <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'edit', value: v })}>
                          {t('weldhr.common.edit')}
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void remove(v.id)}
                          disabled={deleteValue.isPending}
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

      {dialog?.kind === 'create' && <KpiValueDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <KpiValueDialog value={dialog.value} onClose={() => setDialog(null)} />}
    </div>
  );
}

export function ShareBadge({ shared }: { shared: boolean }) {
  const t = useTranslations();
  if (!shared) return null;
  return (
    <Badge variant="outline" className="gap-1">
      <Share2 className="h-3 w-3" />
      {t('weldhr.common.sharedWithClient')}
    </Badge>
  );
}
