/** Personal data card: encrypted, audited, revealed on demand, edited inline. */

import { useEffect, useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrEmployeeSensitive } from '@weldsuite/app-api-client/domains/weldhr';
import { useHrEmployeeSensitive, useUpdateHrEmployeeSensitive } from '@/hooks/queries/use-weldhr-queries';
import { errorMessage, formatDate, formatKpiValue, formatMoney, todayIso } from '../../components/shared';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';

export function SensitivePanel({ employeeId }: Readonly<{ employeeId: string }>) {
  const t = useTranslations();
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const { data, isLoading, error } = useHrEmployeeSensitive(employeeId, revealed);

  let body: ReactNode;
  if (isLoading) {
    body = (
      <div className="flex justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (editing) {
    body = <SensitiveForm employeeId={employeeId} data={data ?? null} onDone={() => setEditing(false)} />;
  } else {
    body = <SensitiveView data={data ?? null} onEdit={() => setEditing(true)} />;
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">{t('weldhr.employees.detail.personalTab.title')}</p>
            <p className="text-xs text-muted-foreground">{t('weldhr.employees.detail.personalTab.encryptedNotice')}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setRevealed((v) => !v);
            setEditing(false);
          }}
        >
          {revealed ? (
            <>
              <EyeOff className="mr-1.5 h-4 w-4" />
              {t('weldhr.employees.detail.personalTab.hide')}
            </>
          ) : (
            <>
              <Eye className="mr-1.5 h-4 w-4" />
              {t('weldhr.employees.detail.personalTab.show')}
            </>
          )}
        </Button>
      </div>

      {revealed && (
        <div className="mt-4 border-t pt-4">
          <ErrorBanner error={error ? errorMessage(error, t('weldhr.employees.detail.personalTab.loadFailed')) : null} />
          {body}
        </div>
      )}
    </Card>
  );
}

function Field({ label, value, tabular }: Readonly<{ label: string; value: string | null | undefined; tabular?: boolean }>) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={tabular ? 'text-sm tabular-nums' : 'text-sm'}>{value || '—'}</p>
    </div>
  );
}

function SensitiveView({ data, onEdit }: Readonly<{ data: HrEmployeeSensitive | null; onEdit: () => void }>) {
  const t = useTranslations();
  let salary: string | null = null;
  if (data?.salaryAmount !== null && data?.salaryAmount !== undefined) {
    // "€ 4.000,00 / month"; without a currency the bare amount, without a period no " /" (TASK-1471).
    const amount = data.salaryCurrency
      ? formatMoney(data.salaryAmount, data.salaryCurrency)
      : formatKpiValue(data.salaryAmount, 'number');
    const periodKey = `weldhr.employees.detail.personalTab.salaryPeriod.${data.salaryPeriod}`;
    salary = data.salaryPeriod ? `${amount} / ${t(periodKey)}` : amount;
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label={t('weldhr.employees.detail.personalTab.fields.dateOfBirth')} value={formatDate(data?.dateOfBirth)} tabular />
        <Field label={t('weldhr.employees.detail.personalTab.fields.nationalId')} value={data?.nationalId} />
        <Field label={t('weldhr.employees.detail.personalTab.fields.taxId')} value={data?.taxId} />
        <Field label={t('weldhr.employees.detail.personalTab.fields.personalEmail')} value={data?.personalEmail} />
        <Field label={t('weldhr.employees.detail.personalTab.fields.personalPhone')} value={data?.personalPhone} />
        <Field label={t('weldhr.employees.detail.personalTab.fields.bankAccount')} value={data?.bankAccount} />
        <Field label={t('weldhr.employees.detail.personalTab.fields.salary')} value={salary} />
        <Field label={t('weldhr.employees.detail.personalTab.fields.emergencyContactName')} value={data?.emergencyContactName} />
        <Field label={t('weldhr.employees.detail.personalTab.fields.emergencyContactPhone')} value={data?.emergencyContactPhone} />
        <Field label={t('weldhr.employees.detail.personalTab.fields.emergencyContactRelation')} value={data?.emergencyContactRelation} />
      </div>
      <Field label={t('weldhr.employees.detail.personalTab.fields.address')} value={data?.address} />
      <Field label={t('weldhr.common.notes')} value={data?.notes} />
      <Button size="sm" variant="outline" onClick={onEdit}>
        {t('weldhr.common.edit')}
      </Button>
    </div>
  );
}

