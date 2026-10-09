import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { RETURN_STEPS, stepStates } from '../return-model';

interface ReturnStepperProps {
  status: string;
  /** The pre-file check ran and found nothing. */
  preFileOk?: boolean;
}

/** Calculate, review, pre-file check, file and pay: where the return is in the flow. */
export function ReturnStepper({ status, preFileOk }: Readonly<ReturnStepperProps>) {
  const { t } = useI18n();
  const ts = t.weldbooksUs.salesTax.center.returnPage.steps;
  const states = stepStates(status, preFileOk);

  return (
    <ol aria-label={ts.title} className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {RETURN_STEPS.map((step, index) => {
        const state = states[step];
        return (
          <li
            key={step}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            className="flex items-center gap-2"
          >
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                state === 'done' && 'border-primary bg-primary text-primary-foreground',
                state === 'current' && 'border-primary text-primary ring-2 ring-primary/30',
                state === 'todo' && 'border-border text-muted-foreground',
              )}
              aria-hidden="true"
            >
              {state === 'done' ? <Check className="h-4 w-4" /> : index + 1}
            </span>
            <span
              className={cn(
                'text-sm',
                state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground',
                state === 'done' && 'text-foreground',
              )}
            >
              {ts[step]}
              <span className="sr-only"> ({ts[state]})</span>
            </span>
            {index < RETURN_STEPS.length - 1 ? (
              <span className="mx-1 hidden h-px w-6 bg-border sm:inline-block" aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
