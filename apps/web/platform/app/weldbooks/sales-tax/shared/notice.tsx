import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success';

const TONE_CLASS: Record<NoticeTone, string> = {
  info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100',
  warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  success:
    'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
};

const TONE_ICON: Record<NoticeTone, LucideIcon> = {
  info: Info,
  warning: AlertTriangle,
  danger: AlertTriangle,
  success: CheckCircle2,
};

interface NoticeProps {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  /** Buttons or links at the end of the notice. */
  action?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

/** A short message in a colored box: a warning to read, a result, a hint. */
export function Notice({ tone = 'info', title, children, action, className, 'data-testid': testId }: Readonly<NoticeProps>) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      data-testid={testId}
      className={cn('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', TONE_CLASS[tone], className)}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="space-y-1">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
