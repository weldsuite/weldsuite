import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { SETUP_STEPS, type SetupStep } from './steps';

/** The wizard's progress: numbered steps on wide screens, "Step 2 of 5" on phones. */
export function Stepper({
  current,
  completed,
  onSelect,
}: Readonly<{ current: SetupStep; completed: ReadonlySet<SetupStep>; onSelect: (step: SetupStep) => void }>) {
  const t = useTranslations();
  const index = SETUP_STEPS.indexOf(current);

  return (
    <nav aria-label={t('reach.setup.title')}>
      <p className="text-sm font-medium sm:hidden">
        {t('reach.setup.stepOf', { current: index + 1, total: SETUP_STEPS.length })}: {t(`reach.setup.steps.${current}`)}
      </p>
      <ol className="hidden items-center gap-2 sm:flex">
        {SETUP_STEPS.map((step, position) => {
          const isCurrent = step === current;
          const isDone = completed.has(step) && !isCurrent;
          return (
            <li key={step} className="flex items-center gap-2">
              {position > 0 && <span className="h-px w-6 bg-border lg:w-10" aria-hidden />}
              <button
                type="button"
                onClick={() => onSelect(step)}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-accent',
                  isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                    isCurrent && 'border-primary bg-primary text-primary-foreground',
                    isDone && 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                  )}
                >
                  {isDone ? <Check className="h-3.5 w-3.5" aria-hidden /> : position + 1}
                </span>
                {t(`reach.setup.steps.${step}`)}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Title, intro and content of one step. */
export function StepFrame({
  title,
  description,
  children,
}: Readonly<{ title: ReactNode; description?: ReactNode; children: ReactNode }>) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** Back, Skip and Continue under every step. */
export function StepFooter({
  onBack,
  onNext,
  onSkip,
  nextDisabled,
  nextLabel,
  nextBusy,
}: Readonly<{
  onBack?: () => void;
  onNext?: () => void;
  onSkip?: () => void;
  nextDisabled?: boolean;
  nextLabel?: string;
  nextBusy?: boolean;
}>) {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <div>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack}>
            {t('reach.setup.back')}
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {onSkip && (
          <Button type="button" variant="ghost" onClick={onSkip}>
            {t('reach.setup.skip')}
          </Button>
        )}
        {onNext && (
          <Button type="button" disabled={nextDisabled || nextBusy} onClick={onNext}>
            {nextLabel ?? t('reach.setup.next')}
          </Button>
        )}
      </div>
    </div>
  );
}
