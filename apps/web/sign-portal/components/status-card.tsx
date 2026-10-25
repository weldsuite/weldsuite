import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

interface StatusCardProps {
  icon: LucideIcon;
  /** Tailwind colour classes for the icon bubble. */
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  /** Spin the icon, for a loading state. */
  spin?: boolean;
  title: string;
  body?: string;
  children?: ReactNode;
}

const TONES = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-emerald-100 text-emerald-700',
  warning: 'bg-amber-100 text-amber-700',
  danger: 'bg-red-100 text-red-700',
} as const;

/** Centred card for the portal's single-message states. */
export function StatusCard({ icon: Icon, tone = 'neutral', spin, title, body, children }: Readonly<StatusCardProps>) {
  return (
    <main className="flex flex-1 items-center justify-center p-4 sm:p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border bg-card p-6 text-center shadow-sm sm:p-8">
        <span className={cn('flex size-12 items-center justify-center rounded-full', TONES[tone])}>
          <Icon className={cn('size-6', spin && 'animate-spin')} aria-hidden="true" />
        </span>
        <h1 className="text-lg font-semibold">{title}</h1>
        {body ? <p className="text-sm text-muted-foreground">{body}</p> : null}
        {children ? <div className="mt-2 flex w-full flex-col gap-3">{children}</div> : null}
      </div>
    </main>
  );
}
