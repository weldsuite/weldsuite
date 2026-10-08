import { Check } from 'lucide-react';
import type { Form1099FilingStatus } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { FILING_STEPS, filingStepIndex } from '../../../form-1099-model';

/** draft → reviewed → generated → filed: where the filing stands. A corrected filing is past all four. */
export function FilingStepper({ status }: Readonly<{ status: Form1099FilingStatus }>) {
  const { t } = useI18n();
  const current = filingStepIndex(status);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-label={t.weldbooksUs.form1099.filing.stepsLabel}>
      {FILING_STEPS.map((step, index) => {
        const done = index < current || (index === current && step === 'filed');
        const active = index === current && !done;
        return (
          <li key={step} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-medium',
                done && 'border-emerald-600 bg-emerald-600 text-white',
                active && 'border-primary bg-primary text-primary-foreground',
                !done && !active && 'text-muted-foreground',
              )}
              aria-hidden
            >
              {done ? <Check className="h-3 w-3" /> : index + 1}
            </span>
            <span className={cn(active ? 'font-medium' : 'text-muted-foreground')}>{t.weldbooksUs.form1099.filingStatus[step]}</span>
            {index < FILING_STEPS.length - 1 ? <span className="mx-1 h-px w-6 bg-border" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}
