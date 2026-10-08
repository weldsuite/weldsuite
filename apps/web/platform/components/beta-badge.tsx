import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';

/**
 * Inline "Beta" marker shown next to an app name (module sidebar header,
 * app store listing and detail page). Subtle on purpose: a small outlined pill.
 */
export function BetaBadge({ className }: Readonly<{ className?: string }>) {
  const st = useTranslations();
  return (
    <span
      data-testid="beta-badge"
      className={cn(
        'inline-flex shrink-0 items-center rounded border border-border bg-muted px-1.5 py-px font-mono text-[10px] font-medium leading-4 tracking-wide text-muted-foreground',
        className
      )}
    >
      {st('sweep.shared.beta')}
    </span>
  );
}

/**
 * Corner "Beta" marker for app rail buttons. The parent button must be
 * `relative` and `overflow-visible`.
 */
export function RailBetaBadge() {
  const st = useTranslations();
  return (
    <span
      data-testid="rail-beta-badge"
      className="pointer-events-none absolute -top-1 -right-1 z-10 flex h-[16px] items-center justify-center rounded-[5px] border border-black bg-black px-1 font-mono text-[10px] text-white"
    >
      <span className="-translate-y-[0.5px]">{st('sweep.shared.beta')}</span>
    </span>
  );
}
