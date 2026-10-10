/** Draft → Calculated → Approved → Paid, with the current step highlighted. A cancelled run shows no steps. */

import { Check } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayRunStatus } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { cn } from '@/lib/utils';

const STEPS = ['draft', 'calculated', 'approved', 'paid'] as const;

export function RunStepper({ status }: Readonly<{ status: HrPayRunStatus }>) {
  const t = useTranslations();
  if (status === 'cancelled') return null;
  const current = STEPS.indexOf(status);

  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2" aria-label={t('weldhr.payroll.run.progress')}>
      {STEPS.map((step, index) => {
        const done = index < current || status === 'paid';
        const active = index === current && status !== 'paid';
        return (
          <li key={step} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium',
                done && 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500',
                active && 'border-primary bg-primary text-primary-foreground',
                !done && !active && 'text-muted-foreground',
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span className={cn('text-sm', active ? 'font-medium' : 'text-muted-foreground')}>{t(`weldhr.payroll.runStatus.${step}`)}</span>
            {index < STEPS.length - 1 && <span className="mx-1 hidden h-px w-6 bg-border sm:block" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
