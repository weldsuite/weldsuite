import { useId, type ReactNode } from 'react';
import { AlertCircle, Check, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { cn } from '@/lib/utils';

interface StepCardProps {
  /** The number shown in the circle. */
  step: number;
  title: string;
  description: string;
  /** Replaces the number with a check mark. */
  done?: boolean;
  /** A status badge at the end of the header. */
  badge?: ReactNode;
  children: ReactNode;
}

/** One numbered step of the setup: a header with the step's state, and its body. */
export function StepCard({ step, title, description, done = false, badge, children }: Readonly<StepCardProps>) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="rounded-xl border">
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <div
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
            done ? 'border-emerald-600 bg-emerald-600 text-white' : 'text-muted-foreground',
          )}
        >
          {done ? <Check className="h-3.5 w-3.5" /> : step}
        </div>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
        {badge}
      </div>
      <div className="space-y-4 border-t p-4 sm:p-5">{children}</div>
    </section>
  );
}

/** A failed action, shown where it happened until the next attempt. */
export function InlineError({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** Something the person should know before going on: neutral, or a warning. */
export function Notice({ tone = 'info', children }: Readonly<{ tone?: 'info' | 'warning'; children: ReactNode }>) {
  return (
    <Alert
      className={cn(
        tone === 'warning' &&
          'border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200',
      )}
    >
      <Info />
      <AlertDescription className={cn(tone === 'warning' && 'text-amber-800 dark:text-amber-300')}>{children}</AlertDescription>
    </Alert>
  );
}
