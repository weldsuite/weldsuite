import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useUpdateLockDates } from '@/hooks/queries/use-accounting-queries';
import type { AccountingEntity, UpdateLockDatesInput } from '@/lib/api/domains/weldbooks';
import { toCalendarDate } from '@/lib/weldbooks/format';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useI18n } from '@/lib/i18n/provider';

type SoftLockField = 'salesLockDate' | 'purchaseLockDate' | 'taxLockDate' | 'periodLockDate';

const SOFT_LOCKS: ReadonlyArray<{ field: SoftLockField; label: 'sales' | 'purchase' | 'tax' | 'period' }> = [
  { field: 'salesLockDate', label: 'sales' },
  { field: 'purchaseLockDate', label: 'purchase' },
  { field: 'taxLockDate', label: 'tax' },
  { field: 'periodLockDate', label: 'period' },
];

type LockValues = Record<SoftLockField | 'hardLockDate', string>;

function valuesFrom(entity: AccountingEntity): LockValues {
  return {
    salesLockDate: toCalendarDate(entity.salesLockDate) ?? '',
    purchaseLockDate: toCalendarDate(entity.purchaseLockDate) ?? '',
    taxLockDate: toCalendarDate(entity.taxLockDate) ?? '',
    periodLockDate: toCalendarDate(entity.periodLockDate) ?? '',
    hardLockDate: toCalendarDate(entity.hardLockDate) ?? '',
  };
}

interface LockDatesCardProps {
  entity: AccountingEntity;
  canUpdate: boolean;
}

/**
 * Sales / purchase / tax / period lock dates plus the hard lock. The hard
 * lock only moves forward and is confirmed separately, because it can never
 * be undone.
 */
export function LockDatesCard({ entity, canUpdate }: Readonly<LockDatesCardProps>) {
  const { t } = useI18n();
  const tl = t.accounting.lockDates;
  const { formatDate } = useWeldbooksFormat();
  const updateLockDates = useUpdateLockDates();

  const saved = useMemo(() => valuesFrom(entity), [entity]);
  const [values, setValues] = useState<LockValues>(saved);
  const [confirmHard, setConfirmHard] = useState(false);

  useEffect(() => {
    setValues(saved);
  }, [saved]);

  const hardChanged = values.hardLockDate !== saved.hardLockDate && values.hardLockDate !== '';
  const hardBackwards = hardChanged && saved.hardLockDate !== '' && values.hardLockDate < saved.hardLockDate;
  const dirty = (Object.keys(values) as Array<keyof LockValues>).some((key) => values[key] !== saved[key]);

  const buildPayload = (): UpdateLockDatesInput => {
    const payload: UpdateLockDatesInput = {};
    for (const { field } of SOFT_LOCKS) {
      if (values[field] !== saved[field]) payload[field] = values[field] || null;
    }
    if (hardChanged) payload.hardLockDate = values.hardLockDate;
    return payload;
  };

  const save = async () => {
    try {
      await updateLockDates.mutateAsync({ id: entity.id, data: buildPayload() });
      toast.success(tl.saved);
      setConfirmHard(false);
    } catch (err) {
      toast.error(tl.saveFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const onSave = () => {
    if (hardBackwards) return;
    if (hardChanged) {
      setConfirmHard(true);
      return;
    }
    void save();
  };

  const disabled = !canUpdate || updateLockDates.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-4 w-4" aria-hidden />
          {tl.title}
        </CardTitle>
        <CardDescription>{tl.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!canUpdate && <p className="text-sm text-muted-foreground">{tl.noPermission}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {SOFT_LOCKS.map(({ field, label }) => {
            const id = `lock-${field}`;
            return (
              <div key={field} className="space-y-2">
                <Label htmlFor={id}>{tl[label]}</Label>
                <div className="flex gap-2">
                  <Input
                    id={id}
                    type="date"
                    value={values[field]}
                    disabled={disabled}
                    aria-describedby={`${id}-help`}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
                  />
                  {values[field] && canUpdate ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => setValues((prev) => ({ ...prev, [field]: '' }))}
                    >
                      {tl.clear}
                    </Button>
                  ) : null}
                </div>
                <p id={`${id}-help`} className="text-xs text-muted-foreground">
                  {tl[`${label}Help`]}
                </p>
              </div>
            );
          })}
        </div>

        <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-4">
          <Label htmlFor="lock-hardLockDate">{tl.hard}</Label>
          <Input
            id="lock-hardLockDate"
            type="date"
            className="sm:max-w-xs"
            value={values.hardLockDate}
            min={saved.hardLockDate || undefined}
            disabled={disabled}
            aria-describedby="lock-hardLockDate-help"
            onChange={(e) => setValues((prev) => ({ ...prev, hardLockDate: e.target.value }))}
          />
          <p id="lock-hardLockDate-help" className="text-xs text-muted-foreground">
            {saved.hardLockDate ? tl.hardCurrent.replace('{date}', formatDate(saved.hardLockDate)) : tl.hardHelp}
          </p>
          {hardBackwards && <p className="text-sm text-destructive">{tl.hardBackwards}</p>}
        </div>

        {canUpdate && (
          <div className="flex justify-end">
            <Button type="button" onClick={onSave} disabled={!dirty || hardBackwards || updateLockDates.isPending}>
              {updateLockDates.isPending ? tl.saving : tl.save}
            </Button>
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmHard}
        onOpenChange={setConfirmHard}
        title={tl.hardConfirmTitle}
        description={tl.hardConfirmDescription.replace('{date}', formatDate(values.hardLockDate))}
        confirmLabel={tl.hardConfirm}
        cancelLabel={tl.cancel}
        variant="destructive"
        loading={updateLockDates.isPending}
        onConfirm={save}
      />
    </Card>
  );
}
