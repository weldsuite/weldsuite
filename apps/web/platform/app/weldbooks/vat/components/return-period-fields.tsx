import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { lastFinishedPeriod, monthNames, type ReturnPeriod, type ReturnPeriodType } from '../return-periods';

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];

interface ReturnPeriodFieldsProps {
  periodType: ReturnPeriodType;
  period: ReturnPeriod;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  /** Why the typed-in dates can't be filed, shown under them. */
  periodError: string | null;
  /** A month, quarter or year was picked: fill in its dates and label. */
  onPick: (type: ReturnPeriodType, period: ReturnPeriod) => void;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onLabelChange: (value: string) => void;
}

/**
 * The period of a BTW-aangifte or Opgaaf ICP: pick the type and the month,
 * quarter or year, which fills in the dates and label. The dates stay editable.
 */
export function ReturnPeriodFields({
  periodType,
  period,
  periodStart,
  periodEnd,
  periodLabel,
  periodError,
  onPick,
  onStartChange,
  onEndChange,
  onLabelChange,
}: Readonly<ReturnPeriodFieldsProps>) {
  const { t, language } = useI18n();
  const tv = t.accounting.vat;
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => currentYear + 1 - i);
  const indexOptions = periodType === 'monthly' ? monthNames(language) : QUARTERS;
  const invalid = periodError ? true : undefined;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="vat-period-type">{tv.periodType}</Label>
        <Select
          value={periodType}
          onValueChange={(value) => {
            const type = value as ReturnPeriodType;
            onPick(type, lastFinishedPeriod(type, new Date()));
          }}
        >
          <SelectTrigger id="vat-period-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="monthly">{tv.periodTypes.monthly}</SelectItem>
            <SelectItem value="quarterly">{tv.periodTypes.quarterly}</SelectItem>
            <SelectItem value="yearly">{tv.periodTypes.annual}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="vat-period-year">{tv.periodYear}</Label>
          <Select value={String(period.year)} onValueChange={(value) => onPick(periodType, { ...period, year: Number(value) })}>
            <SelectTrigger id="vat-period-year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((year) => (
                <SelectItem key={year} value={String(year)}>{year}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {periodType === 'yearly' ? null : (
          <div className="space-y-2">
            <Label htmlFor="vat-period-index">{periodType === 'monthly' ? tv.periodMonth : tv.periodQuarter}</Label>
            <Select value={String(period.index)} onValueChange={(value) => onPick(periodType, { ...period, index: Number(value) })}>
              <SelectTrigger id="vat-period-index">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {indexOptions.map((name, index) => (
                  <SelectItem key={name} value={String(index)}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="vat-period-start">{tv.periodStart}</Label>
          <Input
            id="vat-period-start"
            type="date"
            value={periodStart}
            aria-invalid={invalid}
            onChange={(e) => onStartChange(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="vat-period-end">{tv.periodEnd}</Label>
          <Input
            id="vat-period-end"
            type="date"
            value={periodEnd}
            aria-invalid={invalid}
            onChange={(e) => onEndChange(e.target.value)}
          />
        </div>
      </div>
      {periodError ? <p role="alert" className="text-sm text-destructive">{periodError}</p> : null}
      <div className="space-y-2">
        <Label htmlFor="vat-period-label">{tv.periodLabel}</Label>
        <Input
          id="vat-period-label"
          placeholder={tv.periodLabelPlaceholder}
          value={periodLabel}
          onChange={(e) => onLabelChange(e.target.value)}
        />
      </div>
    </div>
  );
}
