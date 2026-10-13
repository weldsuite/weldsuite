import { Mail } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';

/**
 * "Used by WeldReach": shown next to a domain that is connected to WeldReach
 * (cold email). The tooltip says what that blocks.
 */
export function UsedByWeldReachBadge({ className }: Readonly<{ className?: string }>) {
  const { t } = useI18n();
  const tw = t.host.weldReach;

  return (
    <span
      data-testid="used-by-weldreach-badge"
      title={tw.usedByHint}
      className={cn(
        'inline-flex h-[22px] flex-shrink-0 items-center gap-1 rounded px-2 text-[12px] font-medium leading-none',
        'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
        className,
      )}
    >
      <Mail className="h-3 w-3" aria-hidden="true" />
      {tw.usedByBadge}
    </span>
  );
}
