import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Hash } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useNumberSequences, useUpdateNumberSequences } from '@/hooks/queries/use-accounting-queries';
import type { NumberSequence, NumberSequenceType, NumberSequenceUpdate } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

const SEQUENCE_ORDER: readonly NumberSequenceType[] = ['invoice', 'creditNote', 'bill', 'journal'];
const PREFIX_PATTERN = /^[A-Za-z0-9 ._/-]*$/;
const MAX_PADDING = 10;

interface RowValues {
  prefix: string;
  nextValue: string;
  padding: string;
}

type FormValues = Partial<Record<NumberSequenceType, RowValues>>;

function valuesFrom(sequences: readonly NumberSequence[]): FormValues {
  return Object.fromEntries(
    sequences.map((s) => [s.sequenceType, { prefix: s.prefix, nextValue: String(s.nextValue), padding: String(s.padding) }]),
  );
}

/** The whole number in `value`, or null when it isn't one. */
function wholeNumber(value: string): number | null {
  return /^\d+$/.test(value.trim()) ? Number(value) : null;
}

export type RowError = 'prefix' | 'nextValue' | 'backwards' | 'padding';

/** What is wrong with a row, if anything. Exported for tests. */
export function rowError(row: RowValues, saved: NumberSequence): RowError | null {
  if (row.prefix.length > 20 || !PREFIX_PATTERN.test(row.prefix)) return 'prefix';
  const next = wholeNumber(row.nextValue);
  if (next === null || next < 1 || next > 999_999_999) return 'nextValue';
  if (next < saved.nextValue) return 'backwards';
  const padding = wholeNumber(row.padding);
  if (padding === null || padding > MAX_PADDING) return 'padding';
  return null;
}

/** The changed fields of every row, for the PATCH. Exported for tests. */
export function changedSequences(values: FormValues, saved: readonly NumberSequence[]): NumberSequenceUpdate[] {
  const updates: NumberSequenceUpdate[] = [];
  for (const s of saved) {
    const row = values[s.sequenceType];
    if (!row) continue;
    const update: NumberSequenceUpdate = { sequenceType: s.sequenceType };
    if (row.prefix !== s.prefix) update.prefix = row.prefix;
    if (Number(row.nextValue) !== s.nextValue) update.nextValue = Number(row.nextValue);
    if (Number(row.padding) !== s.padding) update.padding = Number(row.padding);
    if (Object.keys(update).length > 1) updates.push(update);
  }
  return updates;
}

function preview(row: RowValues): string {
  const next = wholeNumber(row.nextValue) ?? 0;
  const padding = Math.min(wholeNumber(row.padding) ?? 0, MAX_PADDING);
  return `${row.prefix}${String(next).padStart(padding, '0')}`;
}

interface NumberingCardProps {
  entityId: string;
  canUpdate: boolean;
}

/**
 * Prefix, next number and digits of the entity's invoice, credit note, bill
 * and journal numbers. The next number only moves forward (the server
 * enforces it too), so a number on an existing document is never reused.
 */
export function NumberingCard({ entityId, canUpdate }: Readonly<NumberingCardProps>) {
  const { t } = useI18n();
  const tn = t.accounting.numbering;
  const { data: saved, isLoading } = useNumberSequences(entityId);
  const update = useUpdateNumberSequences();

  const sequences = useMemo(
    () => SEQUENCE_ORDER.map((type) => saved?.find((s) => s.sequenceType === type)).filter((s): s is NumberSequence => !!s),
    [saved],
  );
  const savedValues = useMemo(() => valuesFrom(sequences), [sequences]);
  const [values, setValues] = useState<FormValues>(savedValues);

  useEffect(() => {
    setValues(savedValues);
  }, [savedValues]);

  const errors = Object.fromEntries(
    sequences.map((s) => [s.sequenceType, values[s.sequenceType] ? rowError(values[s.sequenceType]!, s) : null]),
  ) as Partial<Record<NumberSequenceType, RowError | null>>;
  const hasErrors = Object.values(errors).some(Boolean);
  const updates = changedSequences(values, sequences);
  const disabled = !canUpdate || update.isPending;

  const setField = (type: NumberSequenceType, field: keyof RowValues, value: string) =>
    setValues((prev) => ({ ...prev, [type]: { ...prev[type]!, [field]: value } }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (hasErrors || updates.length === 0) return;
    try {
      await update.mutateAsync({ entityId, sequences: updates });
      toast.success(tn.saved);
    } catch (err) {
      toast.error(tn.saveFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hash className="h-4 w-4" aria-hidden />
          {tn.title}
        </CardTitle>
        <CardDescription>{tn.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <PageLoader fullScreen={false} className="min-h-24" />
        ) : (
          <form onSubmit={save} className="space-y-6" noValidate>
            {!canUpdate && <p className="text-sm text-muted-foreground">{tn.noPermission}</p>}

            {sequences.map((s) => {
              const row = values[s.sequenceType];
              if (!row) return null;
              const id = `numbering-${s.sequenceType}`;
              const error = errors[s.sequenceType];
              return (
                <fieldset key={s.sequenceType} className="space-y-2" aria-describedby={`${id}-preview`}>
                  <legend className="text-sm font-medium">{tn.types[s.sequenceType]}</legend>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_6rem]">
                    <div className="space-y-1.5">
                      <Label htmlFor={`${id}-prefix`} className="text-xs text-muted-foreground">{tn.prefix}</Label>
                      <Input
                        id={`${id}-prefix`}
                        value={row.prefix}
                        maxLength={20}
                        disabled={disabled}
                        aria-invalid={error === 'prefix'}
                        onChange={(e) => setField(s.sequenceType, 'prefix', e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${id}-next`} className="text-xs text-muted-foreground">{tn.nextNumber}</Label>
                      <Input
                        id={`${id}-next`}
                        type="number"
                        inputMode="numeric"
                        min={s.nextValue}
                        value={row.nextValue}
                        disabled={disabled}
                        aria-invalid={error === 'nextValue' || error === 'backwards'}
                        onChange={(e) => setField(s.sequenceType, 'nextValue', e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${id}-padding`} className="text-xs text-muted-foreground">{tn.digits}</Label>
                      <Input
                        id={`${id}-padding`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={MAX_PADDING}
                        value={row.padding}
                        disabled={disabled}
                        aria-invalid={error === 'padding'}
                        onChange={(e) => setField(s.sequenceType, 'padding', e.target.value)}
                      />
                    </div>
                  </div>
                  <p id={`${id}-preview`} className="text-xs text-muted-foreground">
                    {tn.preview.replace('{number}', preview(row))}
                  </p>
                  {error ? (
                    <p className="text-sm text-destructive" role="alert">
                      {error === 'backwards'
                        ? tn.errors.backwards.replace('{number}', String(s.nextValue))
                        : tn.errors[error]}
                    </p>
                  ) : null}
                </fieldset>
              );
            })}

            <p className="text-xs text-muted-foreground">{tn.gapNote}</p>

            {canUpdate && (
              <div className="flex justify-end">
                <Button type="submit" disabled={updates.length === 0 || hasErrors || update.isPending}>
                  {update.isPending ? tn.saving : tn.save}
                </Button>
              </div>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
