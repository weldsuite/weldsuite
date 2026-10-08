import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useI18n } from '@/lib/i18n/provider';

interface DateRangeFilterProps {
  idPrefix: string;
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}

/** From and to dates of a report: the end cannot come before the start. */
export function DateRangeFilter({ idPrefix, from, to, onChange }: Readonly<DateRangeFilterProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.salesTax.center.common;
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-from`}>{tc.from}</Label>
        <Input
          id={`${idPrefix}-from`}
          type="date"
          className="w-40"
          value={from}
          max={to || undefined}
          onChange={(event) => onChange({ from: event.target.value, to })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-to`}>{tc.to}</Label>
        <Input
          id={`${idPrefix}-to`}
          type="date"
          className="w-40"
          value={to}
          min={from || undefined}
          onChange={(event) => onChange({ from, to: event.target.value })}
        />
      </div>
    </>
  );
}

/** The first day of the calendar year of a `YYYY-MM-DD` date. */
export function startOfYear(day: string): string {
  return `${day.slice(0, 4)}-01-01`;
}
