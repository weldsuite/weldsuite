import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { BetaBadge } from '@/components/layout/beta-badge';

/** Width of the pill: a circle for one digit, wider for two and for "99+". */
export function railBadgeSizeClass(count: number): string {
  if (count > 99) return 'min-w-[30px] px-[4px]';
  if (count >= 10) return 'min-w-[24px] px-[4px]';
  return 'w-[18px]';
}

export function formatRailBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * Red unread-count pill pinned to the top-right of an app rail icon (the
 * parent must be `relative`). Renders nothing when there is nothing unread.
 * Its 2px ring is the rail's own colour (the shell chrome on desktop, the
 * sheet background on mobile), so it reads as cut out of the icon.
 */
export function AppRailBadge({ count, className }: Readonly<{ count?: number; className?: string }>) {
  const { t } = useI18n();
  if (!count || count <= 0) return null;
  return (
    <span
      data-testid="app-rail-badge"
      className={cn(
        'absolute -top-[3px] -right-[3px] z-10 text-[11px] font-semibold tabular-nums leading-none text-white bg-red-500 h-[18px] flex items-center justify-center rounded-full ring-2 ring-[var(--shell-chrome,var(--background))] pointer-events-none',
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
