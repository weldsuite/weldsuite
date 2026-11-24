/** My HR → Schedule: the period the Shifts and Hours tabs show, picked in the list's top bar. */

import { endOfMonth, format, startOfMonth, subMonths } from 'date-fns';
import { useTranslations } from '@weldsuite/i18n/client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { shiftIsoDate, todayIso } from '../../components/shared';

export const MY_PERIODS = ['around', 'thisMonth', 'lastMonth', 'last3Months'] as const;
export type MyPeriod = (typeof MY_PERIODS)[number];

const iso = (date: Date) => format(date, 'yyyy-MM-dd');

/** The dates a period covers; never more than the 92 days the API accepts. */
export function periodRange(period: MyPeriod): { from: string; to: string } {
  const today = todayIso();
  const now = new Date(`${today}T12:00:00`);
  switch (period) {
    case 'thisMonth':
      return { from: iso(startOfMonth(now)), to: iso(endOfMonth(now)) };
    case 'lastMonth': {
      const last = subMonths(now, 1);
      return { from: iso(startOfMonth(last)), to: iso(endOfMonth(last)) };
    }
    case 'last3Months':
      return { from: shiftIsoDate(today, -91), to: today };
    default:
      return { from: shiftIsoDate(today, -29), to: shiftIsoDate(today, 14) };
  }
}

export function PeriodSelect({ value, onChange }: Readonly<{ value: MyPeriod; onChange: (period: MyPeriod) => void }>) {
  const t = useTranslations();
  return (
    <Select value={value} onValueChange={(next) => onChange(next as MyPeriod)}>
      <SelectTrigger size="sm" className="h-8 w-auto gap-1.5 shadow-none" aria-label={t('weldhr.me.schedule.period.label')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {MY_PERIODS.map((period) => (
          <SelectItem key={period} value={period}>
            {t(`weldhr.me.schedule.period.${period}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
