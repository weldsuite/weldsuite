/** Add or edit a single KPI value for one employee/period. */

import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrKpiValue } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useCreateHrKpiValue,
  useHrKpis,
  useUpdateHrKpiValue,
} from '@/hooks/queries/use-weldhr-queries';
import {
  CompanyPicker,
  EmployeePicker,
  ErrorBanner,
  errorMessage,
} from '../../components/shared';

export function KpiValueDialog({
  value,
  kpiId: initialKpiId,
  employeeId: lockedEmployeeId,
  employeeLabel: lockedEmployeeLabel,
  onClose,
}: {
  value?: HrKpiValue | null;
  kpiId?: string;
  employeeId?: string;
  employeeLabel?: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const isEdit = Boolean(value);
  const { data: kpis } = useHrKpis();
  const createValue = useCreateHrKpiValue();
  const updateValue = useUpdateHrKpiValue();

  const [kpiId, setKpiId] = useState(value?.kpiId ?? initialKpiId ?? '');
  const [empId, setEmpId] = useState<string | null>(value?.employeeId ?? lockedEmployeeId ?? null);
  const [empLabel, setEmpLabel] = useState<string | null>(value?.employeeName ?? lockedEmployeeLabel ?? null);
  const [companyId, setCompanyId] = useState<string | null>(value?.companyId ?? null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(null);
  const [periodStart, setPeriodStart] = useState(value?.periodStart ?? '');
  const [periodEnd, setPeriodEnd] = useState(value?.periodEnd ?? '');
  const [amount, setAmount] = useState(value ? String(value.value) : '');
  const [sharedWithClient, setSharedWithClient] = useState(value?.sharedWithClient ?? false);
  const [failure, setFailure] = useState<string | null>(null);

  const pending = createValue.isPending || updateValue.isPending;

  async function submit() {
    const numeric = Number(amount);
    if (!kpiId || !empId || !periodStart || !periodEnd || amount === '' || Number.isNaN(numeric)) return;
    setFailure(null);
    try {
      if (isEdit && value) {
        await updateValue.mutateAsync({
          id: value.id,
          companyId,
          periodStart,
          periodEnd,
          value: numeric,
          sharedWithClient,
        });
      } else {
        await createValue.mutateAsync({
          kpiId,
          employeeId: empId,
          companyId,
          periodStart,
          periodEnd,
          value: numeric,
          sharedWithClient,
        });
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.performance.kpis.dialog.saveFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('weldhr.performance.kpis.dialog.editTitle') : t('weldhr.performance.kpis.dialog.createTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label>{t('weldhr.performance.kpis.dialog.kpi')}</Label>
            <Select value={kpiId} onValueChange={setKpiId} disabled={isEdit}>
              <SelectTrigger>
                <SelectValue placeholder={t('weldhr.performance.kpis.selectKpi')} />
              </SelectTrigger>
              <SelectContent>
                {(kpis ?? []).map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('weldhr.common.employee')}</Label>
              <EmployeePicker
                value={empId}
                valueLabel={empLabel}
                onChange={(id, label) => {
                  setEmpId(id);
                  setEmpLabel(label);
                }}
                disabled={isEdit || Boolean(lockedEmployeeId)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.common.client')}</Label>
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
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="kpi-value-period-start">{t('weldhr.common.from')}</Label>
              <Input
                id="kpi-value-period-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kpi-value-period-end">{t('weldhr.common.to')}</Label>
              <Input
                id="kpi-value-period-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kpi-value-amount">{t('weldhr.performance.kpis.dialog.value')}</Label>
              <Input
                id="kpi-value-amount"
                type="number"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">{t('weldhr.common.sharedWithClient')}</p>
              <p className="text-xs text-muted-foreground">{t('weldhr.common.sharedWithClientHint')}</p>
            </div>
            <Switch checked={sharedWithClient} onCheckedChange={setSharedWithClient} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={pending || !kpiId || !empId || !periodStart || !periodEnd || amount === ''}
          >
            {pending ? t('weldhr.common.saving') : t('weldhr.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
