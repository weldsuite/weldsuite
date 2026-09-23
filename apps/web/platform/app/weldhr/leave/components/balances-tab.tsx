/** Leave → Balances: pick an employee, see allowance/used/pending/remaining per type. */

import { useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { useHrLeaveBalances, useSetHrLeaveAllowance } from '@/hooks/queries/use-weldhr-queries';
import { EmployeePicker, ErrorBanner, InlineSpinner, errorMessage, todayIso } from '../../components/shared';

const CURRENT_YEAR = Number(todayIso().slice(0, 4));
const YEARS = [CURRENT_YEAR - 1, CURRENT_YEAR, CURRENT_YEAR + 1];

export function BalancesTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canEdit = can('leave:update');

  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(null);
  const [year, setYear] = useState(CURRENT_YEAR);
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const { data: balances, isLoading, error } = useHrLeaveBalances(employeeId ?? undefined, year);
  const setAllowance = useSetHrLeaveAllowance();

  async function saveAllowance(leaveTypeId: string) {
    if (!employeeId) return;
    setFailure(null);
    try {
      await setAllowance.mutateAsync({ employeeId, leaveTypeId, year, days: Number(editValue) || 0 });
      setEditingTypeId(null);
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.leave.balances.saveFailed')));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64 space-y-1">
          <label className="text-xs text-muted-foreground">{t('weldhr.attendance.records.filters.employee')}</label>
          <EmployeePicker
            value={employeeId}
            valueLabel={employeeLabel}
            onChange={(id, label) => {
              setEmployeeId(id);
              setEmployeeLabel(label);
              setEditingTypeId(null);
            }}
          />
        </div>
        <div className="w-28 space-y-1">
          <label className="text-xs text-muted-foreground">{t('weldhr.leave.balances.year')}</label>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YEARS.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ErrorBanner error={failure ?? (error ? errorMessage(error, t('weldhr.leave.balances.loadFailed')) : null)} />

      {!employeeId ? (
        <p className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {t('weldhr.leave.balances.selectEmployee')}
        </p>
      ) : isLoading ? (
        <InlineSpinner />
      ) : !balances || balances.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {t('weldhr.leave.balances.empty')}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.leave.balances.table.type')}</TableHead>
                <TableHead>{t('weldhr.leave.balances.table.allowance')}</TableHead>
                <TableHead>{t('weldhr.leave.balances.table.used')}</TableHead>
                <TableHead>{t('weldhr.leave.balances.table.pending')}</TableHead>
                <TableHead>{t('weldhr.leave.balances.table.remaining')}</TableHead>
                {canEdit && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {balances.map((balance) => (
                <TableRow key={balance.leaveTypeId}>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: balance.color ?? '#94a3b8' }} />
                      {balance.name}
                    </span>
                  </TableCell>
                  <TableCell>
                    {editingTypeId === balance.leaveTypeId ? (
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min={0}
                          step={0.5}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="h-7 w-20"
                        />
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void saveAllowance(balance.leaveTypeId)}>
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingTypeId(null)}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : balance.allowance === null ? (
                      t('weldhr.leave.balances.unlimited')
                    ) : (
                      balance.allowance
                    )}
                  </TableCell>
                  <TableCell>{balance.used}</TableCell>
                  <TableCell>{balance.pending}</TableCell>
                  <TableCell>{balance.remaining ?? '—'}</TableCell>
                  {canEdit && (
                    <TableCell>
                      {editingTypeId !== balance.leaveTypeId && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => {
                            setEditingTypeId(balance.leaveTypeId);
                            setEditValue(String(balance.allowance ?? 0));
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
