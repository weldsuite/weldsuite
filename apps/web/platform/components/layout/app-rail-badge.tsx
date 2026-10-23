import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { BetaBadge } from '@/components/layout/beta-badge';

/** Width of the pill, so one, two and three characters ("99+") stay centred. */
export function railBadgeSizeClass(count: number): string {
  if (count > 99) return 'min-w-[32px] px-[5px] indent-[1.5px]';
  if (count >= 10) return 'min-w-[26px] px-[4px] indent-[1.5px]';
  return 'w-[22px] indent-[0.5px]';
}

export function formatRailBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * Red unread-count pill pinned to the top-right of an app rail icon (the
 * parent must be `relative`). Renders nothing when there is nothing unread.
 */
export function AppRailBadge({ count, className }: Readonly<{ count?: number; className?: string }>) {
  const { t } = useI18n();
  if (!count || count <= 0) return null;
  return (
    <span
      data-testid="app-rail-badge"
      className={cn(
        'absolute -top-[4px] -right-[3px] z-10 text-[12px] font-mono font-medium leading-none text-white bg-red-500 border border-red-600 h-[22px] flex items-center justify-center rounded-[8px] pointer-events-none',
        railBadgeSizeClass(count),
        className
      )}
    >
      <span aria-hidden="true">{formatRailBadgeCount(count)}</span>
      <span className="sr-only">{t.navigation.unreadBadge.replace('{count}', String(count))}</span>
    </span>
  );
}

/**
 * Top-right corner of a rail icon: the unread badge and the BETA pill share
 * that spot, so the unread count wins while there is one.
 */
export function RailIconCorner({ badgeCount, showBeta }: Readonly<{ badgeCount?: number; showBeta?: boolean }>) {
  if (badgeCount && badgeCount > 0) return <AppRailBadge count={badgeCount} />;
  return showBeta ? <BetaBadge /> : null;
}
