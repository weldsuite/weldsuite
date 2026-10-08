import { useState } from 'react';
import { CalendarClock, ChevronDown } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { useForm1099Deadlines } from '@/hooks/queries/use-weldbooks-1099-queries';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { daysUntil } from '../form-1099-model';

interface DeadlinesBannerProps {
  year: number;
}

/** The due dates of the year's forms, with the headline one counted down, and the IRIS e-file rule. */
export function DeadlinesBanner({ year }: Readonly<DeadlinesBannerProps>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.form1099.deadlines;
  const { formatDate } = useWeldbooksFormat();
  const query = useForm1099Deadlines(year);
  const [open, setOpen] = useState(false);

  if (query.isLoading || !query.data) return null;
  const d = query.data;
  const days = daysUntil(d.nec.irs);
  const overdue = days < 0;
  const countdown = Number.isNaN(days)
    ? ''
    : days === 0
      ? td.today
      : days > 0
        ? td.inDays.replace('{n}', String(days))
        : td.daysAgo.replace('{n}', String(-days));

  const rows: Array<{ label: string; date: string }> = [
    { label: td.necRecipient, date: d.nec.recipient },
    { label: td.necIrs, date: d.nec.irs },
    { label: td.miscRecipient, date: d.misc.recipient },
    { label: td.miscRecipientBoxes, date: d.misc.recipientBoxes8And10 },
    { label: td.miscIrsPaper, date: d.misc.irsPaper },
    { label: td.miscIrsElectronic, date: d.misc.irsElectronic },
    { label: td.form945, date: d.form945 },
  ];

  return (
    <Alert variant={overdue ? 'destructive' : 'default'} data-testid="deadlines-banner">
      <CalendarClock aria-hidden />
      <AlertTitle>
        {td.headline.replace('{date}', formatDate(d.nec.irs))}
        {countdown ? <span className={cn('ml-2 font-normal', overdue ? '' : 'text-muted-foreground')}>({countdown})</span> : null}
      </AlertTitle>
      <AlertDescription>
        <p>{td.efileRule.replace('{n}', String(d.eFile.requiredFrom))}</p>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto gap-1 px-0"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? td.hideDates : td.showDates}
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
        </Button>
        {open ? (
          <div className="mt-1 space-y-2">
            <ul className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              {rows.map((row) => (
                <li key={row.label} className="flex justify-between gap-3">
                  <span>{row.label}</span>
                  <span className="shrink-0 tabular-nums">{formatDate(row.date)}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs">
              {td.waiver
                .replace('{days}', String(d.eFile.waiverRequestDays))
                .replace('{nec}', formatDate(d.eFile.necWaiverDeadline))
                .replace('{misc}', formatDate(d.eFile.miscWaiverDeadline))}
            </p>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
