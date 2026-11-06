import { CountBadge } from '@weldsuite/ui/components/count-badge';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { BetaBadge } from '@/components/layout/beta-badge';

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
    <CountBadge
      data-testid="app-rail-badge"
      count={count}
      label={t.navigation.unreadBadge.replace('{count}', String(count))}
      className={cn(
        'absolute -top-[3px] -right-[3px] z-10 pointer-events-none ring-2 ring-[var(--shell-chrome,var(--background))]',
        className
      )}
    />
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