function SensitiveForm({
  employeeId,
  data,
  onDone,
}: Readonly<{
  employeeId: string;
  data: HrEmployeeSensitive | null;
  onDone: () => void;
}>) {
  const t = useTranslations();
  const updateSensitive = useUpdateHrEmployeeSensitive();
  const [form, setForm] = useState<HrEmployeeSensitive>({
    dateOfBirth: data?.dateOfBirth ?? '',
    nationalId: data?.nationalId ?? '',
    taxId: data?.taxId ?? '',
    address: data?.address ?? '',
    personalEmail: data?.personalEmail ?? '',
    personalPhone: data?.personalPhone ?? '',
    emergencyContactName: data?.emergencyContactName ?? '',
    emergencyContactPhone: data?.emergencyContactPhone ?? '',
    emergencyContactRelation: data?.emergencyContactRelation ?? '',
    bankAccount: data?.bankAccount ?? '',
    salaryAmount: data?.salaryAmount ?? undefined,
    salaryCurrency: data?.salaryCurrency ?? '',
    salaryPeriod: data?.salaryPeriod ?? undefined,
    notes: data?.notes ?? '',
  });
  const [failure, setFailure] = useState<string | null>(null);
  // Labels point at their inputs (TASK-1471): one id per field.
  const idBase = useId();
  const fieldId = (name: string) => `${idBase}-${name}`;
  const today = todayIso();
  const birthInFuture = Boolean(form.dateOfBirth && form.dateOfBirth > today);

  // Reset local form whenever the server data resolves for the first time.
  useEffect(() => {
    if (!data) return;
    setForm({ ...data });
  }, [data]);

  function set<K extends keyof HrEmployeeSensitive>(key: K, value: HrEmployeeSensitive[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    setFailure(null);
    if (birthInFuture) return;
    try {
      await updateSensitive.mutateAsync({
        id: employeeId,
        dateOfBirth: form.dateOfBirth || null,
        nationalId: form.nationalId?.trim() || null,
        taxId: form.taxId?.trim() || null,
        address: form.address?.trim() || null,
        personalEmail: form.personalEmail?.trim() || null,
        personalPhone: form.personalPhone?.trim() || null,
        emergencyContactName: form.emergencyContactName?.trim() || null,
        emergencyContactPhone: form.emergencyContactPhone?.trim() || null,
        emergencyContactRelation: form.emergencyContactRelation?.trim() || null,
        bankAccount: form.bankAccount?.trim() || null,
        salaryAmount: form.salaryAmount === undefined || (form.salaryAmount as unknown) === '' ? null : Number(form.salaryAmount),
        salaryCurrency: form.salaryCurrency?.trim() || null,
        salaryPeriod: form.salaryPeriod || null,
        notes: form.notes?.trim() || null,
      });
      toast.success(t('weldhr.employees.detail.personalTab.savedToast'));
      onDone();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.employees.detail.personalTab.saveFailed')));
    }
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('dateOfBirth')}>{t('weldhr.employees.detail.personalTab.fields.dateOfBirth')}</Label>
          <Input
            id={fieldId('dateOfBirth')}
            type="date"
            max={today}
            value={form.dateOfBirth ?? ''}
            onChange={(e) => set('dateOfBirth', e.target.value)}
            aria-invalid={birthInFuture || undefined}
            aria-describedby={birthInFuture ? fieldId('dateOfBirth-error') : undefined}
          />
          {birthInFuture && (
            <p id={fieldId('dateOfBirth-error')} className="text-xs text-destructive">
              {t('weldhr.employees.validation.birthInFuture')}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('nationalId')}>{t('weldhr.employees.detail.personalTab.fields.nationalId')}</Label>
          <Input id={fieldId('nationalId')} value={form.nationalId ?? ''} onChange={(e) => set('nationalId', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('taxId')}>{t('weldhr.employees.detail.personalTab.fields.taxId')}</Label>
          <Input id={fieldId('taxId')} value={form.taxId ?? ''} onChange={(e) => set('taxId', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('personalEmail')}>{t('weldhr.employees.detail.personalTab.fields.personalEmail')}</Label>
          <Input id={fieldId('personalEmail')} type="email" value={form.personalEmail ?? ''} onChange={(e) => set('personalEmail', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('personalPhone')}>{t('weldhr.employees.detail.personalTab.fields.personalPhone')}</Label>
          <Input id={fieldId('personalPhone')} value={form.personalPhone ?? ''} onChange={(e) => set('personalPhone', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('bankAccount')}>{t('weldhr.employees.detail.personalTab.fields.bankAccount')}</Label>
          <Input id={fieldId('bankAccount')} value={form.bankAccount ?? ''} onChange={(e) => set('bankAccount', e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('salaryAmount')}>{t('weldhr.employees.detail.personalTab.fields.salaryAmount')}</Label>
          <Input
            id={fieldId('salaryAmount')}
            type="number"
            min={0}
            value={form.salaryAmount ?? ''}
            onChange={(e) => set('salaryAmount', e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('salaryCurrency')}>{t('weldhr.employees.detail.personalTab.fields.salaryCurrency')}</Label>
          <Input id={fieldId('salaryCurrency')} maxLength={3} value={form.salaryCurrency ?? ''} onChange={(e) => set('salaryCurrency', e.target.value.toUpperCase())} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('salaryPeriod')}>{t('weldhr.employees.detail.personalTab.fields.salaryPeriod')}</Label>
          <Select value={form.salaryPeriod ?? '__none'} onValueChange={(v) => set('salaryPeriod', v === '__none' ? undefined : (v as 'hour' | 'month' | 'year'))}>
            <SelectTrigger id={fieldId('salaryPeriod')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">{t('weldhr.common.none')}</SelectItem>
              <SelectItem value="hour">{t('weldhr.employees.detail.personalTab.salaryPeriod.hour')}</SelectItem>
              <SelectItem value="month">{t('weldhr.employees.detail.personalTab.salaryPeriod.month')}</SelectItem>
              <SelectItem value="year">{t('weldhr.employees.detail.personalTab.salaryPeriod.year')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('emergencyContactName')}>{t('weldhr.employees.detail.personalTab.fields.emergencyContactName')}</Label>
          <Input id={fieldId('emergencyContactName')} value={form.emergencyContactName ?? ''} onChange={(e) => set('emergencyContactName', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fieldId('emergencyContactPhone')}>{t('weldhr.employees.detail.personalTab.fields.emergencyContactPhone')}</Label>
          <Input id={fieldId('emergencyContactPhone')} value={form.emergencyContactPhone ?? ''} onChange={(e) => set('emergencyContactPhone', e.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={fieldId('emergencyContactRelation')}>{t('weldhr.employees.detail.personalTab.fields.emergencyContactRelation')}</Label>
        <Input id={fieldId('emergencyContactRelation')} value={form.emergencyContactRelation ?? ''} onChange={(e) => set('emergencyContactRelation', e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={fieldId('address')}>{t('weldhr.employees.detail.personalTab.fields.address')}</Label>
        <Textarea id={fieldId('address')} rows={2} value={form.address ?? ''} onChange={(e) => set('address', e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={fieldId('notes')}>{t('weldhr.common.notes')}</Label>
        <Textarea id={fieldId('notes')} rows={2} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={updateSensitive.isPending}>
          {t('weldhr.common.cancel')}
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={updateSensitive.isPending || birthInFuture}>
          {updateSensitive.isPending ? t('weldhr.common.saving') : t('weldhr.common.save')}
        </Button>
      </div>
    </div>
  );
}
